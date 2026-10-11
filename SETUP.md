# Setup Guide

Follow these steps to deploy the UPI Payment History & Analytics Dashboard.
No prior coding experience is required, but you will need a Google account.

> **Before you start:** This app does **not** connect to your bank automatically and will
> **never** ask for a UPI PIN, OTP or banking password. You feed it bank-statement exports
> (CSV/Excel) or enter transactions manually. Your two UPI IDs are pre-configured as
> *identifiers* used to match transactions — see [README.md](README.md) for why that matters.

---

## Step 1 — Create the Apps Script project

1. Go to <https://script.google.com> and click **New project**.
2. Click the project name ("Untitled project") and rename it to **UPI Payment History Dashboard**.
3. In the left sidebar click the **gear / Project Settings** icon.
4. Tick **Show "appsscript.json" manifest file in editor**.
5. Back in **Editor**, delete the default `Code.gs` contents and add the files below.

## Step 2 — Add the source files

Create one project file per file in `apps-script/`, using **exactly the same names**:

| Create a file named | Type | Paste the contents of |
|---------------------|------|-----------------------|
| `Core` | Script (`.gs`) | `apps-script/Core.gs` |
| `Config` | Script | `apps-script/Config.gs` |
| `Sheets` | Script | `apps-script/Sheets.gs` |
| `Import` | Script | `apps-script/Import.gs` |
| `WebApp` | Script | `apps-script/WebApp.gs` |
| `Code` | Script | `apps-script/Code.gs` |
| `Tests` | Script | `apps-script/Tests.gs` |
| `Dashboard` | HTML | `apps-script/Dashboard.html` |
| `Style` | HTML | `apps-script/Style.html` |
| `Client` | HTML | `apps-script/Client.html` |

To add a file: **+ (plus) → Script** for `.gs` files, **+ → HTML** for the HTML files.
File names in Apps Script have **no extension in the editor** — the editor adds `.gs`/`.html`
automatically, so name the HTML file simply `Dashboard`, `Style`, `Client`.

Finally open `appsscript.json` and replace its contents with `apps-script/appsscript.json`.

> Tip: if you prefer, install [clasp](https://github.com/google/clasp) and
> `clasp push` the `apps-script/` folder, then `clasp deploy`. The manual method above is
> fine for a one-off setup.

## Step 3 — Initialise the spreadsheet

1. In the editor's function dropdown, select **`setupDashboard`** and click **Run**.
2. Google will ask for authorisation → **Review permissions → choose your account →
   Advanced → Go to UPI Payment History Dashboard (unsafe) → Allow**.
   (The "unsafe" warning appears because the script is unpublished; it is your own script.)
3. A spreadsheet named **UPI Payment History Dashboard** is created in your Google Drive with
   the five tabs: `All Transactions`, `Daily History`, `Overall History`, `Dashboard Data`, `Audit Log`.
4. Run **`runAllTests`** once to confirm the core logic passes (check **View → Logs** /
   **Execution log** — it reports `Self-tests: 26/26 passed`).

> Want to use an existing spreadsheet instead? Open `Config.gs`, run
> `setSpreadsheetId('<your-spreadsheet-id>')` once, then `setupDashboard()`.

## Step 4 — Deploy the web dashboard

1. Click **Deploy → New deployment**.
2. Select type **Web app**.
3. Set:
   - **Description:** `UPI dashboard`
   - **Execute as:** **Me**
   - **Who has access:** **Only myself** (recommended — this is financial data).
4. Click **Deploy**, authorise if prompted, and copy the **Web app URL** (`…/exec`).
5. Open the URL. You should see the dashboard with the "Not connected" sync pill.
6. Optional: paste that URL into Script Properties as `WEBAPP_URL` so the spreadsheet menu's
   *Open dashboard* item works (Project Settings → Script Properties → Add property).

> If you later change the code you must **Deploy → Manage deployments → Edit → Version: New version → Deploy**.

## Step 5 — Import your first statement

A UPI ID alone cannot read bank history — you provide the data. Two easy paths:

### A. Import a bank statement (recommended)
1. In your bank / UPI app, export a statement covering the period you want.
2. Keep it as **CSV** or open the Excel file in Google Sheets and use
   **File → Download → CSV**, or simply select the rows and copy them.
3. In the dashboard open **Import Statements**.
4. Drag the CSV onto the drop zone, or paste the rows (including the header row) into the text box
   and click **Import pasted rows**.
5. The importer auto-detects columns, matches your UPI IDs, removes duplicates by UTR/reference,
   and shows a summary: *new / updated / duplicates skipped / rows with errors*.

Need a file to test with? Use `samples/sample-statement.csv` — it contains clearly fake rows
and exists only to demonstrate the import.

### B. Add a transaction manually
Use **Import Statements → Manual transaction entry** for corrections or sources you cannot export.
Manual rows are labelled `Manual Entry` and written to the audit log.

### Recognised columns (any order, many spellings accepted)

| Canonical field | Example headers |
|-----------------|-----------------|
| Date (required) | `Transaction Date`, `Date`, `Value Date` |
| Amount (required) | `Amount (₹)`, `Amount`, `Amt` |
| Time | `Time`, `Transaction Time` |
| UPI ID | `Your UPI ID`, `UPI ID`, `VPA` |
| Type | `Type`, `Transaction Type`, `Cr/Dr` |
| Name | `Name`, `Payee Name`, `Payer or Payee Name`, `Merchant` |
| Counterparty UPI | `Payer or Payee UPI ID` |
| Status | `Status`, `Payment Status` |
| Category | `Category` |
| Reference | `UTR`, `Reference`, `Ref No`, `Narration` |

Dates are read as **DD/MM/YYYY** by default (Indian statements), with ISO `YYYY-MM-DD` and
`11 Jan 2026` styles also supported.

## Step 6 — Configure your UPI IDs

Open **Settings → Registered UPI IDs**. Both IDs are pre-filled:

- `9363610085@ptyes`
- `poovarasuzyra@okaxis`

Toggle **Enabled for matching** on or off and click **Save UPI settings**. A disabled ID is
ignored during matching (rows still import, but are attributed to "Unmatched" if no other ID matches).

## Step 7 — (Optional) connect an authorized source + schedule sync

Only do this if you have an **authorized** provider endpoint (e.g. an aggregator/AA gateway you
have granted consent to) that returns rows in the supported CSV format.

1. **Settings → Data source & synchronization**.
2. Enter a **source name**, an **https://** URL, and (if required) a bearer **token**, then
   **Add source**. Tokens are stored server-side in Script Properties and are never sent to the browser.
3. Click **Create 6-hour trigger** to run `scheduledSync` automatically, or **Run sync now** to test.
4. The sync pill and the panel report **Connected / Success / Error** and the last sync time.

If no source is configured the app stays honestly at **"Not connected"** and tells you to import a
statement or add transactions manually.

## Step 8 — Reports, exports and reversal

- **Reports → Export** buttons download transactions (respecting current filters), a daily report,
  a monthly report, and a reconciliation report — all as CSV that opens in Excel / Google Sheets.
- **🖨 Printable report** opens the browser print dialog with a formatted summary.
- To flag a refund/chargeback, find the transaction in **All Transactions** and click **Reverse**.
  The original record is preserved; its status becomes `Reversed` and it is excluded from Received/Sent.
- **Reports → Reconciliation** flags missing references, duplicate candidates, refunds,
  amount mismatches and unknown directions. Nothing is changed automatically.

---

## Configuration reference

All configuration lives in **Script Properties** (Project Settings → Script Properties).
See [ENV_TEMPLATE.md](ENV_TEMPLATE.md) for the keys and their defaults. You normally never need to
edit them by hand — the Settings screen writes the `CONFIG` property for you.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Could not find required column(s): date, amount" | Your CSV header is missing a recognisable date/amount column — rename it to `Date` / `Amount`. |
| Every row is "Unknown" status | Add a `Status` column, or add rows manually with an explicit status. |
| Import says rows skipped as duplicates | Working as intended — the same UTR/reference already exists. |
| Charts empty | Choose **All time** in the period selector, or import data first. |
| "Not connected" never changes | You have not added an authorized source — import statements instead. |
| Authorization screen shows "unsafe" | Expected for your own unpublished script. |
| Spreadsheet not found | Re-run `setupDashboard()` — if access was revoked a fresh spreadsheet is created. |

## Security checklist

- ✅ Deploy with **Who has access: Only myself** unless you deliberately need sharing.
- ✅ Never paste a UPI PIN, OTP or password anywhere in this app — it will never ask.
- ✅ Review the **Audit Log** periodically.
- ✅ Use **Disconnect all integrations** to remove stored tokens when you no longer need a source.
