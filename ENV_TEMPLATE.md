# Configuration & Secrets Template

This project targets **Google Apps Script**, so there is no `.env` file. Configuration and any
provider secrets live in **Script Properties** (server-side, never in the spreadsheet and never
sent to the browser).

## How to set values

**Apps Script editor → ⚙ Project Settings → Script Properties → Add script property**

or programmatically from any `.gs` file:

```js
setScriptProperty('WEBAPP_URL', 'https://script.google.com/macros/s/XXXXXXXX/exec');
```

## Property keys

| Key | Required | Example | Description |
|-----|----------|---------|-------------|
| `SPREADSHEET_ID` | auto | `1AbCdEf…` | Set automatically by `getSpreadsheet()` / `setupDashboard()`. Points at the **UPI Payment History Dashboard** workbook. |
| `CONFIG` | auto | *(JSON)* | Written by the Settings screen. Contains UPI IDs, dark mode, page size and sync metadata. Do not hand-edit unless you know the shape below. |
| `WEBAPP_URL` | optional | `https://…/exec` | The deployed web-app URL, used by the spreadsheet menu's *Open dashboard* item. |

### `CONFIG` JSON shape (written for you)

```json
{
  "appName": "UPI Payment History Dashboard",
  "timezone": "Asia/Kolkata",
  "currencySymbol": "₹",
  "darkMode": false,
  "pageSize": 25,
  "upiIds": [
    { "id": "9363610085@ptyes",   "label": "UPI ID 1", "enabled": true },
    { "id": "poovarasuzyra@okaxis", "label": "UPI ID 2", "enabled": true }
  ],
  "sync": {
    "lastSync": null,
    "lastStatus": "not_connected",
    "lastMessage": "No authorized data source connected yet.",
    "sources": [
      {
        "name": "My aggregator",
        "type": "webhook",
        "url": "https://provider.example/api/transactions",
        "method": "GET",
        "token": "REPLACE_WITH_PROVIDER_TOKEN",
        "enabled": true
      }
    ]
  }
}
```

> ⚠️ **Never** put a UPI PIN, OTP, banking password, or any payment-authorization credential here
> or anywhere else. This application has no field for them and will never ask.

## `.env` equivalent for local testing (Node)

The Node test suite only exercises the pure logic in `apps-script/Core.gs` and needs no secrets:

```bash
# .env not required
npm test
```

## Secrets handled at runtime

| Secret | Where it lives | Sent to browser? |
|--------|----------------|------------------|
| Provider bearer token (if you connect a webhook) | `CONFIG.sync.sources[].token` in Script Properties | **No** — only a masked host name is exposed to the UI |
| Spreadsheet ID | Script Properties | Yes (used to build the "Open in Sheets" link) |
| UPI IDs | Script Properties | Yes (shown as identifiers only — never credentials) |
| UPI PIN / OTP / banking password | **never stored** | **never** |
