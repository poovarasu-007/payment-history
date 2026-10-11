/**
 * Import.gs
 * ---------------------------------------------------------------------------
 * Transaction import, manual entry, reversal and (optional) scheduled sync.
 *
 * SUPPORTED SOURCES (in the order the product spec requests):
 *   1. An authorized bank / payment-provider API or webhook (opt-in, configured
 *      in Settings). This app never scrapes protected banking pages.
 *   2. Imported transaction notifications / statement exports (CSV, TSV, or
 *      pasted spreadsheet data).
 *   3. Manual entry for corrections or unsupported sources.
 *
 * HARD RULES enforced here:
 *   - A transaction is never marked Successful unless the source data says so.
 *   - Duplicate imports (same UTR/reference, or identical date+amount+payee)
 *     never create a second ledger row.
 *   - Existing rows are updated in place when a status changes.
 *   - No PIN, OTP or password is ever requested, read or stored.
 * ---------------------------------------------------------------------------
 */

/* ---------------------------------------------------------------------- */
/* CSV / TSV import                                                       */
/* ---------------------------------------------------------------------- */

function importTransactionsCsv(filename, content, sourceLabel) {
  if (!content || !String(content).trim()) {
    throw new Error('The uploaded file is empty.');
  }
  var cfg = getConfig();
  var rows = Core.parseDelimited(String(content));
  if (rows.length < 2) {
    throw new Error('No data rows found. The file needs a header row plus at least one transaction.');
  }

  var map = Core.detectColumns(rows[0]);
  if (map.error) throw new Error(map.error);

  var source = sourceLabel || ('Statement: ' + (filename || 'uploaded file'));
  var defaults = { source: source };

  var incoming = [];
  var errors = [];
  for (var i = 1; i < rows.length; i++) {
    var normalised = Core.normalizeRow(rows[i], map, cfg.upiIds, defaults);
    if (normalised.error) {
      errors.push({ row: i + 1, error: normalised.error });
      continue;
    }
    incoming.push(normalised);
  }

  if (!incoming.length && errors.length) {
    throw new Error('No valid rows could be read. First error — row ' + errors[0].row + ': ' + errors[0].error);
  }

  return commitTransactions(incoming, errors, source);
}

/* ---------------------------------------------------------------------- */
/* Manual entry                                                           */
/* ---------------------------------------------------------------------- */

function addManualTransaction(fields) {
  var cfg = getConfig();
  var check = Core.validateManualTxn(fields);
  if (!check.ok) throw new Error(check.errors.join('; '));

  var amountInfo = Core.parseAmount(fields.amount);
  var txn = {
    transactionId: String(fields.transactionId || '').trim(),
    date: fields.date,
    time: Core.parseTime(fields.time) || '00:00:00',
    upiId: String(fields.upiId || '').trim(),
    type: fields.type,
    counterparty: String(fields.counterparty || '').trim(),
    counterpartyUpi: String(fields.counterpartyUpi || '').trim(),
    amount: amountInfo.amount,
    status: fields.status || 'Successful',
    category: fields.category || Core.inferCategory(fields.counterparty + ' ' + (fields.notes || '')),
    utr: String(fields.utr || '').trim(),
    method: String(fields.method || '').trim() || 'UPI',
    source: 'Manual Entry',
    notes: String(fields.notes || '').trim(),
    lastUpdated: nowIst()
  };

  var ledger = readLedger();
  var key = Core.transactionKey(txn);
  for (var i = 0; i < ledger.length; i++) {
    if (ledger[i]._key === key) {
      throw new Error('Duplicate: a transaction with the same reference already exists (ledger row ' +
        ledger[i]._row + '). Nothing was added.');
    }
  }

  appendTransactions([txn]);
  auditLog('manual_entry', 'Added ' + txn.type + ' of ₹' + txn.amount + ' (' +
    (txn.counterparty || 'no payee') + ') on ' + txn.date);
  setSyncStatus('success', 'Manual entry added on ' + nowIst());
  refreshDerivedSheets();

  return { ok: true, transaction: txn };
}

/* ---------------------------------------------------------------------- */
/* Reversal / refund handling                                             */
/* ---------------------------------------------------------------------- */

/**
 * Flag an existing transaction as Reversed (e.g. a refund or chargeback).
 * The original record is preserved — only its status and notes change.
 */
function reverseTransaction(key, reason) {
  var ledger = readLedger();
  var sh = getSheet(SHEETS.ALL);
  for (var i = 0; i < ledger.length; i++) {
    var t = ledger[i];
    if (t._key !== key) continue;
    if (t.status === 'Reversed') throw new Error('This transaction is already marked as reversed.');

    var notes = t.notes ? t.notes + ' | ' : '';
    notes += 'Reversed on ' + todayIst() + (reason ? (': ' + reason) : '');
    var updated = Object.assign({}, t, {
      status: 'Reversed',
      notes: notes,
      lastUpdated: nowIst()
    });
    sh.getRange(t._row, 1, 1, HEADERS.ALL.length).setValues([txnToRow(updated)]);
    auditLog('reversal', 'Row ' + t._row + ' (' + key + ') reversed. Reason: ' + (reason || 'not given'));
    refreshDerivedSheets();
    return { ok: true };
  }
  throw new Error('Transaction not found. It may have been changed by another import.');
}

/* ---------------------------------------------------------------------- */
/* Shared commit path                                                     */
/* ---------------------------------------------------------------------- */

function commitTransactions(incoming, errors, source) {
  var ledger = readLedger();
  var rec = Core.reconcileImport(ledger, incoming);
  var now = nowIst();

  rec.created.forEach(function (t) { t.lastUpdated = now; });
  appendTransactions(rec.created);

  var updates = rec.updated.map(function (u) {
    return {
      key: u.key,
      existing: u.existing,
      txn: Object.assign({}, u.txn, { lastUpdated: now })
    };
  });
  applyUpdates(updates);

  var result = {
    ok: true,
    source: source,
    created: rec.created.length,
    updated: rec.updated.length,
    skipped: rec.skipped.length,
    errors: errors || [],
    totalRows: incoming.length,
    syncedAt: now
  };

  auditLog('import', source + ' — created ' + result.created + ', updated ' + result.updated +
    ', skipped ' + result.skipped + ', errors ' + result.errors.length);

  setSyncStatus('success', 'Imported from ' + source + ' on ' + now);
  refreshDerivedSheets();
  return result;
}

/* ---------------------------------------------------------------------- */
/* Sync status + optional scheduled sync                                  */
/* ---------------------------------------------------------------------- */

function setSyncStatus(status, message) {
  var cfg = getConfig();
  cfg.sync = cfg.sync || {};
  cfg.sync.lastStatus = status;
  cfg.sync.lastMessage = message || '';
  if (status === 'success' || status === 'error') {
    cfg.sync.lastSync = nowIst();
  }
  saveConfig(cfg);
}

/**
 * Optional automated sync against user-configured, authorized webhook
 * endpoints. When no source is configured the status is reported honestly as
 * "not connected" — the app never pretends to have live bank access.
 */
function scheduledSync() {
  var cfg = getConfig();
  var sources = (cfg.sync && cfg.sync.sources) || [];
  var enabled = sources.filter(function (s) { return s && s.enabled !== false && s.url; });

  if (!enabled.length) {
    setSyncStatus('not_connected', 'No authorized data source connected. Import a statement or add a transaction manually.');
    return {
      ok: true,
      status: 'not_connected',
      message: 'No authorized data source is connected. UPI IDs cannot read bank history on their own — import a CSV/Excel statement or enter transactions manually.'
    };
  }

  var results = [];
  var anyFailed = false;

  enabled.forEach(function (s) {
    try {
      var headers = {};
      if (s.token) headers.Authorization = 'Bearer ' + s.token;
      var resp = UrlFetchApp.fetch(s.url, {
        method: s.method || 'GET',
        headers: headers,
        muteHttpExceptions: true,
        followRedirects: true
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        var body = resp.getContentText();
        if (body && /\S/.test(body)) {
          var imported = importTransactionsCsv(
            'webhook:' + (s.name || 'source'),
            body,
            'Webhook: ' + (s.name || s.url)
          );
          results.push({ name: s.name || s.url, ok: true, imported: imported.created, updated: imported.updated });
        } else {
          results.push({ name: s.name || s.url, ok: true, imported: 0, updated: 0, note: 'Endpoint returned no data' });
        }
      } else {
        anyFailed = true;
        results.push({ name: s.name || s.url, ok: false, error: 'HTTP ' + code });
      }
    } catch (e) {
      anyFailed = true;
      results.push({ name: s.name || s.url, ok: false, error: String(e.message || e) });
    }
  });

  if (anyFailed) {
    setSyncStatus('error', 'One or more sources failed on ' + nowIst());
  } else {
    setSyncStatus('success', 'Sync completed on ' + nowIst());
  }

  return { ok: !anyFailed, status: anyFailed ? 'error' : 'success', results: results };
}

/* ---------------------------------------------------------------------- */
/* Reconciliation report                                                  */
/* ---------------------------------------------------------------------- */

function reconcileLedger() {
  var txns = readLedger();
  var issues = Core.findReconciliationIssues(txns);
  return {
    ok: true,
    generatedAt: nowIst(),
    transactionCount: txns.length,
    issueCount: issues.length,
    issues: issues
  };
}

/* ---------------------------------------------------------------------- */
/* Settings                                                               */
/* ---------------------------------------------------------------------- */

function updateSettings(partial) {
  partial = partial || {};
  var cfg = getConfig();

  if (Array.isArray(partial.upiIds)) {
    cfg.upiIds = partial.upiIds.map(function (u) {
      return {
        id: String(u.id || '').trim(),
        label: u.label || u.id,
        enabled: u.enabled !== false
      };
    }).filter(function (u) { return u.id; });
  }
  if (typeof partial.darkMode === 'boolean') cfg.darkMode = partial.darkMode;
  if (partial.pageSize) cfg.pageSize = parseInt(partial.pageSize, 10) || 25;

  saveConfig(cfg);
  auditLog('settings', 'Settings updated');
  return { ok: true, config: cfg };
}

/**
 * Save authorized sync sources. Tokens are stored only in Script Properties
 * (server-side) and never returned to the browser.
 */
function saveSyncSources(sources) {
  var cfg = getConfig();
  var clean = (sources || []).map(function (s) {
    return {
      name: String(s.name || 'Source').slice(0, 80),
      type: 'webhook',
      url: String(s.url || '').trim(),
      method: (s.method || 'GET').toUpperCase(),
      token: String(s.token || '').trim(),
      enabled: s.enabled !== false
    };
  }).filter(function (s) { return /^https:\/\//i.test(s.url); });

  cfg.sync = cfg.sync || {};
  cfg.sync.sources = clean;
  if (!clean.length) {
    cfg.sync.lastStatus = 'not_connected';
    cfg.sync.lastMessage = 'No authorized data source connected.';
  }
  saveConfig(cfg);
  auditLog('settings', 'Sync sources updated (' + clean.length + ' configured)');
  return { ok: true, count: clean.length };
}

/** Remove every stored integration + token ("disconnect"). */
function disconnectIntegrations() {
  var cfg = getConfig();
  cfg.sync = {
    lastSync: null,
    lastStatus: 'not_connected',
    lastMessage: 'All integrations disconnected by user.',
    sources: []
  };
  saveConfig(cfg);
  auditLog('settings', 'All integrations disconnected and stored tokens removed');
  return { ok: true };
}

/**
 * Append a single source server-side, preserving the existing (token-bearing)
 * source list. The browser only ever sees masked sources, so it must never be
 * asked to send the full list back.
 */
function addSyncSource(source) {
  var cfg = getConfig();
  cfg.sync = cfg.sync || {};
  var url = String((source && source.url) || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('Source URL must start with https://');

  var list = (cfg.sync.sources || []).slice();
  list.push({
    name: String((source && source.name) || 'Source').slice(0, 80),
    type: 'webhook',
    url: url,
    method: String((source && source.method) || 'GET').toUpperCase(),
    token: String((source && source.token) || '').trim(),
    enabled: !source || source.enabled !== false
  });
  cfg.sync.sources = list;
  saveConfig(cfg);
  auditLog('settings', 'Added sync source: ' + url);
  return { ok: true, count: list.length };
}

/** Remove a source by index (index refers to the stored, token-bearing list). */
function removeSyncSource(index) {
  var cfg = getConfig();
  cfg.sync = cfg.sync || {};
  var list = (cfg.sync.sources || []).slice();
  var i = parseInt(index, 10);
  if (i < 0 || i >= list.length) throw new Error('Source not found');
  var removed = list.splice(i, 1)[0];
  cfg.sync.sources = list;
  if (!list.length) {
    cfg.sync.lastStatus = 'not_connected';
    cfg.sync.lastMessage = 'No authorized data source connected.';
  }
  saveConfig(cfg);
  auditLog('settings', 'Removed sync source: ' + (removed && removed.url ? removed.url : i));
  return { ok: true, count: list.length };
}
