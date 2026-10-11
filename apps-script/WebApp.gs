/**
 * WebApp.gs
 * ---------------------------------------------------------------------------
 * Everything the browser can call via google.script.run.
 * Each function returns a plain serialisable object. Every mutation is
 * audited. No credentials (PIN/OTP/password) are ever accepted or stored.
 * ---------------------------------------------------------------------------
 */

/* ---------------------------------------------------------------------- */
/* Page                                                                   */
/* ---------------------------------------------------------------------- */

function doGet() {
  ensureDashboard();
  return HtmlService.createTemplateFromFile('Dashboard')
    .evaluate()
    .setTitle('UPI Payment History Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ---------------------------------------------------------------------- */
/* Dashboard + charts                                                     */
/* ---------------------------------------------------------------------- */

function getDashboardData(rangeKey) {
  var cfg = getConfig();
  var today = todayIst();
  var all = readLedger();
  var scoped = Core.filterByRange(all, rangeKey || 'last30', today);
  var stats = Core.computeOverallStats(scoped, cfg.upiIds);
  var daily = Core.summarizeByDay(scoped);

  return {
    ok: true,
    today: today,
    range: rangeKey || 'last30',
    summary: {
      received: stats.received,
      sent: stats.sent,
      net: stats.net,
      refunds: stats.refunds,
      successfulCount: stats.successfulCount,
      totalCount: stats.totalCount,
      incomingCount: stats.incomingCount,
      outgoingCount: stats.outgoingCount
    },
    byUpi: stats.byUpi,
    receivedVsSent: [
      { name: 'Money Received', value: stats.received },
      { name: 'Money Sent', value: stats.sent }
    ],
    byUpiIncoming: groupSuccessful(scoped, 'Money Received'),
    byUpiOutgoing: groupSuccessful(scoped, 'Money Sent'),
    categories: groupCategories(scoped),
    dailyDistribution: daily.map(function (d) {
      return { date: d.date, label: Core.formatDateShort(d.date), received: d.received, sent: d.sent };
    }),
    statusCounts: groupStatuses(scoped),
    runningNet: buildRunningNet(daily),
    dailySeries: daily,
    monthly: stats.monthly,
    yearly: stats.yearly,
    rangeLabel: rangeLabel(rangeKey),
    config: {
      currencySymbol: cfg.currencySymbol,
      upiIds: cfg.upiIds,
      darkMode: cfg.darkMode,
      sync: publicSync(cfg.sync)
    }
  };
}

function groupSuccessful(txns, type) {
  var map = {};
  (txns || []).forEach(function (t) {
    if (t.status !== 'Successful' || t.type !== type) return;
    var k = t.upiId || 'Unmatched';
    var e = map[k] || (map[k] = { name: k, value: 0, count: 0 });
    e.value += t.amount;
    e.count++;
  });
  return Object.keys(map).map(function (k) {
    var e = map[k];
    e.value = Core.round2(e.value);
    return e;
  }).sort(function (a, b) { return b.value - a.value; });
}

function groupCategories(txns) {
  var map = {};
  (txns || []).forEach(function (t) {
    if (t.status !== 'Successful' || t.type !== 'Money Sent') return;
    var k = t.category || 'Other';
    var e = map[k] || (map[k] = { name: k, value: 0, count: 0 });
    e.value += t.amount;
    e.count++;
  });
  return Object.keys(map).map(function (k) {
    var e = map[k];
    e.value = Core.round2(e.value);
    return e;
  }).sort(function (a, b) { return b.value - a.value; });
}

function groupStatuses(txns) {
  var map = {};
  (txns || []).forEach(function (t) {
    map[t.status] = (map[t.status] || 0) + 1;
  });
  return Object.keys(map).map(function (k) { return { name: k, count: map[k] }; })
    .sort(function (a, b) { return b.count - a.count; });
}

function buildRunningNet(daily) {
  var cum = 0;
  return (daily || []).map(function (d) {
    cum += d.net;
    return { date: d.date, label: Core.formatDateShort(d.date), value: Core.round2(cum) };
  });
}

function rangeLabel(key) {
  var labels = {
    today: 'Today', yesterday: 'Yesterday', last7: 'Last 7 days',
    last30: 'Last 30 days', month: 'This month', year: 'This year', all: 'All time'
  };
  return labels[key] || 'Last 30 days';
}

/* ---------------------------------------------------------------------- */
/* Transactions table                                                     */
/* ---------------------------------------------------------------------- */

function listTransactions(query) {
  var cfg = getConfig();
  query = query || {};
  var all = readLedger();

  var search = String(query.search || '').trim().toLowerCase();
  var filtered = all.filter(function (t) {
    if (query.upiId && t.upiId !== query.upiId) return false;
    if (query.type && t.type !== query.type) return false;
    if (query.status && t.status !== query.status) return false;
    if (query.category && t.category !== query.category) return false;
    if (query.dateFrom && t.date < query.dateFrom) return false;
    if (query.dateTo && t.date > query.dateTo) return false;
    if (search) {
      var hay = [t.counterparty, t.counterpartyUpi, t.utr, t.transactionId, t.notes,
        t.source, t.category, t.upiId].join(' ').toLowerCase();
      if (hay.indexOf(search) === -1) return false;
    }
    return true;
  });

  var sortBy = query.sortBy || 'date';
  var dir = query.sortDir === 'asc' ? 1 : -1;
  filtered.sort(function (a, b) {
    var va = a[sortBy];
    var vb = b[sortBy];
    if (sortBy === 'amount') { va = Number(va) || 0; vb = Number(vb) || 0; }
    else { va = String(va === undefined || va === null ? '' : va); vb = String(vb === undefined || vb === null ? '' : vb); }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    // stable tie-break by ledger row
    return a._row - b._row;
  });

  var size = Math.max(5, parseInt(query.pageSize, 10) || cfg.pageSize || 25);
  var total = filtered.length;
  var pages = Math.max(1, Math.ceil(total / size));
  var page = Math.min(Math.max(1, parseInt(query.page, 10) || 1), pages);

  var slice = filtered.slice((page - 1) * size, page * size).map(publicTxn);
  return { ok: true, rows: slice, total: total, page: page, pages: pages, pageSize: size };
}

function publicTxn(t) {
  return {
    key: t._key,
    row: t._row,
    transactionId: t.transactionId,
    date: t.date,
    time: t.time,
    upiId: t.upiId,
    type: t.type,
    counterparty: t.counterparty,
    counterpartyUpi: t.counterpartyUpi,
    amount: t.amount,
    status: t.status,
    category: t.category,
    utr: t.utr,
    method: t.method,
    source: t.source,
    notes: t.notes,
    lastUpdated: t.lastUpdated
  };
}

function getDailyHistory(dateFilter) {
  var txns = readLedger();
  var daily = Core.summarizeByDay(txns);
  if (dateFilter) {
    daily = daily.filter(function (d) { return d.date === dateFilter; });
  }
  return { ok: true, rows: daily.reverse(), today: todayIst() };
}

function getOverallData() {
  var cfg = getConfig();
  var txns = readLedger();
  var stats = Core.computeOverallStats(txns, cfg.upiIds);
  var daily = Core.summarizeByDay(txns);
  var firstDate = daily.length ? daily[0].date : null;
  var lastDate = daily.length ? daily[daily.length - 1].date : null;
  return {
    ok: true,
    stats: stats,
    dailySeries: daily,
    firstDate: firstDate,
    lastDate: lastDate,
    upiIds: cfg.upiIds,
    generatedAt: nowIst()
  };
}

/* ---------------------------------------------------------------------- */
/* Settings + audit                                                       */
/* ---------------------------------------------------------------------- */

function publicSync(sync) {
  sync = sync || {};
  return {
    lastSync: sync.lastSync || null,
    lastStatus: sync.lastStatus || 'not_connected',
    lastMessage: sync.lastMessage || '',
    sourceCount: (sync.sources || []).length,
    sources: (sync.sources || []).map(function (s) {
      // never expose tokens to the browser
      return { name: s.name, url: hostOnly(s.url), method: s.method, enabled: s.enabled !== false };
    })
  };
}

function hostOnly(url) {
  var m = String(url || '').match(/^https?:\/\/([^\/]+)/i);
  return m ? m[1] : '';
}

function getSettings() {
  var cfg = getConfig();
  var ss = getSpreadsheet();
  return {
    ok: true,
    config: {
      appName: cfg.appName,
      timezone: cfg.timezone,
      currencySymbol: cfg.currencySymbol,
      darkMode: cfg.darkMode,
      pageSize: cfg.pageSize,
      upiIds: cfg.upiIds
    },
    sync: publicSync(cfg.sync),
    spreadsheetUrl: ss.getUrl(),
    spreadsheetId: ss.getId()
  };
}

function getAuditLog(limit) {
  return { ok: true, rows: readAuditLog(limit || 100) };
}

/** Save new authorised sync sources (tokens stay server-side). */
function persistSyncSources(sources) {
  return saveSyncSources(sources);
}

function runSyncNow() {
  return scheduledSync();
}

/* ---------------------------------------------------------------------- */
/* Exports                                                                */
/* ---------------------------------------------------------------------- */

var EXPORT_HEADERS = [
  'Transaction ID', 'Transaction Date', 'Transaction Time', 'UPI ID', 'Transaction Type',
  'Payer or Payee Name', 'Payer or Payee UPI ID', 'Amount (INR)', 'Payment Status',
  'Payment Category', 'Payment Reference / UTR', 'Payment Method', 'Transaction Source',
  'Notes', 'Last Updated'
];

function filterForExport(query) {
  query = query || {};
  var all = readLedger();
  var search = String(query.search || '').trim().toLowerCase();
  return all.filter(function (t) {
    if (query.upiId && t.upiId !== query.upiId) return false;
    if (query.type && t.type !== query.type) return false;
    if (query.status && t.status !== query.status) return false;
    if (query.category && t.category !== query.category) return false;
    if (query.dateFrom && t.date < query.dateFrom) return false;
    if (query.dateTo && t.date > query.dateTo) return false;
    if (search) {
      var hay = [t.counterparty, t.utr, t.transactionId, t.notes, t.source, t.category, t.upiId].join(' ').toLowerCase();
      if (hay.indexOf(search) === -1) return false;
    }
    return true;
  }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
}

function exportTransactionsCsv(query) {
  var rows = filterForExport(query);
  var csv = Core.toCsv(EXPORT_HEADERS, rows.map(function (t) {
    return [t.transactionId, t.date, t.time, t.upiId, t.type, t.counterparty, t.counterpartyUpi,
      t.amount, t.status, t.category, t.utr, t.method, t.source, t.notes, t.lastUpdated];
  }));
  return { ok: true, filename: 'upi-transactions-' + todayIst() + '.csv', content: csv, count: rows.length };
}

function exportDailyCsv(rangeKey) {
  var today = todayIst();
  var txns = Core.filterByRange(readLedger(), rangeKey || 'all', today);
  var daily = Core.summarizeByDay(txns).reverse();
  var headers = ['Date', 'Received (INR)', 'Sent (INR)', 'Successful Incoming',
    'Successful Outgoing', 'Refunds (INR)', 'Net Flow (INR)', 'Transaction Count'];
  var csv = Core.toCsv(headers, daily.map(function (d) {
    return [d.date, d.received, d.sent, d.incomingCount, d.outgoingCount, d.refunds, d.net, d.totalCount];
  }));
  return { ok: true, filename: 'upi-daily-report-' + (rangeKey || 'all') + '-' + today + '.csv', content: csv, count: daily.length };
}

function exportMonthlyCsv() {
  var cfg = getConfig();
  var stats = Core.computeOverallStats(readLedger(), cfg.upiIds);
  var headers = ['Month', 'Received (INR)', 'Sent (INR)', 'Net Flow (INR)', 'Transactions'];
  var csv = Core.toCsv(headers, stats.monthly.map(function (m) {
    return [m.month, m.received, m.sent, m.net, m.count];
  }));
  return { ok: true, filename: 'upi-monthly-report-' + todayIst() + '.csv', content: csv, count: stats.monthly.length };
}

function exportReconciliationCsv() {
  var txns = readLedger();
  var issues = Core.findReconciliationIssues(txns);
  var headers = ['Issue Type', 'Date', 'Amount (INR)', 'Counterparty', 'Details'];
  var csv = Core.toCsv(headers, issues.map(function (i) {
    return [i.type, i.date, i.amount, i.counterparty, i.message];
  }));
  return { ok: true, filename: 'upi-reconciliation-' + todayIst() + '.csv', content: csv, count: issues.length };
}

/** Data for the printable report view. */
function getPrintReport(rangeKey) {
  var cfg = getConfig();
  var today = todayIst();
  var all = readLedger();
  var scoped = Core.filterByRange(all, rangeKey || 'last30', today);
  var stats = Core.computeOverallStats(scoped, cfg.upiIds);
  var daily = Core.summarizeByDay(scoped);
  var categories = groupCategories(scoped);
  return {
    ok: true,
    generatedAt: nowIst(),
    rangeLabel: rangeLabel(rangeKey),
    summary: stats,
    daily: daily.reverse(),
    categories: categories,
    upiIds: cfg.upiIds
  };
}

/* ---------------------------------------------------------------------- */
/* Maintenance                                                            */
/* ---------------------------------------------------------------------- */

function resetDashboardData(confirmText) {
  if (String(confirmText || '').toUpperCase() !== 'RESET') {
    throw new Error('Type RESET exactly to confirm.');
  }
  wipeLedger();
  return { ok: true };
}
