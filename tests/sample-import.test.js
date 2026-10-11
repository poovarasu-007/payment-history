/**
 * tests/sample-import.test.js
 * ---------------------------------------------------------------------------
 * Integration test: runs the real samples/sample-statement.csv through the
 * same import pipeline the dashboard uses (parse -> detectColumns ->
 * normalizeRow -> reconcileImport -> summarizeByDay -> computeOverallStats)
 * and asserts the resulting totals and dedupe behaviour.
 * ---------------------------------------------------------------------------
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Core.gs'), 'utf8');
vm.runInThisContext(source, { filename: 'Core.gs' });
const Core = globalThis.Core;
delete globalThis.Core;

const UPI = [
  { id: '9363610085@ptyes', label: 'UPI ID 1', enabled: true },
  { id: 'poovarasuzyra@okaxis', label: 'UPI ID 2', enabled: true }
];

function importSample() {
  const csv = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample-statement.csv'), 'utf8');
  const rows = Core.parseCsv(csv);
  const map = Core.detectColumns(rows[0]);
  assert.ok(!map.error, map.error);
  const incoming = [];
  for (let i = 1; i < rows.length; i++) {
    const n = Core.normalizeRow(rows[i], map, UPI, { source: 'sample' });
    assert.ok(!n.error, `row ${i + 1}: ${n.error}`);
    incoming.push(n);
  }
  return incoming;
}

test('sample statement imports cleanly and matches the expected totals', () => {
  const incoming = importSample();
  const rec = Core.reconcileImport([], incoming);
  assert.equal(rec.created.length, 12);
  assert.equal(rec.skipped.length, 0);
  assert.equal(rec.updated.length, 0);

  const ledger = rec.created;
  const daily = Core.summarizeByDay(ledger);
  assert.equal(daily.length, 7); // one row per unique date

  const stats = Core.computeOverallStats(ledger, UPI);
  assert.equal(stats.received, 4300);   // 1200 + 2500 + 600
  assert.equal(stats.sent, 1668);       // 349+150+499+300+150+220
  assert.equal(stats.refunds, 300);     // the reversed Amazon Return
  assert.equal(stats.net, 2632);        // received - sent
  assert.equal(stats.incomingCount, 3);
  assert.equal(stats.outgoingCount, 6);
  assert.equal(stats.successfulCount, 9);
  assert.equal(stats.totalCount, 12);

  const byId = {};
  stats.byUpi.forEach((u) => { byId[u.id] = u; });
  assert.equal(byId['9363610085@ptyes'].incomingCount, 3);
  assert.equal(byId['9363610085@ptyes'].incomingTotal, 4300);
  assert.equal(byId['9363610085@ptyes'].outgoingCount, 0);
  assert.equal(byId['poovarasuzyra@okaxis'].outgoingCount, 6);
  assert.equal(byId['poovarasuzyra@okaxis'].outgoingTotal, 1668);
});

test('re-importing the same statement creates no duplicates', () => {
  const first = Core.reconcileImport([], importSample());
  const second = Core.reconcileImport(first.created, importSample());
  assert.equal(second.created.length, 0);
  assert.equal(second.updated.length, 0);
  assert.equal(second.skipped.length, 12);
});

test('a Pending -> Successful status change is applied as an update, not a duplicate', () => {
  const first = Core.reconcileImport([], importSample());
  const pendingRow = first.created.find((t) => t.utr === 'UTR900006'); // Myntra, Pending
  assert.equal(pendingRow.status, 'Pending');

  const changed = importSample().map((t) =>
    t.utr === 'UTR900006' ? Object.assign({}, t, { status: 'Successful' }) : t
  );
  const rec = Core.reconcileImport(first.created, changed);
  assert.equal(rec.created.length, 0);
  assert.equal(rec.updated.length, 1);
  assert.equal(rec.updated[0].txn.utr, 'UTR900006');
  assert.equal(rec.updated[0].txn.status, 'Successful');

  // After the update, the previously-pending row now counts toward "sent".
  const merged = first.created.map((t) =>
    t.utr === 'UTR900006' ? Object.assign({}, t, { status: 'Successful' }) : t
  );
  const stats = Core.computeOverallStats(merged, UPI);
  assert.equal(stats.sent, 1668 + 899);
});
