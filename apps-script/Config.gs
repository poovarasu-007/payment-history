/**
 * Config.gs
 * ---------------------------------------------------------------------------
 * Application configuration + secrets handling.
 *
 * All configuration and any provider access tokens live in Google Apps Script
 * Script Properties (server-side only). Nothing sensitive is ever written to
 * a spreadsheet cell or to the browser.
 *
 * The two registered UPI IDs are identifiers used to MATCH transactions that
 * already appear in an imported statement. They are not credentials and do not
 * grant access to any bank's transaction history.
 * ---------------------------------------------------------------------------
 */

var PROP_CONFIG = 'CONFIG';
var PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';

var DEFAULT_CONFIG = {
  appName: 'UPI Payment History Dashboard',
  timezone: 'Asia/Kolkata',            // IST — fixed by the product spec
  currencySymbol: '₹',
  darkMode: false,
  pageSize: 25,
  upiIds: [
    { id: '9363610085@ptyes', label: 'UPI ID 1', enabled: true },
    { id: 'poovarasuzyra@okaxis', label: 'UPI ID 2', enabled: true }
  ],
  sync: {
    lastSync: null,
    lastStatus: 'not_connected',       // not_connected | success | error
    lastMessage: 'No authorized data source connected yet.',
    sources: []                        // [{name, type:'webhook', url, method, token, enabled}]
  }
};

var _propsCache = null;

function props() {
  if (!_propsCache) _propsCache = PropertiesService.getScriptProperties();
  return _propsCache;
}

function getConfig() {
  var cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  var raw = props().getProperty(PROP_CONFIG);
  if (raw) {
    try {
      var stored = JSON.parse(raw);
      if (stored && typeof stored === 'object') {
        if (stored.timezone) cfg.timezone = stored.timezone;
        if (typeof stored.darkMode === 'boolean') cfg.darkMode = stored.darkMode;
        if (stored.pageSize) cfg.pageSize = stored.pageSize;
        if (Array.isArray(stored.upiIds) && stored.upiIds.length) {
          cfg.upiIds = stored.upiIds.map(function (u) {
            return {
              id: String(u.id || '').trim(),
              label: u.label || u.id,
              enabled: u.enabled !== false
            };
          }).filter(function (u) { return u.id; });
        }
        if (stored.sync && typeof stored.sync === 'object') {
          cfg.sync = {
            lastSync: stored.sync.lastSync || null,
            lastStatus: stored.sync.lastStatus || 'not_connected',
            lastMessage: stored.sync.lastMessage || '',
            sources: Array.isArray(stored.sync.sources) ? stored.sync.sources : []
          };
        }
      }
    } catch (e) {
      // Corrupt config: fall back to defaults rather than crash the dashboard.
      Logger.log('Config parse error, using defaults: ' + e);
    }
  }
  return cfg;
}

function saveConfig(cfg) {
  props().setProperty(PROP_CONFIG, JSON.stringify(cfg));
  return cfg;
}

/** IST helpers used everywhere so dates/times are always stored in IST. */
function nowIst() {
  return Utilities.formatDate(new Date(), getConfig().timezone, 'yyyy-MM-dd HH:mm:ss');
}

function todayIst() {
  return Utilities.formatDate(new Date(), getConfig().timezone, 'yyyy-MM-dd');
}

function getSpreadsheetId() {
  return props().getProperty(PROP_SPREADSHEET_ID);
}

function setSpreadsheetId(id) {
  props().setProperty(PROP_SPREADSHEET_ID, id);
}

function getScriptProperty(key, fallback) {
  var v = props().getProperty(key);
  return v === null ? fallback : v;
}

function setScriptProperty(key, value) {
  props().setProperty(key, value === null || value === undefined ? '' : String(value));
}

function deleteScriptProperty(key) {
  props().deleteProperty(key);
}
