/**
 * Tests.gs
 * ---------------------------------------------------------------------------
 * In-editor self-tests. Run `runAllTests` from the Apps Script editor (or the
 * spreadsheet menu) to verify the core logic on live Apps Script.
 *
 * The same scenarios are covered in Node by tests/core.test.js, which uses the
 * identical Core.gs file.
 * ---------------------------------------------------------------------------
 */

function runAllTests() {
  var results = [];

  function t(name, fn) {
    try {
      fn();
      results.push({ name: name, ok: true });
    } catch (e) {
      results.push({ name: name, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  var UPI = [
    { id: '9363610085@ptyes', label: 'UPI ID 1', enabled: true },
    { id: 'poovarasuzyra@okaxis', label: 'UPI ID 2', enabled: true }
  ];

  t('parseAmount: currency symbol + commas', function () {
    var a = Core.parseAmount('₹1,234.56');
    assertEq(a.amount, 1234.56);
    assertEq(a.sign, 0);
  });

  t('parseAmount: parentheses = negative', function () {
    var a = Core.parseAmount('(500.00)');
    assertEq(a.amount, 500);
    assertEq(a.sign, -1);
  });

  t('parseAmount: Dr / Cr suffixes', function () {
    assertEq(Core.parseAmount('999.99 Dr').sign, -1);
    assertEq(Core.parseAmount('1,000.00 Cr').sign, 1);
  });

  t('parseAmount: invalid returns null', function () {
    assertEq(Core.parseAmount('not-a-number'), null);
    assertEq(Core.parseAmount(''), null);
  });

  t('normalizeStatus mapping', function () {
    assertEq(Core.normalizeStatus('SUCCESS'), 'Successful');
    assertEq(Core.normalizeStatus('Completed'), 'Successful');
    assertEq(Core.normalizeStatus('pending'), 'Pending');
    assertEq(Core.normalizeStatus('FAILED'), 'Failed');
    assertEq(Core.normalizeStatus('Refunded'), 'Reversed');
    assertEq(Core.normalizeStatus(''), 'Unknown');
  });

  t('normalizeType from keywords and sign', function () {
    assertEq(Core.normalizeType('Credit', null), 'Money Received');
    assertEq(Core.normalizeType('Debit', null), 'Money Sent');
    assertEq(Core.normalizeType('', -500), 'Money Sent');
    assertEq(Core.normalizeType('', 500), 'Money Received');
    assertEq(Core.normalizeType('', null), 'Unknown');
  });

  t('parseDateParts: ISO and Indian formats', function () {
    assertEq(Core.parseDateParts('2026-10-11').d, 11);
    assertEq(Core.parseDateParts('11/10/2026').m, 10);
    assertEq(Core.parseDateParts('11-10-2026').y, 2026);
    assertEq(Core.parseDateParts('11 Jan 2026').m, 1);
    assertEq(Core.parseDateParts('13/13/2026'), null);
  });

  t('parseTime: 12h and 24h', function () {
    assertEq(Core.parseTime('14:30'), '14:30:00');
    assertEq(Core.parseTime('2:30 PM'), '14:30:00');
    assertEq(Core.parseTime('12:00 AM'), '00:00:00');
  });

  t('matchUpiId honours both IDs and the enabled flag', function () {
    assertEq(Core.matchUpiId('paid via 9363610085@ptyes', UPI), '9363610085@ptyes');
    assertEq(Core.matchUpiId('poovarasuzyra@okaxis', UPI), 'poovarasuzyra@okaxis');
    var disabled = [{ id: '9363610085@ptyes', enabled: false }];
    assertEq(Core.matchUpiId('9363610085@ptyes', disabled), null);
  });

  t('transactionKey prefers UTR and falls back to a stable hash', function () {
    assertEq(Core.transactionKey({ utr: 'UTR123' }), 'REF:UTR123');
    var a = Core.transactionKey({ date: '2026-10-11', amount: 100, counterparty: 'X', type: 'Money Sent' });
    var b = Core.transactionKey({ date: '2026-10-11', amount: 100, counterparty: 'X', type: 'Money Sent' });
    var c = Core.transactionKey({ date: '2026-10-11', amount: 101, counterparty: 'X', type: 'Money Sent' });
    assertEq(a, b);
    assertTrue(a !== c);
  });

  t('reconcileImport: create / update / skip', function () {
    var existing = [{ utr: 'A', status: 'Successful', amount: 100 }];
    var rec = Core.reconcileImport(existing, [
      { utr: 'A', status: 'Successful', amount: 100 },
      { utr: 'A', status: 'Pending', amount: 100 },
      { utr: 'B', status: 'Successful', amount: 250 }
    ]);
    assertEq(rec.created.length, 1);
    assertEq(rec.updated.length, 1);
    assertEq(rec.skipped.length, 1);
  });

  t('dedupe collapses duplicates within one batch', function () {
    var rec = Core.reconcileImport([], [
      { utr: 'Z', status: 'Successful', amount: 10 },
      { utr: 'Z', status: 'Successful', amount: 10 }
    ]);
    assertEq(rec.created.length, 1);
    assertEq(rec.skipped.length, 1);
  });

  t('daily totals exclude unsuccessful and separate refunds', function () {
    var daily = Core.summarizeByDay([
      { date: '2026-10-10', type: 'Money Received', status: 'Successful', amount: 1000 },
      { date: '2026-10-10', type: 'Money Sent', status: 'Successful', amount: 400 },
      { date: '2026-10-10', type: 'Money Sent', status: 'Pending', amount: 100 },
      { date: '2026-10-10', type: 'Money Received', status: 'Reversed', amount: 200 }
    ]);
    assertEq(daily.length, 1);
    assertEq(daily[0].received, 1000);
    assertEq(daily[0].sent, 400);
    assertEq(daily[0].refunds, 200);
    assertEq(daily[0].net, 600);
    assertEq(daily[0].totalCount, 4);
    assertEq(daily[0].incomingCount, 1);
    assertEq(daily[0].outgoingCount, 1);
  });

  t('overall stats: averages, maxima, monthly/yearly buckets', function () {
    var s = Core.computeOverallStats([
      { date: '2026-01-05', type: 'Money Received', status: 'Successful', amount: 100, upiId: UPI[0].id },
      { date: '2026-01-06', type: 'Money Received', status: 'Successful', amount: 300, upiId: UPI[0].id },
      { date: '2026-02-01', type: 'Money Sent', status: 'Successful', amount: 100, upiId: UPI[1].id }
    ], UPI);
    assertEq(s.received, 400);
    assertEq(s.sent, 100);
    assertEq(s.net, 300);
    assertEq(s.avgIncoming, 200);
    assertEq(s.maxIncoming, 300);
    assertEq(s.monthly.length, 2);
    assertEq(s.yearly[0].received, 400);
  });

  t('range filtering handles today / last7 / month / all', function () {
    var txns = [
      { date: '2026-10-11' }, { date: '2026-10-10' }, { date: '2026-10-04' },
      { date: '2026-09-30' }, { date: '2026-01-01' }
    ];
    assertEq(Core.filterByRange(txns, 'today', '2026-10-11').length, 1);
    assertEq(Core.filterByRange(txns, 'last7', '2026-10-11').length, 2);
    assertEq(Core.filterByRange(txns, 'month', '2026-10-11').length, 3);
    assertEq(Core.filterByRange(txns, 'all', '2026-10-11').length, 5);
  });

  t('category inference', function () {
    assertEq(Core.inferCategory('Swiggy Instamart'), 'Food & Dining');
    assertEq(Core.inferCategory('Amazon Pay merchant'), 'Shopping');
    assertEq(Core.inferCategory('Uber India'), 'Travel');
    assertEq(Core.inferCategory('Jio recharge'), 'Bills & Utilities');
    assertEq(Core.inferCategory('Nondescript merchant'), 'Other');
  });

  t('detectColumns maps typical bank headers', function () {
    var map = Core.detectColumns(['Transaction Date', 'Amount (₹)', 'Type', 'Status', 'Name', 'UTR']);
    assertEq(map.date, 0);
    assertEq(map.amount, 1);
    assertEq(map.type, 2);
    assertEq(map.status, 3);
    assertEq(map.counterparty, 4);
    assertEq(map.utr, 5);
    assertTrue(!!Core.detectColumns(['Foo', 'Bar']).error);
  });

  t('normalizeRow builds a complete transaction', function () {
    var map = Core.detectColumns(['Transaction Date', 'Amount (₹)', 'Type', 'Status', 'Name', 'UTR']);
    var n = Core.normalizeRow(
      ['11/10/2026', '₹500.00', 'Debit', 'Success', 'Swiggy', 'UTR-9'],
      map, UPI, { source: 'test' }
    );
    assertEq(n.date, '2026-10-11');
    assertEq(n.amount, 500);
    assertEq(n.type, 'Money Sent');
    assertEq(n.status, 'Successful');
    assertEq(n.category, 'Food & Dining');
    assertEq(n.utr, 'UTR-9');
  });

  t('CSV round-trip with quotes and commas', function () {
    var csv = Core.toCsv(['a', 'b'], [['hello, world', 'say "hi"']]);
    var parsed = Core.parseCsv(csv);
    assertEq(parsed[1][0], 'hello, world');
    assertEq(parsed[1][1], 'say "hi"');
  });

  t('manual entry validation', function () {
    assertTrue(!Core.validateManualTxn({ date: '', amount: 0, type: 'Money Sent' }).ok);
    assertTrue(Core.validateManualTxn({
      date: '2026-10-11', amount: '250', type: 'Money Received', status: 'Successful'
    }).ok);
  });

  t('reconciliation flags duplicates, missing refs and refunds', function () {
    var issues = Core.findReconciliationIssues([
      { date: '2026-10-10', amount: 100, counterparty: 'Ravi', status: 'Successful', type: 'Money Sent', utr: '' },
      { date: '2026-10-10', amount: 100, counterparty: 'Ravi', status: 'Successful', type: 'Money Sent', utr: 'U1' },
      { date: '2026-10-10', amount: 50, counterparty: 'Shop', status: 'Reversed', type: 'Money Sent', utr: 'U2' },
      { date: '2026-10-10', amount: 50, counterparty: 'Shop', status: 'Successful', type: 'Unknown', utr: 'U3' }
    ]);
    var types = issues.map(function (i) { return i.type; });
    assertTrue(types.indexOf('missing-reference') !== -1);
    assertTrue(types.indexOf('duplicate-candidate') !== -1);
    assertTrue(types.indexOf('refund-reversal') !== -1);
    assertTrue(types.indexOf('unknown-direction') !== -1);
  });

  var failed = results.filter(function (r) { return !r.ok; });
  var summary = 'Self-tests: ' + (results.length - failed.length) + '/' + results.length + ' passed';
  Logger.log(summary);
  failed.forEach(function (f) { Logger.log('FAILED: ' + f.name + ' -> ' + f.error); });

  if (failed.length) {
    throw new Error(summary + '. Failures: ' + JSON.stringify(failed));
  }
  return results;
}

/* Tiny assertion helpers */
function assertEq(actual, expected) {
  if (actual !== expected) {
    throw new Error('Expected <' + expected + '> but got <' + actual + '>');
  }
}

function assertTrue(cond) {
  if (!cond) throw new Error('Expected condition to be true');
}
