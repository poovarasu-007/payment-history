# UPI Payment History & Analytics Dashboard

An automated **UPI payment history** application that records transactions in Google Sheets,
calculates daily / monthly / yearly / overall totals, and renders interactive pie charts and
financial reports — built as a **Google Sheets + Google Apps Script** web app.

Configured UPI identifiers:

| # | UPI ID | Role |
|---|--------|------|
| 1 | `9363610085@ptyes` | Identifier used to **match** transactions |
| 2 | `poovarasuzyra@okaxis` | Identifier used to **match** transactions |

---

## ⚠️ Read this first — what a UPI ID can and cannot do

A UPI ID is **not** a credential and **cannot** read your bank's transaction history on its own.
There is no legitimate way for an app to pull your full UPI history from just an ID.

This application is therefore honest about its data sources:

- It **imports** transactions from bank statement exports (CSV / TSV / pasted spreadsheet rows),
  from optionally-configured **authorized provider webhooks**, or from **manual entry**.
- Your two UPI IDs are used **only to match and categorise** rows that already exist in an import —
  to attribute each transaction to one of your registered IDs.
- It **never** scrapes protected banking pages, **never** bypasses UPI/bank security, and
  **never** claims live access until an authorized source is actually connected.
- It **never** asks for, collects, or stores a UPI **PIN**, **OTP**, password, or any payment
  authorization credential. If any screen asks you for one, it is not this app.

The dashboard shows a **sync status pill** ("Not connected" by default) that reports the truth
about whether a live source is connected.

---

## Feature overview

### Ledger & worksheets
- One spreadsheet, **UPI Payment History Dashboard**, with five tabs:
  - **All Transactions** — the single source of truth (15 columns).
  - **Daily History** — auto-calculated daily summaries.
  - **Overall History** — lifetime, monthly, yearly and per-UPI statistics.
  - **Dashboard Data** — chart-ready summary tables.
  - **Audit Log** — append-only record of imports, edits, reversals and settings changes.
- Derived sheets are **fully rebuilt from the ledger** after every change, so totals can never drift.

### Totals (the exact rules)
- `Net Payment Flow = Total Money Received − Total Money Sent`
- Only **Successful** transactions count toward Received / Sent and their counts.
- **Pending, Failed and Reversed** transactions are stored and shown, but **excluded** from
  Received / Sent.
- **Refunds & reversals** are reported in their own column and are **never double-counted**.
- Dates and times are stored in **India Standard Time (IST)**.

### Interactive charts (auto-recalculate)
1. **Money Received vs Money Sent** — pie
2. **Payment Distribution by UPI ID** — pie with separate **Incoming / Outgoing** views
3. **Payment Categories** — pie of spending by category
4. **Daily Payment Distribution** — pie with Incoming / Outgoing toggle
5. **Daily Income vs Expense** — bar
6. **Monthly Income vs Expense** — bar
7. **Yearly Financial Overview** — bar
8. **Transaction Count by Status** — pie
9. **Running Net Payment Flow** — line

All charts use ₹ formatting, hover tooltips, legends, percentage labels, and a clear
**empty state** when there is no data.

### Range selector
Today · Yesterday · Last 7 days · Last 30 days · This month · This year · All time.
Charts and summary cards update automatically when the period changes.

### Import & automation
- CSV / Excel-exported / pasted-spreadsheet import with automatic column detection.
- Deduplication by **UTR / reference**, falling back to a composite hash of
  (date + time + amount + payee + direction) — retries and re-imports never create duplicates.
- Existing rows are **updated in place** when a status changes (e.g. Pending → Successful).
- Manual entry for corrections, clearly labelled `Manual Entry`.
- Optional **authorized webhook** sources + a 6-hour scheduled trigger.
- Reconciliation report flagging missing references, duplicate candidates, refunds,
  amount mismatches and unknown directions.

### Reports & export
- Export transactions, daily report, monthly report and reconciliation report to **CSV**
  (opens directly in Excel / Google Sheets).
- **Printable** report via the browser print dialog.
- Transaction export respects the active filters (date, UPI ID, status, type, category).

### UI
- Responsive dashboard (mobile / tablet / desktop) with a sidebar:
  Dashboard · All Transactions · Daily History · Overall History · Import Statements · Reports · Settings.
- Green = incoming, red = outgoing, blue = account/transaction info, white/light-grey cards.
- **Dark-mode** toggle.
- Search, sorting, filters, pagination and date-range selection.
- Four summary cards: **Total Received · Total Sent · Net Payment Flow · Successful Transactions**.

---

## Project layout

```
payment history/
├── apps-script/               # Everything you paste into the Apps Script editor
│   ├── appsscript.json        # Manifest (timezone IST, web-app access = myself)
│   ├── Core.gs                # Pure logic: parsing, dedupe, totals (no Apps Script APIs)
│   ├── Config.gs              # Config + secrets (Script Properties), IST helpers
│   ├── Sheets.gs              # Spreadsheet creation, ledger I/O, derived sheets, audit log
│   ├── Import.gs              # CSV import, manual entry, reversal, sync, reconciliation
│   ├── WebApp.gs              # google.script.run API + exports + print report
│   ├── Code.gs                # doGet, spreadsheet menu, triggers, diagnostics
│   ├── Tests.gs               # In-editor self-tests (runAllTests)
│   ├── Dashboard.html         # App shell / markup
│   ├── Style.html             # Styles (Tailwind + custom CSS + print styles)
│   └── Client.html            # Client-side logic + chart rendering
├── samples/
│   └── sample-statement.csv   # Example import file (clearly fake, for testing the importer)
├── tests/
│   └── core.test.js           # Node unit tests for Core.gs (26 tests)
├── package.json
├── SETUP.md                   # Step-by-step deployment & usage guide
├── ENV_TEMPLATE.md            # Configuration / secret template
└── README.md
```

`Core.gs` is deliberately free of Apps Script APIs, so the **exact same** logic is unit-tested in
Node via `tests/core.test.js`. The in-editor `runAllTests()` covers the same scenarios.

---

## Quick start

See **[SETUP.md](SETUP.md)** for full instructions. In short:

1. Create a new project at <https://script.google.com>.
2. Add each file from `apps-script/` (same names; HTML files too).
3. Run `setupDashboard()` once and authorise.
4. **Deploy → New deployment → Web app** (Execute as *Me*, Access *Only myself*) and open the URL.
5. Import a bank statement CSV (try `samples/sample-statement.csv`) or add a transaction manually.

The **two UPI IDs are pre-configured**; you can enable/disable either in **Settings**.

---

## Testing

```bash
npm test          # runs node --test tests/core.test.js  → 26 passing
```

Inside Apps Script (or the spreadsheet menu) run `runAllTests()` for the same checks.

---

## Security & privacy

- No PIN, OTP, password or payment-authorization credential is ever requested or stored.
- The web app is deployed as **Only myself** by default; change deliberately if you need sharing.
- Provider tokens and config live in **Script Properties** (server-side) and are never sent to the browser.
- The audit log records every import, manual edit, reversal and settings change.
- Integrations can be disconnected and their tokens deleted from **Settings → Disconnect**.

---

## Acceptance criteria — where each is satisfied

| # | Requirement | Where |
|---|-------------|-------|
| 1 | Both UPI IDs used for matching | `Core.matchUpiId`, `Config.gs` defaults, Settings UI |
| 2 | Verified data saved to Google Sheets | `Sheets.readLedger` / `appendTransactions` / `All Transactions` |
| 3 | No duplicate transactions on re-import | `Core.transactionKey` + `Core.reconcileImport` |
| 4 | Daily / monthly / yearly / overall totals correct | `Core.summarizeByDay`, `Core.computeOverallStats`, sheets + dashboard |
| 5 | Pie charts recalculate on data change | `getDashboardData` + `renderCharts` |
| 6 | Refunds / reversals / unsuccessful handled | status rules in `Core`; `reverseTransaction` |
| 7 | Search, filter, export | All Transactions view + `export*Csv` |
| 8 | Reports sync connected/success/failing | sync pill + `Settings → Data source` |
| 9 | Never falsely claims live UPI access | "Not connected" default + copy throughout |
| 10 | Setup instructions for Sheets + source | `SETUP.md` |
#   p a y m e n t - h i s t o r y  
 