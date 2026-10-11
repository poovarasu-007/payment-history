/**
 * tests/core.test.js
 * ---------------------------------------------------------------------------
 * Node unit tests for the pure logic in apps-script/Core.gs.
 *
 * Run with:  node --test tests/      (or)  npm test
 *
 * The file under test is plain JavaScript with no Apps Script dependencies, so
 * it can be executed directly in a Node vm context. These tests mirror the
 * in-editor `runAllTests()` suite in apps-script/Tests.gs.
 * ---------------------------------------------------------------------------
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const corePath = path.join(__dirname, '..', 'apps-script', 'Core.gs');
const source = fs.readFileSync(corePath, 'utf8');

// Run in the current realm so deepEqual works across object prototypes, and
// expose the module without polluting anything else.
vm.runInThisContext(source, { filename: 'Core.gs' });
const Core = globalThis.Core;
delete globalThis.Core;

const UPI = [
  { id: '9363610085@ptyes', label: 'UPI ID 1', enabled: true },
  { id: 'poovarasuzyra@okaxis', label: 'UPI ID 2', enabled: true }
];

/* ------------------------------------------------------------ parsing */

test('parseAmount handles ₹, commas, parentheses, Cr/Dr', () => {
  assert.deepEqual(Core.parseAmount('₹1,234.56'), { amount: 1234.56, sign: 0 });
  assert.deepEqual(Core.parseAmount('(500.00)'), { amount: 500, sign: -1 });
  assert.deepEqual(Core.parseAmount('-250'), { amount: 250, sign: -1 });
  assert.deepEqual(Core.parseAmount('1,000.00 Cr'), { amount: 1000, sign: 1 });
  assert.deepEqual(Core.parseAmount('999.99 Dr'), { amount: 999.99, sign: -1 });
  assert.equal(Core.parseAmount('not-a-number'), null);
  assert.equal(Core.parseAmount(''), null);
});

test('normalizeStatus maps every provider variant', () => {
  assert.equal(Core.normalizeStatus('SUCCESS'), 'Successful');
  assert.equal(Core.normalizeStatus('completed'), 'Successful');
  assert.equal(Core.normalizeStatus('pending'), 'Pending');
  assert.equal(Core.normalizeStatus('FAILED'), 'Failed');
  assert.equal(Core.normalizeStatus('unpaid'), 'Failed');
  assert.equal(Core.normalizeStatus('Refunded'), 'Reversed');
  assert.equal(Core.normalizeStatus('reversed'), 'Reversed');
  assert.equal(Core.normalizeStatus(''), 'Unknown');
});

test('normalizeType uses keywords and amount sign', () => {
  assert.equal(Core.normalizeType('Credit', null), 'Money Received');
  assert.equal(Core.normalizeType('Debit', null), 'Money Sent');
  assert.equal(Core.normalizeType('UPI Transfer', null), 'Money Sent');
  assert.equal(Core.normalizeType('', -500), 'Money Sent');
  assert.equal(Core.normalizeType('', 500), 'Money Received');
  assert.equal(Core.normalizeType('', null), 'Unknown');
});

test('parseDateParts understands ISO, Indian and named months', () => {
  assert.deepEqual(Core.parseDateParts('2026-10-11'), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(Core.parseDateParts('11/10/2026'), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(Core.parseDateParts('11-10-2026'), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(Core.parseDateParts('11 Jan 2026'), { y: 2026, m: 1, d: 11 });
  assert.deepEqual(Core.parseDateParts('Jan 11, 2026'), { y: 2026, m: 1, d: 11 });
  assert.equal(Core.parseDateParts('13/13/2026'), null);
});

test('parseTime normalises 12h and 24h', () => {
  assert.equal(Core.parseTime('14:30'), '14:30:00');
  assert.equal(Core.parseTime('2:30 PM'), '14:30:00');
  assert.equal(Core.parseTime('12:00 AM'), '00:00:00');
  assert.equal(Core.parseTime('09:15:45'), '09:15:45');
  assert.equal(Core.parseTime('nonsense'), null);
});

/* ------------------------------------------------------- UPI matching */

test('matchUpiId matches both configured IDs, respects enabled flag', () => {
  assert.equal(Core.matchUpiId('paid via 9363610085@ptyes now', UPI), '9363610085@ptyes');
  assert.equal(Core.matchUpiId('to poovarasuzyra@okaxis', UPI), 'poovarasuzyra@okaxis');
  assert.equal(Core.matchUpiId('no id here', UPI), null);
  assert.equal(
    Core.matchUpiId('9363610085@ptyes', [{ id: '9363610085@ptyes', enabled: false }]),
    null
  );
});

test('isUpiIdLike sanity check', () => {
  assert.ok(Core.isUpiIdLike('name@okaxis'));
  assert.ok(!Core.isUpiIdLike('just a name'));
});

/* ----------------------------------------------------- dedupe + keying */

test('transactionKey prefers UTR and otherwise hashes deterministically', () => {
  assert.equal(Core.transactionKey({ utr: 'UTR123' }), 'REF:UTR123');
  assert.equal(Core.transactionKey({ transactionId: 'TX9' }), 'REF:TX9');
  const a = Core.transactionKey({ date: '2026-10-11', time: '10:00:00', amount: 100, counterparty: 'X', type: 'Money Sent' });
  const b = Core.transactionKey({ date: '2026-10-11', time: '10:00:00', amount: 100, counterparty: 'X', type: 'Money Sent' });
  const c = Core.transactionKey({ date: '2026-10-11', time: '10:00:00', amount: 101, counterparty: 'X', type: 'Money Sent' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('reconcileImport detects create / update / skip', () => {
  const existing = [{ utr: 'A', status: 'Successful', amount: 100 }];
  const rec = Core.reconcileImport(existing, [
    { utr: 'A', status: 'Successful', amount: 100 }, // duplicate -> skip
    { utr: 'A', status: 'Pending', amount: 100 },    // status change -> update
    { utr: 'B', status: 'Successful', amount: 250 }  // new -> create
  ]);
  assert.equal(rec.created.length, 1);
  assert.equal(rec.updated.length, 1);
  assert.equal(rec.skipped.length, 1);
});

test('reconcileImport collapses duplicates inside one batch', () => {
  const rec = Core.reconcileImport([], [
    { utr: 'Z', status: 'Successful', amount: 10 },
    { utr: 'Z', status: 'Successful', amount: 10 }
  ]);
  assert.equal(rec.created.length, 1);
  assert.equal(rec.skipped.length, 1);
});

/* -------------------------------------------------------- aggregation */

test('summarizeByDay excludes unsuccessful and separates refunds', () => {
  const daily = Core.summarizeByDay([
    { date: '2026-10-10', type: 'Money Received', status: 'Successful', amount: 1000 },
    { date: '2026-10-10', type: 'Money Sent', status: 'Successful', amount: 400 },
    { date: '2026-10-10', type: 'Money Sent', status: 'Pending', amount: 100 },
    { date: '2026-10-10', type: 'Money Sent', status: 'Failed', amount: 999 },
    { date: '2026-10-10', type: 'Money Received', status: 'Reversed', amount: 200 }
  ]);
  assert.equal(daily.length, 1);
  const d = daily[0];
  assert.equal(d.received, 1000);
  assert.equal(d.sent, 400);
  assert.equal(d.refunds, 200);
  assert.equal(d.net, 600);
  assert.equal(d.incomingCount, 1);
  assert.equal(d.outgoingCount, 1);
  assert.equal(d.totalCount, 5); // every status counts toward the total
});

test('computeOverallStats produces averages, maxima and period buckets', () => {
  const s = Core.computeOverallStats([
    { date: '2026-01-05', type: 'Money Received', status: 'Successful', amount: 100, upiId: UPI[0].id },
    { date: '2026-01-06', type: 'Money Received', status: 'Successful', amount: 300, upiId: UPI[0].id },
    { date: '2026-02-01', type: 'Money Sent', status: 'Successful', amount: 100, upiId: UPI[1].id },
    { date: '2026-02-02', type: 'Money Sent', status: 'Failed', amount: 5000, upiId: UPI[1].id },
    { date: '2026-02-03', type: 'Money Sent', status: 'Reversed', amount: 150, upiId: UPI[1].id }
  ], UPI);

  assert.equal(s.received, 400);
  assert.equal(s.sent, 100);
  assert.equal(s.net, 300);
  assert.equal(s.refunds, 150);
  assert.equal(s.avgIncoming, 200);
  assert.equal(s.maxIncoming, 300);
  assert.equal(s.maxOutgoing, 100);
  assert.equal(s.successfulCount, 3);
  assert.equal(s.monthly.length, 2);
  assert.equal(s.yearly.length, 1);
  assert.equal(s.yearly[0].received, 400);

  const upi1 = s.byUpi.find((u) => u.id === UPI[0].id);
  assert.equal(upi1.incomingCount, 2);
  assert.equal(upi1.incomingTotal, 400);
});

/* -------------------------------------------------------- date ranges */

test('filterByRange covers today / last7 / month / year / all', () => {
  const txns = [
    { date: '2026-10-11' }, { date: '2026-10-10' }, { date: '2026-10-04' },
    { date: '2026-09-30' }, { date: '2026-01-01' }
  ];
  assert.equal(Core.filterByRange(txns, 'today', '2026-10-11').length, 1);
  assert.equal(Core.filterByRange(txns, 'yesterday', '2026-10-11').length, 1);
  assert.equal(Core.filterByRange(txns, 'last7', '2026-10-11').length, 2);
  assert.equal(Core.filterByRange(txns, 'month', '2026-10-11').length, 3);
  assert.equal(Core.filterByRange(txns, 'year', '2026-10-11').length, 5);
  assert.equal(Core.filterByRange(txns, 'all', '2026-10-11').length, 5);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(Core.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(Core.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(Core.addDays('2024-02-28', 1), '2024-02-29');
});

/* ------------------------------------------------------- CSV + mapping */

test('parseCsv handles quotes, embedded commas and escaped quotes', () => {
  const rows = Core.parseCsv('a,b\n"hello, world","say ""hi"""');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], 'hello, world');
  assert.equal(rows[1][1], 'say "hi"');
});

test('parseDelimited handles tab-separated pasted data', () => {
  const rows = Core.parseDelimited('Date\tAmount\n11/10/2026\t500');
  assert.equal(rows[0].length, 2);
  assert.equal(rows[1][1], '500');
});

test('detectColumns maps typical bank headers and reports missing ones', () => {
  const map = Core.detectColumns(['Transaction Date', 'Amount (₹)', 'Type', 'Status', 'Name', 'UTR']);
  assert.equal(map.date, 0);
  assert.equal(map.amount, 1);
  assert.equal(map.type, 2);
  assert.equal(map.status, 3);
  assert.equal(map.counterparty, 4);
  assert.equal(map.utr, 5);

  const bad = Core.detectColumns(['Foo', 'Bar']);
  assert.ok(bad.error);
});

test('detectColumns prefers "payer or payee UPI id" over the generic UPI id column', () => {
  const map = Core.detectColumns(['Your UPI ID', 'Payer or Payee UPI ID', 'Date', 'Amount']);
  assert.equal(map.upiId, 0);
  assert.equal(map.counterpartyUpi, 1);
});

test('normalizeRow builds a full transaction', () => {
  const map = Core.detectColumns(['Transaction Date', 'Amount (₹)', 'Type', 'Status', 'Name', 'UTR']);
  const n = Core.normalizeRow(
    ['11/10/2026', '₹500.00', 'Debit', 'Success', 'Swiggy', 'UTR-9'],
    map, UPI, { source: 'test' }
  );
  assert.equal(n.date, '2026-10-11');
  assert.equal(n.amount, 500);
  assert.equal(n.type, 'Money Sent');
  assert.equal(n.status, 'Successful');
  assert.equal(n.category, 'Food & Dining');
  assert.equal(n.utr, 'UTR-9');
  assert.equal(n.source, 'test');
});

test('normalizeRow flags bad amount and bad date', () => {
  const map = Core.detectColumns(['Date', 'Amount']);
  assert.ok(Core.normalizeRow(['11/10/2026', 'abc'], map, UPI).error);
  assert.ok(Core.normalizeRow(['not a date', '100'], map, UPI).error);
});

test('normalizeRow matches the configured UPI id from the statement', () => {
  const map = Core.detectColumns(['Your UPI ID', 'Date', 'Amount', 'Type', 'Status']);
  const n = Core.normalizeRow(['poovarasuzyra@okaxis', '11/10/2026', '250', 'Credit', 'Success'], map, UPI, {});
  assert.equal(n.upiId, 'poovarasuzyra@okaxis');
  assert.equal(n.type, 'Money Received');
});

/* ------------------------------------------------------- categorisation */

test('inferCategory recognises common merchants', () => {
  assert.equal(Core.inferCategory('Swiggy Instamart'), 'Food & Dining');
  assert.equal(Core.inferCategory('Amazon Pay merchant'), 'Shopping');
  assert.equal(Core.inferCategory('Uber India'), 'Travel');
  assert.equal(Core.inferCategory('Jio recharge'), 'Bills & Utilities');
  assert.equal(Core.inferCategory('Upi transfer to Ravi'), 'Transfer');
  assert.equal(Core.inferCategory('Nondescript merchant'), 'Other');
});

/* ------------------------------------------------------ reconciliation */

test('findReconciliationIssues flags the right problems', () => {
  const issues = Core.findReconciliationIssues([
    { date: '2026-10-10', amount: 100, counterparty: 'Ravi', status: 'Successful', type: 'Money Sent', utr: '' },
    { date: '2026-10-10', amount: 100, counterparty: 'Ravi', status: 'Successful', type: 'Money Sent', utr: 'U1' },
    { date: '2026-10-10', amount: 50, counterparty: 'Shop', status: 'Reversed', type: 'Money Sent', utr: 'U2' },
    { date: '2026-10-10', amount: 50, counterparty: 'Shop', status: 'Successful', type: 'Unknown', utr: 'U3' },
    { date: '2026-10-10', amount: 999, counterparty: 'Other', status: 'Successful', type: 'Money Sent', utr: 'U1' }
  ]);
  const types = issues.map((i) => i.type);
  assert.ok(types.includes('missing-reference'));
  assert.ok(types.includes('duplicate-candidate'));
  assert.ok(types.includes('refund-reversal'));
  assert.ok(types.includes('unknown-direction'));
  assert.ok(types.includes('amount-mismatch'));
});

/* -------------------------------------------------------- manual entry */

test('validateManualTxn enforces required fields', () => {
  assert.equal(Core.validateManualTxn({ date: '', amount: 0, type: 'Money Sent' }).ok, false);
  assert.equal(Core.validateManualTxn({ date: '2026-10-11', amount: '250', type: 'Unknown' }).ok, false);
  assert.equal(
    Core.validateManualTxn({ date: '2026-10-11', amount: '250', type: 'Money Received', status: 'Successful' }).ok,
    true
  );
});

/* ------------------------------------------------------------ exports */

test('toCsv escapes commas and quotes correctly', () => {
  const csv = Core.toCsv(['name', 'note'], [['Ravi, Kumar', 'says "hi"']]);
  const parsed = Core.parseCsv(csv);
  assert.equal(parsed[1][0], 'Ravi, Kumar');
  assert.equal(parsed[1][1], 'says "hi"');
});

/* -------------------------------------------------- end-to-end scenario */

test('end-to-end: mixed CSV import produces correct daily and overall totals', () => {
  const header = ['Transaction Date', 'Transaction Time', 'Amount (₹)', 'Type', 'Status', 'Name', 'UTR', 'Your UPI ID'];
  const csv = [
    header.join(','),
    '11/10/2026,10:15,"₹1,000.00",Credit,Success,Ravi Kumar,UTR1001,9363610085@ptyes',
    '11/10/2026,12:30,₹250.00,Debit,Success,Swiggy,UTR1002,poovarasuzyra@okaxis',
    '11/10/2026,13:00,₹99.00,Debit,Pending,Amazon,UTR1003,poovarasuzyra@okaxis',
    '11/10/2026,15:00,₹500.00,Credit,Success,Refund from Zomato,UTR1004,9363610085@ptyes',
    '11/10/2026,09:00,₹250.00,Debit,Success,Swiggy,UTR1002,poovarasuzyra@okaxis' // duplicate UTR
  ].join('\n');

  const rows = Core.parseCsv(csv);
  const map = Core.detectColumns(rows[0]);
  const incoming = [];
  for (let i = 1; i < rows.length; i++) {
    const n = Core.normalizeRow(rows[i], map, UPI, { source: 'test' });
    assert.ok(!n.error, n.error);
    incoming.push(n);
  }

  const rec = Core.reconcileImport([], incoming);
  assert.equal(rec.created.length, 4); // 5 rows, 1 duplicate UTR collapsed
  assert.equal(rec.skipped.length, 1);

  const ledger = rec.created;
  const daily = Core.summarizeByDay(ledger);
  assert.equal(daily.length, 1);
  assert.equal(daily[0].received, 1500);  // 1000 + 500, pending excluded (it is outgoing anyway)
  assert.equal(daily[0].sent, 250);       // only the successful Swiggy debit
  assert.equal(daily[0].net, 1250);

  const stats = Core.computeOverallStats(ledger, UPI);
  assert.equal(stats.received, 1500);
  assert.equal(stats.sent, 250);
  assert.equal(stats.net, 1250);

  const byId = {};
  stats.byUpi.forEach((u) => { byId[u.id] = u; });
  assert.equal(byId['9363610085@ptyes'].incomingCount, 2);
  assert.equal(byId['poovarasuzyra@okaxis'].outgoingCount, 1);
});
