/* tools/preview-mock.js
 * ---------------------------------------------------------------------------
 * Browser-only mock of google.script.run used by the static preview build.
 * It returns the SAME shape of data the real server returns, populated from a
 * clearly-fake demo dataset (the 12 rows in samples/sample-statement.csv).
 *
 * This file is NOT part of the Apps Script app and is never deployed.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var UPI_IDS = [
    { id: '9363610085@ptyes', label: 'UPI ID 1', enabled: true },
    { id: 'poovarasuzyra@okaxis', label: 'UPI ID 2', enabled: true }
  ];

  var DAILY = [
    { date: '2026-10-01', received: 1200, sent: 349, incomingCount: 1, outgoingCount: 1, refunds: 0, net: 851, totalCount: 2 },
    { date: '2026-10-02', received: 0, sent: 649, incomingCount: 0, outgoingCount: 2, refunds: 0, net: -649, totalCount: 2 },
    { date: '2026-10-03', received: 2500, sent: 0, incomingCount: 1, outgoingCount: 0, refunds: 0, net: 2500, totalCount: 2 },
    { date: '2026-10-04', received: 0, sent: 0, incomingCount: 0, outgoingCount: 0, refunds: 0, net: 0, totalCount: 1 },
    { date: '2026-10-05', received: 0, sent: 450, incomingCount: 0, outgoingCount: 2, refunds: 0, net: -450, totalCount: 2 },
    { date: '2026-10-06', received: 600, sent: 0, incomingCount: 1, outgoingCount: 0, refunds: 0, net: 600, totalCount: 1 },
    { date: '2026-10-07', received: 0, sent: 220, incomingCount: 0, outgoingCount: 1, refunds: 300, net: -220, totalCount: 2 }
  ];

  var TXNS = [
    ['2026-10-01', '09:12:00', '9363610085@ptyes', 'Money Received', 'Ravi Kumar', 'ravi.kumar@okhdfc', 1200, 'Successful', 'Other', 'UTR900001'],
    ['2026-10-01', '13:40:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Swiggy', 'swiggy@axisbank', 349, 'Successful', 'Food & Dining', 'UTR900002'],
    ['2026-10-02', '08:05:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Uber Ride', 'uber@paytm', 150, 'Successful', 'Travel', 'UTR900003'],
    ['2026-10-02', '19:22:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Amazon Pay', 'amazon@apl', 499, 'Successful', 'Shopping', 'UTR900004'],
    ['2026-10-03', '10:00:00', '9363610085@ptyes', 'Money Received', 'Client Payment', 'vendor.acme@okicici', 2500, 'Successful', 'Business', 'UTR900005'],
    ['2026-10-03', '11:15:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Myntra', 'myntra@axisbank', 899, 'Pending', 'Shopping', 'UTR900006'],
    ['2026-10-04', '16:45:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Metro Card', 'metro@paytm', 75, 'Failed', 'Travel', 'UTR900007'],
    ['2026-10-05', '12:30:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Swiggy', 'swiggy@axisbank', 300, 'Successful', 'Food & Dining', 'UTR900008'],
    ['2026-10-05', '12:35:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Swiggy', 'swiggy@axisbank', 150, 'Successful', 'Food & Dining', 'UTR900009'],
    ['2026-10-06', '20:10:00', '9363610085@ptyes', 'Money Received', 'Refund Zomato', 'zomato@axisbank', 600, 'Successful', 'Food & Dining', 'UTR900010'],
    ['2026-10-07', '07:50:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Jio Recharge', 'jio@axisbank', 220, 'Successful', 'Bills & Utilities', 'UTR900011'],
    ['2026-10-07', '18:00:00', 'poovarasuzyra@okaxis', 'Money Sent', 'Amazon Return', 'amazon@apl', 300, 'Reversed', 'Shopping', 'UTR900012']
  ].map(function (r, i) {
    return {
      key: 'REF:' + r[9], row: i + 2, transactionId: '', date: r[0], time: r[1], upiId: r[2],
      type: r[3], counterparty: r[4], counterpartyUpi: r[5], amount: r[6], status: r[7],
      category: r[8], utr: r[9], method: 'UPI', source: 'Statement: sample-statement.csv',
      notes: '', lastUpdated: '2026-10-11 09:00:00'
    };
  });

  function short(iso) {
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = iso.split('-');
    return (+p[2]) + ' ' + m[+p[1] - 1];
  }

  var running = [];
  var cum = 0;
  DAILY.forEach(function (d) { cum += d.net; running.push({ date: d.date, label: short(d.date), value: cum }); });

  var dashboard = {
    ok: true, today: '2026-10-11', range: 'last30', rangeLabel: 'Last 30 days',
    summary: { received: 4300, sent: 1668, net: 2632, refunds: 300, successfulCount: 9, totalCount: 12, incomingCount: 3, outgoingCount: 6 },
    byUpi: [
      { id: '9363610085@ptyes', label: 'UPI ID 1', enabled: true, incomingCount: 3, incomingTotal: 4300, outgoingCount: 0, outgoingTotal: 0 },
      { id: 'poovarasuzyra@okaxis', label: 'UPI ID 2', enabled: true, incomingCount: 0, incomingTotal: 0, outgoingCount: 6, outgoingTotal: 1668 }
    ],
    receivedVsSent: [{ name: 'Money Received', value: 4300 }, { name: 'Money Sent', value: 1668 }],
    byUpiIncoming: [{ name: '9363610085@ptyes', value: 4300, count: 3 }],
    byUpiOutgoing: [{ name: 'poovarasuzyra@okaxis', value: 1668, count: 6 }],
    categories: [
      { name: 'Food & Dining', value: 799, count: 3 },
      { name: 'Shopping', value: 499, count: 1 },
      { name: 'Bills & Utilities', value: 220, count: 1 },
      { name: 'Travel', value: 150, count: 1 }
    ],
    dailyDistribution: DAILY.map(function (d) { return { date: d.date, label: short(d.date), received: d.received, sent: d.sent }; }),
    statusCounts: [
      { name: 'Successful', count: 9 }, { name: 'Pending', count: 1 },
      { name: 'Failed', count: 1 }, { name: 'Reversed', count: 1 }
    ],
    runningNet: running,
    dailySeries: DAILY.map(function (d) { return { date: d.date, label: short(d.date), received: d.received, sent: d.sent, net: d.net }; }),
    monthly: [{ month: '2026-10', received: 4300, sent: 1668, net: 2632, count: 9 }],
    yearly: [{ year: '2026', received: 4300, sent: 1668, net: 2632, count: 9 }],
    config: { currencySymbol: '₹', upiIds: UPI_IDS, darkMode: false, sync: { lastSync: null, lastStatus: 'not_connected', lastMessage: 'Preview mode — demo data only.', sourceCount: 0, sources: [] } }
  };

  var overall = {
    ok: true, generatedAt: '2026-10-11 09:00:00', firstDate: '2026-10-01', lastDate: '2026-10-07', upiIds: UPI_IDS,
    dailySeries: DAILY,
    stats: {
      received: 4300, sent: 1668, net: 2632, refunds: 300, incomingCount: 3, outgoingCount: 6,
      totalCount: 12, successfulCount: 9, avgIncoming: 1433.33, avgOutgoing: 278, maxIncoming: 2500, maxOutgoing: 499,
      byUpi: dashboard.byUpi,
      monthly: [{ month: '2026-10', received: 4300, sent: 1668, net: 2632, count: 9 }],
      yearly: [{ year: '2026', received: 4300, sent: 1668, net: 2632, count: 9 }]
    }
  };

  var MOCK = {
    getDashboardData: function () { return dashboard; },
    getOverallData: function () { return overall; },
    getDailyHistory: function () { return { ok: true, rows: DAILY.slice().reverse(), today: '2026-10-11' }; },
    getSettings: function () {
      return {
        ok: true,
        config: { appName: 'UPI Payment History Dashboard', timezone: 'Asia/Kolkata', currencySymbol: '₹', darkMode: false, pageSize: 25, upiIds: UPI_IDS },
        sync: { lastSync: null, lastStatus: 'not_connected', lastMessage: 'Preview mode — demo data only. Connect a real source after deploying.', sourceCount: 0, sources: [] },
        spreadsheetUrl: '#', spreadsheetId: 'preview'
      };
    },
    listTransactions: function (q) {
      q = q || {};
      var rows = TXNS.filter(function (t) {
        if (q.upiId && t.upiId !== q.upiId) return false;
        if (q.type && t.type !== q.type) return false;
        if (q.status && t.status !== q.status) return false;
        if (q.category && t.category !== q.category) return false;
        if (q.search) {
          var hay = (t.counterparty + ' ' + t.utr + ' ' + t.category).toLowerCase();
          if (hay.indexOf(String(q.search).toLowerCase()) === -1) return false;
        }
        return true;
      });
      var size = q.pageSize || 25, page = q.page || 1;
      var pages = Math.max(1, Math.ceil(rows.length / size));
      page = Math.min(Math.max(1, page), pages);
      return { ok: true, rows: rows.slice((page - 1) * size, page * size), total: rows.length, page: page, pages: pages, pageSize: size };
    },
    getAuditLog: function () {
      return { ok: true, rows: [
        { timestamp: '2026-10-11 09:00:00', user: 'you@example.com', action: 'import', details: 'Statement: sample-statement.csv — created 12, skipped 0' },
        { timestamp: '2026-10-11 08:59:00', user: 'you@example.com', action: 'setup', details: 'Dashboard worksheets initialised' }
      ] };
    },
    reconcileLedger: function () {
      return { ok: true, generatedAt: '2026-10-11 09:00:00', transactionCount: 12, issueCount: 1, issues: [
        { type: 'refund-reversal', date: '2026-10-07', amount: 300, counterparty: 'Amazon Return', message: 'Reversed / refunded transaction (excluded from received and sent totals)' }
      ] };
    },
    getPrintReport: function () {
      return { ok: true, generatedAt: '2026-10-11 09:00:00', rangeLabel: 'Last 30 days', summary: overall.stats, daily: DAILY.slice().reverse(), categories: dashboard.categories, upiIds: UPI_IDS };
    },
    exportTransactionsCsv: function () { return { ok: true, filename: 'upi-transactions.csv', content: 'Transaction ID,Transaction Date\n,2026-10-01', count: TXNS.length }; },
    exportDailyCsv: function () { return { ok: true, filename: 'upi-daily-report.csv', content: 'Date,Received\n2026-10-01,1200', count: DAILY.length }; },
    exportMonthlyCsv: function () { return { ok: true, filename: 'upi-monthly-report.csv', content: 'Month,Received\n2026-10,4300', count: 1 }; },
    exportReconciliationCsv: function () { return { ok: true, filename: 'upi-reconciliation.csv', content: 'Issue Type\nrefund-reversal', count: 1 }; },
    importTransactionsCsv: function () { return { ok: true, source: 'Pasted spreadsheet data', created: 3, updated: 0, skipped: 2, errors: [], totalRows: 5, syncedAt: '2026-10-11 09:00:00' }; },
    addManualTransaction: function () { return { ok: true, transaction: {} }; },
    reverseTransaction: function () { return { ok: true }; },
    updateSettings: function (p) { return { ok: true, config: { upiIds: (p && p.upiIds) || UPI_IDS, darkMode: !!(p && p.darkMode) } }; },
    addSyncSource: function () { return { ok: true, count: 1 }; },
    removeSyncSource: function () { return { ok: true, count: 0 }; },
    runSyncNow: function () { return { ok: true, status: 'not_connected', message: 'Preview mode — no live source.' }; },
    disconnectIntegrations: function () { return { ok: true }; },
    createDailySyncTrigger: function () { return { ok: true }; },
    removeDailySyncTrigger: function () { return { ok: true }; },
    resetDashboardData: function () { return { ok: true }; }
  };

  function makeChain(success, failure) {
    var obj = {
      withSuccessHandler: function (f) { return makeChain(f, failure); },
      withFailureHandler: function (f) { return makeChain(success, f); }
    };
    Object.keys(MOCK).forEach(function (name) {
      obj[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        setTimeout(function () {
          try { if (success) success(MOCK[name].apply(null, args)); }
          catch (e) { if (failure) failure(e); }
        }, 120);
      };
    });
    return obj;
  }

  window.google = window.google || {};
  window.google.script = { run: makeChain(null, null) };

  // Offline fallbacks so the preview still renders without CDN access.
  if (!window.google.charts) {
    window.google.charts = { load: function () {}, setOnLoadCallback: function (cb) { setTimeout(cb, 0); } };
  }
  if (!window.google.visualization) {
    function Noop() {}
    Noop.prototype.draw = function () {};
    window.google.visualization = {
      PieChart: Noop, ColumnChart: Noop, LineChart: Noop,
      DataTable: function () { this.addColumn = function () {}; this.addRows = function () {}; },
      NumberFormat: function () { this.format = function () {}; }
    };
  }
})();
