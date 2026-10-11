/* tools/build-preview.js
 * ---------------------------------------------------------------------------
 * Assembles a self-contained static preview of the dashboard:
 *   apps-script/Dashboard.html + Style.html + Client.html + preview-mock.js
 *   -> preview/dashboard-preview.html
 *
 * The preview shows the real UI with clearly-fake demo data (the sample
 * statement). It is a convenience for looking at the interface before
 * deploying; it is NOT the application and must not be used with real data.
 *
 * Run:  node tools/build-preview.js
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'apps-script');

const dashboard = fs.readFileSync(path.join(appDir, 'Dashboard.html'), 'utf8');
const style = fs.readFileSync(path.join(appDir, 'Style.html'), 'utf8');
const client = fs.readFileSync(path.join(appDir, 'Client.html'), 'utf8');
const mock = fs.readFileSync(path.join(__dirname, 'preview-mock.js'), 'utf8');

const banner =
  '<div style="background:#b45309;color:#fff;text-align:center;padding:8px 12px;font:600 13px system-ui">' +
  'PREVIEW — sample data only. The real app is deployed to your own Google account. No PIN/OTP is ever used.' +
  '</div>\n';

let html = dashboard
  .replace("<?!= include('Style'); ?>", style)
  .replace("<?!= include('Client'); ?>", '<script>\n' + mock + '\n</script>\n' + client)
  .replace('<div id="app" class="min-h-screen">', banner + '<div id="app" class="min-h-screen">');

const outDir = path.join(root, 'preview');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'dashboard-preview.html');
fs.writeFileSync(outFile, html, 'utf8');

console.log('Preview written to ' + path.relative(root, outFile) + ' (' + html.length + ' bytes)');
