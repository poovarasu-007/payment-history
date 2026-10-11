/**
 * Code.gs
 * ---------------------------------------------------------------------------
 * Entry points: spreadsheet menu, one-time setup, and trigger management.
 * ---------------------------------------------------------------------------
 */

/** Add the dashboard menu to the bound spreadsheet (if used as a bound script). */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('UPI Dashboard')
      .addItem('Set up / repair worksheets', 'setupDashboard')
      .addItem('Open dashboard', 'openDashboardSidebar')
      .addSeparator()
      .addItem('Refresh calculated sheets', 'refreshDerivedSheetsFromMenu')
      .addItem('Reconcile transactions', 'reconcileFromMenu')
      .addSeparator()
      .addItem('Run self-tests', 'runAllTests')
      .addToUi();
  } catch (e) {
    // Not bound to a spreadsheet — the menu simply isn't available.
  }
}

function setupDashboard() {
  var result = ensureDashboard();
  refreshDerivedSheets();
  try {
    SpreadsheetApp.getUi().alert(
      'UPI Payment History Dashboard is ready.\n\n' +
      'Spreadsheet: ' + result.url + '\n\n' +
      'Next steps:\n' +
      '1. Deploy this script as a Web App (Deploy > New deployment > Web app).\n' +
      '2. Open the Web App URL to see the dashboard.\n' +
      '3. Import a bank statement CSV or add a transaction manually.\n\n' +
      'This app never asks for a UPI PIN, OTP or banking password.'
    );
  } catch (e) {
    Logger.log('Dashboard ready: ' + result.url);
  }
  return result;
}

function openDashboardSidebar() {
  var url = getScriptProperty('WEBAPP_URL', '');
  if (!url) {
    try {
      SpreadsheetApp.getUi().alert(
        'Deploy this script as a Web App first (Deploy > New deployment > Web app), ' +
        'then paste the /exec URL into Script Properties under WEBAPP_URL.'
      );
    } catch (e) {}
    return;
  }
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;padding:16px">' +
    '<h3>UPI Payment History Dashboard</h3>' +
    '<p><a href="' + url + '" target="_blank">Open the full dashboard in a new tab</a></p>' +
    '<iframe src="' + url + '" style="width:100%;height:520px;border:1px solid #ccc;border-radius:8px"></iframe>' +
    '</div>'
  ).setTitle('UPI Dashboard');
  try {
    SpreadsheetApp.getUi().showSidebar(html);
  } catch (e) {}
}

function refreshDerivedSheetsFromMenu() {
  refreshDerivedSheets();
  try { SpreadsheetApp.getUi().alert('Daily, Overall and Dashboard Data sheets refreshed from the ledger.'); } catch (e) {}
}

function reconcileFromMenu() {
  var report = reconcileLedger();
  var msg = report.issueCount === 0
    ? 'No data-quality issues found across ' + report.transactionCount + ' transactions.'
    : report.issueCount + ' issue(s) found across ' + report.transactionCount + ' transactions. ' +
      'Open the dashboard > Reports > Reconciliation for details.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

/**
 * Create the optional daily sync trigger. Scheduled sync only does something
 * when the user has connected an authorized webhook source; otherwise it simply
 * records the honest "not connected" status.
 */
function createDailySyncTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'scheduledSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduledSync')
    .timeBased()
    .everyHours(6)
    .create();
  auditLog('setup', 'Scheduled sync trigger created (every 6 hours)');
  return { ok: true };
}

function removeDailySyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scheduledSync') ScriptApp.deleteTrigger(t);
  });
  auditLog('setup', 'Scheduled sync trigger removed');
  return { ok: true };
}

/** Quick health check used by setup docs / debugging. */
function diagnose() {
  var cfg = getConfig();
  var ss = getSpreadsheet();
  var ledger = readLedger();
  return {
    ok: true,
    spreadsheetUrl: ss.getUrl(),
    ledgerRows: ledger.length,
    upiIds: cfg.upiIds,
    sync: publicSync(cfg.sync),
    sheets: [SHEETS.ALL, SHEETS.DAILY, SHEETS.OVERALL, SHEETS.DASH, SHEETS.AUDIT]
  };
}
