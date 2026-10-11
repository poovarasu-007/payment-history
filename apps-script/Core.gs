/**
 * Core.gs
 * ---------------------------------------------------------------------------
 * Pure transaction-processing logic for the UPI Payment History Dashboard.
 *
 * This file intentionally uses NO Google Apps Script APIs, so the exact same
 * logic can be executed and unit-tested in Node.js (see tests/core.test.js).
 *
 * SECURITY: nothing in here reads, requests, or stores a UPI PIN, OTP,
 * password, or any payment authorization credential. UPI IDs are treated as
 * plain identifiers used only to *match* rows that already exist in an
 * imported statement / notification export.
 * ---------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  /** Payment categories used across the whole application. */
  var CATEGORIES = [
    'Food & Dining',
    'Shopping',
    'Travel',
    'Bills & Utilities',
    'Transfer',
    'Business',
    'Other'
  ];

  /** Canonical payment statuses. Anything else normalises to 'Unknown'. */
  var STATUSES = ['Successful', 'Pending', 'Failed', 'Reversed', 'Unknown'];

  /** Canonical directions. */
  var TYPES = ['Money Received', 'Money Sent', 'Unknown'];

  var MONTH_NAMES = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ---------------------------------------------------------------------- */
  /* Small helpers                                                          */
  /* ---------------------------------------------------------------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function round2(n) {
    if (n === null || n === undefined || isNaN(n)) return 0;
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  /** Deterministic 32-bit string hash (djb2), returned as hex. */
  function hashString(str) {
    var h = 5381;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(16);
  }

  function isoDate(parts) {
    return parts.y + '-' + pad2(parts.m) + '-' + pad2(parts.d);
  }

  /* ---------------------------------------------------------------------- */
  /* Parsing primitives                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Parse a monetary value out of messy statement text.
   * Returns { amount: number, sign: -1|0|1 } or null when not numeric.
   * sign: -1 = known debit/negative, 1 = known credit/positive, 0 = unknown.
   */
  function parseAmount(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var sign = 0;

    // Accounting-style negative: (1,234.56)
    if (/^\(.*\)$/.test(s)) {
      sign = -1;
      s = s.slice(1, -1).trim();
    }

    // Trailing Cr / Dr (bank statement convention)
    var mDrCr = s.match(/^(.*?)(cr|dr)\.?$/i);
    if (mDrCr) {
      s = mDrCr[1].trim();
      if (sign === 0) sign = /^dr$/i.test(mDrCr[2]) ? -1 : 1;
    }

    // Strip currency markers, thousands separators, spaces
    s = s.replace(/₹/g, '')
      .replace(/\brs\.?\b/gi, '')
      .replace(/inr/gi, '')
      .replace(/,/g, '')
      .replace(/\s+/g, '')
      .trim();

    if (/^-/.test(s)) {
      if (sign === 0) sign = -1;
      s = s.slice(1);
    } else if (/^\+/.test(s)) {
      if (sign === 0) sign = 1;
      s = s.slice(1);
    }

    if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
    var value = parseFloat(s);
    if (isNaN(value)) return null;
    return { amount: round2(value), sign: sign };
  }

  /** Normalise any provider status string to a canonical status. */
  function normalizeStatus(raw) {
    if (raw === null || raw === undefined) return 'Unknown';
    var s = String(raw).toLowerCase().replace(/[^a-z]/g, '');
    if (!s) return 'Unknown';
    if (/unpaid|notpaid|notsuccess/.test(s)) return 'Failed';
    if (/revers|refund|chargeback|returned|reversal/.test(s)) return 'Reversed';
    if (/fail|declin|reject|cancel|bounce|invalid|expired/.test(s)) return 'Failed';
    if (/success|completed|succeeded|done|paid|settled|credited|debited/.test(s)) return 'Successful';
    if (/pending|processing|waiting|initiated|queued|inprogress/.test(s)) return 'Pending';
    return 'Unknown';
  }

  /**
   * Determine direction. `signedAmount` is optional and only used when the
   * textual type is ambiguous (positive = money in, negative = money out).
   */
  function normalizeType(raw, signedAmount) {
    var t = String(raw === null || raw === undefined ? '' : raw).toLowerCase();
    if (t) {
      if (/(received|credit|inward|inflow|credited|collect|refund received|deposit)/.test(t)) {
        return 'Money Received';
      }
      if (/(sent|debit|outward|outflow|debited|paid|payment|transfer|spend|purchase|bought|withdraw|payout|bill pay)/.test(t)) {
        return 'Money Sent';
      }
    }
    if (typeof signedAmount === 'number' && !isNaN(signedAmount) && signedAmount !== 0) {
      return signedAmount < 0 ? 'Money Sent' : 'Money Received';
    }
    return 'Unknown';
  }

  /** Parse a date string to {y,m,d}; supports ISO, Indian dd/mm/yyyy and named months. */
  function parseDateParts(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var m, parts;

    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
      parts = { y: +m[1], m: +m[2], d: +m[3] };
    } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) {
      // Indian statements default to DD/MM/YYYY
      parts = { y: +m[3], m: +m[2], d: +m[1] };
    } else if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/))) {
      var mo = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()];
      if (!mo) return null;
      parts = { y: +m[3], m: mo, d: +m[1] };
    } else if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
      var mo2 = MONTH_NAMES[m[1].slice(0, 3).toLowerCase()];
      if (!mo2) return null;
      parts = { y: +m[3], m: mo2, d: +m[2] };
    } else {
      return null;
    }

    if (parts.m < 1 || parts.m > 12 || parts.d < 1 || parts.d > 31) return null;
    if (parts.y < 1900 || parts.y > 2200) return null;
    return parts;
  }

  /** Parse a time string to 'HH:mm:ss' (24h). Returns null when unparseable. */
  function parseTime(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?$/);
    if (m) {
      var h = parseInt(m[1], 10);
      var ap = m[4].toLowerCase();
      if (ap === 'p' && h < 12) h += 12;
      if (ap === 'a' && h === 12) h = 0;
      return pad2(h) + ':' + m[2] + ':' + (m[3] || '00');
    }
    m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      var hh = parseInt(m[1], 10);
      var mm = parseInt(m[2], 10);
      if (hh > 23 || mm > 59) return null;
      return pad2(hh) + ':' + m[2] + ':' + (m[3] || '00');
    }
    return null;
  }

  /** True when the string looks like a UPI VPA (name@handle). */
  function isUpiIdLike(value) {
    if (!value) return false;
    return /^[a-z0-9][a-z0-9._-]{1,}@[a-z][a-z0-9]{1,}$/i.test(String(value).trim());
  }

  /* ---------------------------------------------------------------------- */
  /* UPI identity matching                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Return the configured UPI id found inside `text`, or null.
   * Disabled ids are never matched. Matching is case-insensitive substring.
   */
  function matchUpiId(text, upiIds) {
    if (!text) return null;
    var t = String(text).toLowerCase();
    var list = upiIds || [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u || u.enabled === false || !u.id) continue;
      if (t.indexOf(String(u.id).toLowerCase()) !== -1) return u.id;
    }
    return null;
  }

  function configuredUpiIds(upiIds) {
    return (upiIds || []).filter(function (u) { return u && u.id; });
  }

  /* ---------------------------------------------------------------------- */
  /* Category inference                                                     */
  /* ---------------------------------------------------------------------- */

  var CATEGORY_KEYWORDS = [
    ['Food & Dining', ['swiggy', 'zomato', 'dominos', 'domino', 'pizza', 'cafe', 'restaurant',
      'food', 'canteen', 'bakery', 'dhaba', 'chai', 'coffee', 'starbucks', 'mcdonald',
      'kfc', 'burger', 'instamart', 'blinkit', 'zepto', 'hotel', 'dining', 'eatery']],
    ['Shopping', ['amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'shop', 'store', 'mart',
      'supermarket', 'retail', 'mall', 'fashion', 'clothing', 'lifestyle', 'dmart',
      'bigbasket', 'reliance', 'decathlon', 'nykaa', 'croma', 'electronics']],
    ['Travel', ['uber', 'ola', 'rapido', 'redbus', 'irctc', 'flight', 'airline', 'indigo',
      'airindia', 'railway', 'train', 'taxi', 'cab', 'petrol', 'fuel', 'diesel', 'toll',
      'parking', 'metro', 'makemytrip', 'goibibo', 'yatra', 'travel']],
    ['Bills & Utilities', ['electricity', 'bescom', 'power', 'jio', 'airtel', 'vodafone',
      'vi ', 'idea', 'broadband', 'recharge', 'dth', 'gas', 'water bill', 'bill', 'postpaid',
      'prepaid', 'subscription', 'netflix', 'spotify', 'prime', 'insurance', 'emi', 'loan',
      'rent', 'maintenance']],
    ['Transfer', ['transfer', 'sent to', 'upi transfer', 'friend', 'family', 'self']],
    ['Business', ['business', 'invoice', 'vendor', 'sale', 'customer', 'supplier', 'gst', 'gstn']]
  ];

  function inferCategory(text) {
    var hay = String(text || '').toLowerCase();
    if (!hay.trim()) return 'Other';
    for (var i = 0; i < CATEGORY_KEYWORDS.length; i++) {
      var cat = CATEGORY_KEYWORDS[i][0];
      var words = CATEGORY_KEYWORDS[i][1];
      for (var j = 0; j < words.length; j++) {
        var w = words[j].trim();
        if (!w) continue;
        var re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i');
        if (re.test(hay)) return cat;
      }
    }
    return 'Other';
  }

  /* ---------------------------------------------------------------------- */
  /* Deduplication keying                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * A stable identity for a transaction.
   * Preference order: UTR / bank reference, then Transaction ID, then a hash
   * over (date, time, amount, counterparty, direction).
   */
  function transactionKey(t) {
    var ref = String((t && (t.utr || t.transactionId)) || '').trim().toUpperCase();
    if (ref) return 'REF:' + ref;
    var composite = [
      t.date || '',
      t.time || '',
      round2(t.amount || 0),
      String(t.counterparty || '').toLowerCase(),
      t.type || ''
    ].join('|');
    return 'CMP:' + hashString(composite);
  }

  /* ---------------------------------------------------------------------- */
  /* CSV parsing + column mapping                                           */
  /* ---------------------------------------------------------------------- */

  /** Generic delimited-field parser (delimiter is one character). */
  function splitDelimited(text, delimiter) {
    var s = String(text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;

    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (c === '\r') {
        // ignore; \r\n handled by \n
      } else {
        field += c;
      }
    }
    row.push(field);
    rows.push(row);

    // drop fully empty rows
    return rows.filter(function (r) {
      return r.some(function (f) { return String(f).trim() !== ''; });
    });
  }

  /** RFC-4180-ish CSV parser. Returns an array of arrays. */
  function parseCsv(text) {
    if (text === null || text === undefined) return [];
    return splitDelimited(text, ',');
  }

  /**
   * Auto-detect the delimiter. Google Sheets / Excel "copy" produces
   * tab-separated data; bank CSV exports are comma-separated. We compare the
   * first non-empty line so a TSV containing "1,234.00" is still treated as TSV.
   */
  function parseDelimited(text) {
    if (text === null || text === undefined) return [];
    var lines = String(text).split(/\r?\n/);
    var firstLine = '';
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') { firstLine = lines[i]; break; }
    }
    var tabs = (firstLine.match(/\t/g) || []).length;
    var commas = (firstLine.match(/,/g) || []).length;
    if (tabs > 0 && tabs >= commas) return splitDelimited(text, '\t');
    return splitDelimited(text, ',');
  }

  var COLUMN_ALIASES = {
    transactionId: ['transaction id', 'txn id', 'transactionid', 'txn no', 'sr no', 's no', 'sno', 'id'],
    date: ['transaction date', 'txn date', 'date of transaction', 'value date', 'posting date', 'date'],
    time: ['transaction time', 'txn time', 'time of transaction', 'time'],
    upiId: ['your upi id', 'my upi id', 'account upi id', 'upi id', 'vpa'],
    type: ['transaction type', 'txn type', 'credit/debit', 'cr/dr', 'direction', 'type'],
    counterparty: ['payer or payee name', 'payee name', 'payer name', 'party name',
      'counterparty', 'beneficiary', 'merchant', 'name', 'to', 'from'],
    counterpartyUpi: ['payer or payee upi id', 'counterparty upi', 'payee upi', 'payer upi',
      'beneficiary upi', 'upi of payee'],
    amount: ['amount (₹)', 'transaction amount', 'amount', 'amt', 'value'],
    status: ['payment status', 'transaction status', 'txn status', 'status'],
    category: ['payment category', 'category'],
    utr: ['payment reference / utr', 'transaction reference', 'reference number', 'ref no',
      'reference', 'utr', 'rrn', 'narration'],
    method: ['payment method', 'method', 'mode'],
    source: ['transaction source', 'source'],
    notes: ['notes', 'note', 'description', 'remarks', 'details']
  };

  var ALIAS_INDEX = (function () {
    var pairs = [];
    Object.keys(COLUMN_ALIASES).forEach(function (field) {
      COLUMN_ALIASES[field].forEach(function (alias) {
        pairs.push({ field: field, alias: alias.replace(/[\s_]+/g, '').toLowerCase() });
      });
    });
    // Longest alias first so specific names win over generic ones ('id', 'name').
    pairs.sort(function (a, b) { return b.alias.length - a.alias.length; });
    return pairs;
  })();

  /**
   * Map a header row to canonical field indexes.
   * Returns {date:0, amount:2, ...} or {error: '...'}.
   */
  function detectColumns(headerRow) {
    var map = {};
    var used = {};
    (headerRow || []).forEach(function (hRaw, i) {
      var h = String(hRaw || '').toLowerCase().replace(/[\s_]+/g, '');
      if (!h) return;
      for (var k = 0; k < ALIAS_INDEX.length; k++) {
        var p = ALIAS_INDEX[k];
        if (used[p.field]) continue;
        if (h === p.alias || h.indexOf(p.alias) !== -1) {
          map[p.field] = i;
          used[p.field] = true;
          break;
        }
      }
    });
    var missing = [];
    if (map.date === undefined) missing.push('date');
    if (map.amount === undefined) missing.push('amount');
    if (missing.length) {
      return {
        error: 'Could not find required column(s): ' + missing.join(', ') +
          '. Detected headers: ' + (headerRow || []).join(' | ')
      };
    }
    return map;
  }

  /**
   * Turn one raw CSV row into a normalised transaction object.
   * Returns {error:'...'} when required values are missing/invalid.
   */
  function normalizeRow(row, map, upiIds, defaults) {
    defaults = defaults || {};
    function get(field) {
      var idx = map[field];
      if (idx === undefined || idx === null) return '';
      return String(row[idx] === null || row[idx] === undefined ? '' : row[idx]).trim();
    }

    var amountInfo = parseAmount(get('amount'));
    if (!amountInfo || amountInfo.amount === null) {
      return { error: 'Invalid or missing amount: "' + get('amount') + '"' };
    }
    var dateParts = parseDateParts(get('date'));
    if (!dateParts) {
      return { error: 'Invalid or missing date: "' + get('date') + '"' };
    }

    var time = parseTime(get('time')) || '00:00:00';
    var status = normalizeStatus(get('status'));
    var signed = amountInfo.sign === 0 ? null : amountInfo.sign * amountInfo.amount;
    var type = normalizeType(get('type'), signed);

    var counterparty = get('counterparty');
    var counterpartyUpi = get('counterpartyUpi');
    if (!counterpartyUpi && isUpiIdLike(counterparty)) counterpartyUpi = counterparty;

    var ownUpiField = get('upiId');
    var matched =
      matchUpiId(ownUpiField, upiIds) ||
      matchUpiId(counterpartyUpi, upiIds) ||
      matchUpiId(counterparty, upiIds);

    var upiId = matched;
    if (!upiId && isUpiIdLike(ownUpiField)) upiId = ownUpiField;
    if (!upiId && isUpiIdLike(counterpartyUpi)) upiId = counterpartyUpi;

    var transactionId = get('transactionId');
    var utr = get('utr') || transactionId;

    var category = get('category');
    if (CATEGORIES.indexOf(category) === -1) {
      category = inferCategory(counterparty + ' ' + get('notes'));
    }

    var method = get('method');
    if (!method && (matched || isUpiIdLike(ownUpiField) || isUpiIdLike(counterpartyUpi))) {
      method = 'UPI';
    }

    return {
      transactionId: transactionId,
      date: isoDate(dateParts),
      time: time,
      upiId: upiId || '',
      type: type,
      counterparty: counterparty,
      counterpartyUpi: counterpartyUpi,
      amount: amountInfo.amount,
      status: status,
      category: category,
      utr: utr,
      method: method,
      source: defaults.source || 'CSV Import',
      notes: get('notes')
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Reconciliation / dedupe                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Compare incoming transactions against the existing ledger.
   * Returns { created:[], updated:[{key, existing, txn}], skipped:[] }.
   * Duplicates inside the same batch are also collapsed.
   */
  function reconcileImport(existing, incoming) {
    var index = {};
    (existing || []).forEach(function (t) { index[transactionKey(t)] = t; });

    var result = { created: [], updated: [], skipped: [] };
    (incoming || []).forEach(function (t) {
      var key = transactionKey(t);
      var ex = index[key];
      if (!ex) {
        result.created.push(t);
        index[key] = t;
        return;
      }
      var changed = ex.status !== t.status ||
        round2(ex.amount) !== round2(t.amount) ||
        String(ex.category || '') !== String(t.category || '');
      if (changed) {
        result.updated.push({ key: key, existing: ex, txn: t });
        index[key] = t;
      } else {
        result.skipped.push(t);
      }
    });
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* Aggregation                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Group transactions by date.
   * Only Successful rows count toward received/sent. Reversed rows are summed
   * into `refunds` and excluded from received/sent to avoid double counting.
   */
  function summarizeByDay(txns) {
    var map = {};
    (txns || []).forEach(function (t) {
      if (!t || !t.date) return;
      var d = map[t.date] || (map[t.date] = {
        date: t.date,
        received: 0,
        sent: 0,
        incomingCount: 0,
        outgoingCount: 0,
        refunds: 0,
        net: 0,
        totalCount: 0
      });
      d.totalCount++;
      if (t.status === 'Reversed') { d.refunds += t.amount; return; }
      if (t.status !== 'Successful') return;
      if (t.type === 'Money Received') { d.received += t.amount; d.incomingCount++; }
      else if (t.type === 'Money Sent') { d.sent += t.amount; d.outgoingCount++; }
    });

    return Object.keys(map).sort().map(function (k) {
      var d = map[k];
      d.received = round2(d.received);
      d.sent = round2(d.sent);
      d.refunds = round2(d.refunds);
      d.net = round2(d.received - d.sent);
      return d;
    });
  }

  /**
   * Lifetime statistics plus monthly / yearly breakdown and per-UPI totals.
   * `upiIds` is the configured list so disabled/unused IDs still appear.
   */
  function computeOverallStats(txns, upiIds) {
    var stats = {
      received: 0, sent: 0, net: 0, refunds: 0,
      incomingCount: 0, outgoingCount: 0,
      totalCount: (txns || []).length, successfulCount: 0,
      avgIncoming: 0, avgOutgoing: 0, maxIncoming: 0, maxOutgoing: 0,
      byUpi: [], monthly: [], yearly: []
    };

    var upiStats = {};
    configuredUpiIds(upiIds).forEach(function (u) {
      upiStats[u.id] = {
        id: u.id, label: u.label || u.id, enabled: u.enabled !== false,
        incomingCount: 0, incomingTotal: 0, outgoingCount: 0, outgoingTotal: 0
      };
    });
    var unmatched = null;

    var monthly = {};
    var yearly = {};

    (txns || []).forEach(function (t) {
      if (!t || !t.date) return;
      if (t.status === 'Reversed') { stats.refunds += t.amount; }
      if (t.status !== 'Successful') return;

      stats.successfulCount++;
      var mKey = t.date.slice(0, 7);
      var yKey = t.date.slice(0, 4);
      var m = monthly[mKey] || (monthly[mKey] = { month: mKey, received: 0, sent: 0, net: 0, count: 0 });
      var y = yearly[yKey] || (yearly[yKey] = { year: yKey, received: 0, sent: 0, net: 0, count: 0 });
      m.count++; y.count++;

      var bucket;
      if (upiStats[t.upiId]) bucket = upiStats[t.upiId];
      else {
        if (!unmatched) unmatched = { id: 'Unmatched', label: 'Unmatched / Imported', enabled: false, incomingCount: 0, incomingTotal: 0, outgoingCount: 0, outgoingTotal: 0 };
        bucket = unmatched;
      }

      if (t.type === 'Money Received') {
        stats.received += t.amount; stats.incomingCount++;
        m.received += t.amount; y.received += t.amount;
        bucket.incomingCount++; bucket.incomingTotal += t.amount;
        if (t.amount > stats.maxIncoming) stats.maxIncoming = t.amount;
      } else if (t.type === 'Money Sent') {
        stats.sent += t.amount; stats.outgoingCount++;
        m.sent += t.amount; y.sent += t.amount;
        bucket.outgoingCount++; bucket.outgoingTotal += t.amount;
        if (t.amount > stats.maxOutgoing) stats.maxOutgoing = t.amount;
      }
    });

    stats.received = round2(stats.received);
    stats.sent = round2(stats.sent);
    stats.refunds = round2(stats.refunds);
    stats.net = round2(stats.received - stats.sent);
    stats.avgIncoming = stats.incomingCount ? round2(stats.received / stats.incomingCount) : 0;
    stats.avgOutgoing = stats.outgoingCount ? round2(stats.sent / stats.outgoingCount) : 0;

    stats.byUpi = Object.keys(upiStats).map(function (k) {
      var u = upiStats[k];
      u.incomingTotal = round2(u.incomingTotal);
      u.outgoingTotal = round2(u.outgoingTotal);
      return u;
    });
    if (unmatched) {
      unmatched.incomingTotal = round2(unmatched.incomingTotal);
      unmatched.outgoingTotal = round2(unmatched.outgoingTotal);
      stats.byUpi.push(unmatched);
    }

    stats.monthly = Object.keys(monthly).sort().map(function (k) {
      var m = monthly[k];
      m.received = round2(m.received); m.sent = round2(m.sent);
      m.net = round2(m.received - m.sent);
      return m;
    });
    stats.yearly = Object.keys(yearly).sort().map(function (k) {
      var y = yearly[k];
      y.received = round2(y.received); y.sent = round2(y.sent);
      y.net = round2(y.received - y.sent);
      return y;
    });

    return stats;
  }

  /* ---------------------------------------------------------------------- */
  /* Date-range filtering                                                   */
  /* ---------------------------------------------------------------------- */

  function toUtcDate(iso) {
    var p = String(iso).split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }

  function addDays(iso, n) {
    var d = toUtcDate(iso);
    d.setUTCDate(d.getUTCDate() + n);
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth() + 1;
    var dd = d.getUTCDate();
    return y + '-' + pad2(m) + '-' + pad2(dd);
  }

  /** Inclusive {from,to} date bounds for a named range. `today` = 'yyyy-mm-dd'. */
  function rangeBounds(rangeKey, today) {
    if (!today) return { from: null, to: null };
    switch (rangeKey) {
      case 'today': return { from: today, to: today };
      case 'yesterday': { var y = addDays(today, -1); return { from: y, to: y }; }
      case 'last7': return { from: addDays(today, -6), to: today };
      case 'last30': return { from: addDays(today, -29), to: today };
      case 'month': return { from: today.slice(0, 7) + '-01', to: today };
      case 'year': return { from: today.slice(0, 4) + '-01-01', to: today };
      case 'all': return { from: null, to: null };
      default: return { from: null, to: null };
    }
  }

  function filterByRange(txns, rangeKey, today) {
    var b = rangeBounds(rangeKey, today);
    if (!b.from && !b.to) return (txns || []).slice();
    return (txns || []).filter(function (t) {
      if (!t || !t.date) return false;
      if (b.from && t.date < b.from) return false;
      if (b.to && t.date > b.to) return false;
      return true;
    });
  }

  function formatDateShort(iso) {
    var p = String(iso).split('-');
    if (p.length < 3) return iso;
    return (+p[2]) + ' ' + MONTH_SHORT[+p[1] - 1];
  }

  function formatMonthShort(key) {
    var p = String(key).split('-');
    if (p.length < 2) return key;
    return MONTH_SHORT[+p[1] - 1] + ' ' + p[0];
  }

  /* ---------------------------------------------------------------------- */
  /* Reconciliation report                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Flag data-quality issues a human should review. Never mutates records.
   */
  function findReconciliationIssues(txns) {
    var issues = [];
    var seenComposite = {};
    var refAmounts = {};

    (txns || []).forEach(function (t) {
      if (!t) return;
      var ref = String(t.utr || '').trim();

      if (t.status === 'Successful' && !ref && !String(t.transactionId || '').trim()) {
        issues.push({
          type: 'missing-reference',
          date: t.date, amount: t.amount, counterparty: t.counterparty,
          message: 'Successful transaction has no UTR / reference number'
        });
      }

      if (ref) {
        var existing = refAmounts[ref.toUpperCase()];
        if (existing !== undefined && round2(existing) !== round2(t.amount)) {
          issues.push({
            type: 'amount-mismatch',
            date: t.date, amount: t.amount, counterparty: t.counterparty,
            message: 'Reference ' + ref + ' appears with two different amounts (' +
              existing + ' vs ' + t.amount + ')'
          });
        }
        refAmounts[ref.toUpperCase()] = t.amount;
      }

      if (t.type === 'Unknown') {
        issues.push({
          type: 'unknown-direction',
          date: t.date, amount: t.amount, counterparty: t.counterparty,
          message: 'Could not determine whether money was received or sent'
        });
      }

      if (t.status === 'Reversed') {
        issues.push({
          type: 'refund-reversal',
          date: t.date, amount: t.amount, counterparty: t.counterparty,
          message: 'Reversed / refunded transaction (excluded from received and sent totals)'
        });
      }

      var comp = [t.date, round2(t.amount), String(t.counterparty || '').toLowerCase()].join('|');
      if (seenComposite[comp]) {
        issues.push({
          type: 'duplicate-candidate',
          date: t.date, amount: t.amount, counterparty: t.counterparty,
          message: 'Another transaction on the same date for the same amount and payee exists — confirm it is not a duplicate'
        });
      }
      seenComposite[comp] = true;
    });

    return issues;
  }

  /* ---------------------------------------------------------------------- */
  /* Manual entry validation                                                */
  /* ---------------------------------------------------------------------- */

  function validateManualTxn(fields) {
    fields = fields || {};
    var errors = [];
    if (!parseDateParts(fields.date)) errors.push('A valid date (yyyy-mm-dd) is required');
    var amount = parseAmount(fields.amount);
    if (!amount || amount.amount === null || amount.amount <= 0) errors.push('A positive amount is required');
    if (TYPES.indexOf(fields.type) === -1 || fields.type === 'Unknown') {
      errors.push('Transaction type must be "Money Received" or "Money Sent"');
    }
    if (fields.status && STATUSES.indexOf(fields.status) === -1) {
      errors.push('Unknown status "' + fields.status + '"');
    }
    if (fields.category && CATEGORIES.indexOf(fields.category) === -1) {
      errors.push('Unknown category "' + fields.category + '"');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------------------------------------------------------------------- */
  /* CSV export                                                             */
  /* ---------------------------------------------------------------------- */

  function csvEscape(value) {
    var s = value === null || value === undefined ? '' : String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(headers, rows) {
    var lines = [(headers || []).map(csvEscape).join(',')];
    (rows || []).forEach(function (r) {
      lines.push((r || []).map(csvEscape).join(','));
    });
    return lines.join('\r\n');
  }

  /* ---------------------------------------------------------------------- */
  /* Exports                                                                */
  /* ---------------------------------------------------------------------- */

  var api = {
    CATEGORIES: CATEGORIES,
    STATUSES: STATUSES,
    TYPES: TYPES,
    COLUMN_ALIASES: COLUMN_ALIASES,

    pad2: pad2,
    round2: round2,
    hashString: hashString,

    parseAmount: parseAmount,
    normalizeStatus: normalizeStatus,
    normalizeType: normalizeType,
    parseDateParts: parseDateParts,
    parseTime: parseTime,
    isUpiIdLike: isUpiIdLike,

    matchUpiId: matchUpiId,
    inferCategory: inferCategory,
    transactionKey: transactionKey,

    parseCsv: parseCsv,
    parseDelimited: parseDelimited,
    detectColumns: detectColumns,
    normalizeRow: normalizeRow,

    reconcileImport: reconcileImport,
    summarizeByDay: summarizeByDay,
    computeOverallStats: computeOverallStats,

    rangeBounds: rangeBounds,
    filterByRange: filterByRange,
    addDays: addDays,
    formatDateShort: formatDateShort,
    formatMonthShort: formatMonthShort,

    findReconciliationIssues: findReconciliationIssues,
    validateManualTxn: validateManualTxn,
    toCsv: toCsv
  };

  root.Core = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
