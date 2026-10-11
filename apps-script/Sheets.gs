/**
 * Sheets.gs
 * ---------------------------------------------------------------------------
 * Google Sheets persistence layer.
 *
 * The workbook is named "UPI Payment History Dashboard" and always contains:
 *   - All Transactions   (the ledger — single source of truth)
 *   - Daily History      (auto-calculated daily summaries)
 *   - Overall History    (lifetime / monthly / yearly / per-UPI statistics)
 *   - Dashboard Data     (chart-ready summary tables)
 *   - Audit Log          (imports, edits, reversals — append only)
 *
 * Daily History, Overall History and Dashboard Data are *derived*: they are
 * fully rebuilt from the ledger after every import so they can never drift out
 * of sync with the underlying transactions.
 * ---------------------------------------------------------------------------
 */

var SHEETS = {
  ALL: 'All Transactions',
  DAILY: 'Daily History',
  OVERALL: 'Overall History',
  DASH: 'Dashboard Data',
  AUDIT: 'Audit Log'
};

var HEADERS = {
  ALL: [
    'Transaction ID',
    'Transaction Date',
    'Transaction Time',
    'UPI ID',
    'Transaction Type',
    'Payer or Payee Name',
    'Payer or Payee UPI ID',
    'Amount (₹)',
    'Payment Status',
    'Payment Category',
    'Payment Reference / UTR',
    'Payment Method',
    'Transaction Source',
    'Notes',
    'Last Updated'
  ],
  DAILY: [
    'Date',
    'Total Money Received (₹)',
    'Total Money Sent (₹)',
    'Successful Incoming Payments',
    'Successful Outgoing Payments',
    'Total Refunds (₹)',
    'Net Payment Flow (₹)',
    'Total Transaction Count'
  ],
  AUDIT: ['Timestamp (IST)', 'User', 'Action', 'Details']
};

/* ---------------------------------------------------------------------- */
/* Spreadsheet access                                                     */
/* ---------------------------------------------------------------------- */

function getSpreadsheet() {
  var id = getSpreadsheetId();
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      // Id is stale or access was revoked — rediscover/create below.
      props().deleteProperty(PROP_SPREADSHEET_ID);
    }
  }

  // Prefer the spreadsheet the script is bound to (container-bound projects).
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  if (active) {
    setSpreadsheetId(active.getId());
    return active;
  }

  // Otherwise reuse an existing workbook with the expected name, if any.
  try {
    var files = DriveApp.getFilesByName(DEFAULT_CONFIG.appName);
    while (files.hasNext()) {
      var file = files.next();
      if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
        setSpreadsheetId(file.getId());
        return SpreadsheetApp.openById(file.getId());
      }
    }
  } catch (e) {
    // Drive lookup not permitted — fall through and create a new workbook.
  }

  var ss = SpreadsheetApp.create(DEFAULT_CONFIG.appName);
  setSpreadsheetId(ss.getId());
  return ss;
}

function getSheet(name) {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

/**
 * Idempotent setup: creates the spreadsheet (if needed), all worksheets,
 * header rows and formatting. Safe to run repeatedly.
 */
function ensureDashboard() {
  var ss = getSpreadsheet();

  // Reuse the default empty "Sheet1" as the ledger tab.
  var sheets = ss.getSheets();
  if (sheets.length >= 1) {
    var first = sheets[0];
    if (first.getName() === 'Sheet1' && first.getLastRow() === 0) {
      first.setName(SHEETS.ALL);
    }
  }

  [SHEETS.ALL, SHEETS.DAILY, SHEETS.OVERALL, SHEETS.DASH, SHEETS.AUDIT].forEach(function (name) {
    getSheet(name);
  });

  writeHeaderRow(SHEETS.ALL, HEADERS.ALL);
  writeHeaderRow(SHEETS.DAILY, HEADERS.DAILY);
  writeHeaderRow(SHEETS.AUDIT, HEADERS.AUDIT);

  var ledger = getSheet(SHEETS.ALL);
  ledger.setFrozenRows(1);
  ledger.getRange(2, 8, Math.max(ledger.getMaxRows() - 1, 1), 1).setNumberFormat('#,##0.00');

  auditLog('setup', 'Dashboard worksheets initialised');
  return { ok: true, spreadsheetId: ss.getId(), url: ss.getUrl() };
}

function writeHeaderRow(sheetName, headers) {
  var sh = getSheet(sheetName);
  var existing = sh.getLastRow() > 0 ? sh.getRange(1, 1, 1, headers.length).getValues()[0] : [];
  var same = existing.length === headers.length && headers.every(function (h, i) {
    return String(existing[i] || '') === h;
  });
  if (!same) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#1e3a8a')
    .setFontColor('#ffffff')
    .setVerticalAlignment('middle');
  sh.setFrozenRows(1);
}

/* ---------------------------------------------------------------------- */
/* Ledger read / write                                                    */
/* ---------------------------------------------------------------------- */

function txnToRow(t) {
  return [
    t.transactionId || '',
    t.date || '',
    t.time || '',
    t.upiId || '',
    t.type || '',
    t.counterparty || '',
    t.counterpartyUpi || '',
    Core.round2(t.amount || 0),
    t.status || 'Unknown',
    t.category || 'Other',
    t.utr || '',
    t.method || '',
    t.source || '',
    t.notes || '',
    t.lastUpdated || ''
  ];
}

function rowToTxn(row, sheetRow) {
  var t = {
    transactionId: String(row[0] || ''),
    date: String(row[1] || ''),
    time: String(row[2] || ''),
    upiId: String(row[3] || ''),
    type: String(row[4] || ''),
    counterparty: String(row[5] || ''),
    counterpartyUpi: String(row[6] || ''),
    amount: Core.parseAmount(row[7]) ? Core.parseAmount(row[7]).amount : (parseFloat(row[7]) || 0),
    status: String(row[8] || ''),
    category: String(row[9] || ''),
    utr: String(row[10] || ''),
    method: String(row[11] || ''),
    source: String(row[12] || ''),
    notes: String(row[13] || ''),
    lastUpdated: String(row[14] || '')
  };
  t._row = sheetRow;
  t._key = Core.transactionKey(t);
  return t;
}

/** Read the entire ledger (every status, including failed and reversed). */
function readLedger() {
  var sh = getSheet(SHEETS.ALL);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, HEADERS.ALL.length).getValues();
  var out = [];
  values.forEach(function (r, i) {
    if (String(r[0] || '').trim() === '' && String(r[1] || '').trim() === '' &&
      String(r[7] || '').trim() === '') {
      return; // fully blank row
    }
    out.push(rowToTxn(r, i + 2));
  });
  return out;
}

function appendTransactions(txns) {
  if (!txns || !txns.length) return;
  var sh = getSheet(SHEETS.ALL);
  var startRow = sh.getLastRow() + 1;
  var values = txns.map(txnToRow);
  sh.getRange(startRow, 1, values.length, HEADERS.ALL.length).setValues(values);
  sh.getRange(startRow, 8, values.length, 1).setNumberFormat('#,##0.00');
}

/** Apply status/amount/category corrections to existing rows (in place). */
function applyUpdates(updates) {
  if (!updates || !updates.length) return;
  var sh = getSheet(SHEETS.ALL);
  updates.forEach(function (u) {
    var merged = Object.assign({}, u.existing, u.txn);
    merged.lastUpdated = nowIst();
    if (merged.status === 'Reversed' && u.txn.status !== 'Reversed') {
      merged.lastUpdated = nowIst();
    }
    sh.getRange(u.existing._row, 1, 1, HEADERS.ALL.length).setValues([txnToRow(merged)]);
    auditLog('update', 'Row ' + u.existing._row + ' (' + u.key + '): status "' +
      u.existing.status + '" -> "' + u.txn.status + '", amount ' +
      u.existing.amount + ' -> ' + u.txn.amount);
  });
}

/* ---------------------------------------------------------------------- */
/* Derived sheets                                                         */
/* ---------------------------------------------------------------------- */

function clearDerived(sheetName, headerRows) {
  var sh = getSheet(sheetName);
  var last = sh.getLastRow();
  if (last > headerRows) {
    sh.deleteRows(headerRows + 1, last - headerRows);
  }
}

function writeDailySheet(txns) {
  clearDerived(SHEETS.DAILY, 1);
  var daily = Core.summarizeByDay(txns);
  if (!daily.length) return;
  var rows = daily.map(function (d) {
    return [d.date, d.received, d.sent, d.incomingCount, d.outgoingCount, d.refunds, d.net, d.totalCount];
  });
  var sh = getSheet(SHEETS.DAILY);
  sh.getRange(2, 1, rows.length, HEADERS.DAILY.length).setValues(rows);
  sh.getRange(2, 2, rows.length, 6).setNumberFormat('#,##0.00');
}

function writeOverallSheet(txns, cfg) {
  clearDerived(SHEETS.OVERALL, 0);
  var stats = Core.computeOverallStats(txns, cfg.upiIds);
  var rows = [];

  rows.push(['Overall History — Lifetime, Monthly & Yearly Statistics']);
  rows.push([]);
  rows.push(['Lifetime Totals', '', '', '', '', '']);
  rows.push(['Total Successful Money Received (₹)', stats.received, '', '', '', '']);
  rows.push(['Total Successful Money Sent (₹)', stats.sent, '', '', '', '']);
  rows.push(['Total Incoming Transactions', stats.incomingCount, '', '', '', '']);
  rows.push(['Total Outgoing Transactions', stats.outgoingCount, '', '', '', '']);
  rows.push(['Total Refunds & Reversals (₹)', stats.refunds, '', '', '', '']);
  rows.push(['Net Payment Flow (₹)', stats.net, '', '', '', '']);
  rows.push(['Average Incoming Payment (₹)', stats.avgIncoming, '', '', '', '']);
  rows.push(['Average Outgoing Payment (₹)', stats.avgOutgoing, '', '', '', '']);
  rows.push(['Highest Incoming Payment (₹)', stats.maxIncoming, '', '', '', '']);
  rows.push(['Highest Outgoing Payment (₹)', stats.maxOutgoing, '', '', '', '']);
  rows.push(['Total Transactions (All Statuses)', stats.totalCount, '', '', '', '']);
  rows.push(['Successful Transactions', stats.successfulCount, '', '', '', '']);
  rows.push([]);
  rows.push(['Registered UPI IDs', 'Enabled', 'Incoming Count', 'Incoming Total (₹)', 'Outgoing Count', 'Outgoing Total (₹)']);
  stats.byUpi.forEach(function (u) {
    rows.push([u.id, u.enabled ? 'Yes' : 'No', u.incomingCount, u.incomingTotal, u.outgoingCount, u.outgoingTotal]);
  });
  rows.push([]);
  rows.push(['Monthly Totals', 'Received (₹)', 'Sent (₹)', 'Net Flow (₹)', 'Transactions', '']);
  stats.monthly.forEach(function (m) {
    rows.push([m.month, m.received, m.sent, m.net, m.count, '']);
  });
  rows.push([]);
  rows.push(['Yearly Totals', 'Received (₹)', 'Sent (₹)', 'Net Flow (₹)', 'Transactions', '']);
  stats.yearly.forEach(function (y) {
    rows.push([y.year, y.received, y.sent, y.net, y.count, '']);
  });

  // Pad every row to 6 columns so setValues receives a rectangle.
  rows = rows.map(function (r) {
    var copy = r.slice();
    while (copy.length < 6) copy.push('');
    return copy;
  });

  var sh = getSheet(SHEETS.OVERALL);
  sh.getRange(1, 1, rows.length, 6).setValues(rows);

  // Bold the section headers / title.
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(12);
  rows.forEach(function (r, i) {
    var isSection = r[0] && (r[1] === '' || typeof r[1] === 'string' && (r[1] === 'Enabled'));
    var isHeaderRow = i === 0 || r[0] === 'Registered UPI IDs' || r[0] === 'Monthly Totals' ||
      r[0] === 'Yearly Totals' || r[0] === 'Lifetime Totals';
    if (isHeaderRow) {
      sh.getRange(i + 1, 1, 1, 6).setFontWeight('bold').setBackground('#eef2ff');
    }
  });
  if (rows.length >= 1) {
    sh.getRange(1, 1, 1, 6).setBackground('#1e3a8a').setFontColor('#ffffff');
  }
  sh.setColumnWidth(1, 320);
  sh.setColumnWidth(2, 150);
  sh.setColumnWidth(3, 150);
  sh.setColumnWidth(4, 150);
  sh.setColumnWidth(5, 150);
  sh.setColumnWidth(6, 150);
}

function writeDashboardDataSheet(txns, cfg) {
  clearDerived(SHEETS.DASH, 0);
  var stats = Core.computeOverallStats(txns, cfg.upiIds);
  var daily = Core.summarizeByDay(txns);

  var rows = [];
  rows.push(['Dashboard Data — chart-ready summary tables']);
  rows.push([]);

  rows.push(['Table: Daily Series', 'Received (₹)', 'Sent (₹)', 'Net Flow (₹)', '']);
  daily.forEach(function (d) { rows.push([d.date, d.received, d.sent, d.net, '']); });
  rows.push([]);

  rows.push(['Table: Category Breakdown (money sent)', 'Amount (₹)', 'Transactions', 'Share of Spend (%)', '']);
  var catTotals = {};
  var catCounts = {};
  txns.forEach(function (t) {
    if (t.status !== 'Successful' || t.type !== 'Money Sent') return;
    catTotals[t.category] = (catTotals[t.category] || 0) + t.amount;
    catCounts[t.category] = (catCounts[t.category] || 0) + 1;
  });
  var spendTotal = Object.keys(catTotals).reduce(function (a, k) { return a + catTotals[k]; }, 0);
  Object.keys(catTotals).sort().forEach(function (k) {
    rows.push([k, Core.round2(catTotals[k]), catCounts[k],
      spendTotal ? Core.round2(catTotals[k] / spendTotal * 100) : 0, '']);
  });
  rows.push([]);

  rows.push(['Table: Incoming by UPI ID', 'Amount (₹)', 'Transactions', 'Share (%)', '']);
  var incTotal = stats.received;
  stats.byUpi.forEach(function (u) {
    if (!u.incomingCount) return;
    rows.push([u.id, u.incomingTotal, u.incomingCount,
      incTotal ? Core.round2(u.incomingTotal / incTotal * 100) : 0, '']);
  });
  rows.push([]);

  rows.push(['Table: Outgoing by UPI ID', 'Amount (₹)', 'Transactions', 'Share (%)', '']);
  var outTotal = stats.sent;
  stats.byUpi.forEach(function (u) {
    if (!u.outgoingCount) return;
    rows.push([u.id, u.outgoingTotal, u.outgoingCount,
      outTotal ? Core.round2(u.outgoingTotal / outTotal * 100) : 0, '']);
  });
  rows.push([]);

  rows.push(['Table: Transaction Status', 'Count', 'Share (%)', '', '']);
  var statusCounts = {};
  txns.forEach(function (t) { statusCounts[t.status] = (statusCounts[t.status] || 0) + 1; });
  Object.keys(statusCounts).sort().forEach(function (k) {
    rows.push([k, statusCounts[k],
      txns.length ? Core.round2(statusCounts[k] / txns.length * 100) : 0, '', '']);
  });
  rows.push([]);

  rows.push(['Table: Running Net Flow', 'Cumulative Net (₹)', '', '', '']);
  var cum = 0;
  daily.forEach(function (d) {
    cum += d.net;
    rows.push([d.date, Core.round2(cum), '', '', '']);
  });

  var width = 5;
  rows = rows.map(function (r) {
    var copy = r.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });

  var sh = getSheet(SHEETS.DASH);
  sh.getRange(1, 1, rows.length, width).setValues(rows);

  rows.forEach(function (r, i) {
    if (typeof r[0] === 'string' && r[0].indexOf('Table:') === 0) {
      sh.getRange(i + 1, 1, 1, width).setFontWeight('bold').setBackground('#eef2ff');
    }
  });
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
  sh.setColumnWidth(1, 340);
}

/** Rebuild every derived sheet from the ledger. Called after any change. */
function refreshDerivedSheets() {
  var cfg = getConfig();
  var txns = readLedger();
  writeDailySheet(txns);
  writeOverallSheet(txns, cfg);
  writeDashboardDataSheet(txns, cfg);
}

/* ---------------------------------------------------------------------- */
/* Audit log                                                              */
/* ---------------------------------------------------------------------- */

function auditLog(action, details) {
  try {
    var sh = getSheet(SHEETS.AUDIT);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS.AUDIT.length).setValues([HEADERS.AUDIT]);
      sh.getRange(1, 1, 1, HEADERS.AUDIT.length)
        .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
    var user = '';
    try { user = Session.getActiveUser().getEmail() || ''; } catch (e) { user = ''; }
    sh.appendRow([nowIst(), user, action, String(details || '').slice(0, 500)]);
  } catch (e) {
    Logger.log('auditLog failed (non-fatal): ' + e);
  }
}

function readAuditLog(limit) {
  var sh = getSheet(SHEETS.AUDIT);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var count = Math.min(limit || 100, last - 1);
  var start = last - count + 1;
  var values = sh.getRange(start, 1, count, HEADERS.AUDIT.length).getValues();
  var rows = values.map(function (r) {
    return { timestamp: String(r[0] || ''), user: String(r[1] || ''), action: String(r[2] || ''), details: String(r[3] || '') };
  });
  rows.reverse(); // newest first
  return rows;
}

/** Erase all transaction data (used by the "Reset dashboard" action). */
function wipeLedger() {
  var sh = getSheet(SHEETS.ALL);
  var last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  auditLog('reset', 'Ledger cleared by user');
  refreshDerivedSheets();
}
