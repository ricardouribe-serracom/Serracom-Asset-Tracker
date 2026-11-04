/**
 * Serracom Inventory Tracker — radio inventory, installs and red tags.
 *
 * Setup (once): make a NEW blank Google Sheet for the app (your shared sheet stays
 * untouched). Paste this file as Code.gs and the page as Index.html, save, then run
 * setupTabs (pick it next to the Run button). Add everyone to the Team tab, then
 * Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 *
 * Script properties (Project Settings → Script properties):
 *   DATA_SHEET_ID – the ID (or full link) of the sheet the app reads and writes.
 *                   Unset: the sheet this script is attached to.
 *
 * Sign-in: people enter their email, get a 6-digit code by email, and stay signed in
 * on that phone. Only emails on the Team tab can sign in. Removing someone from the
 * Team tab signs them out everywhere. Role "Manager" can mark orders submitted and
 * move any radio anywhere.
 */

var MARKETS = {
  AU: { name: 'AU', tags: 'AU Virtual Red Tag', bad: 'AU Bad Radios - VRT', inv: 'AU Inventory', moves: 'AU Inventory Tracker', store: 'AU WAREHOUSE' },
  HN: { name: 'HN', tags: 'HN Virtual Red Tag', bad: 'HN Bad Radios - VRT', inv: 'HN Inventory', moves: 'HN Inventory Tracker', store: 'HN WAREHOUSE' }
};
var TEAM_TAB = 'Team';
var TEAM_HEADERS = ['EMAIL', 'NAME', 'MARKET', 'TRUCK', 'ROLE'];
var PHOTO_FOLDER = 'Serracom Inventory Tracker Photos';
var INV_HEADERS = ['STATUS', 'RADIO', 'NOTES', 'LOCATION', 'SERIAL NUMBER', 'SCANNED SN', 'ASSET NUMBER', 'SCANNED ASSET', 'DATE OF SCAN', 'PRODUCT CODE', 'LAST MOVED BY', 'LAST MOVED'];
var MOVE_HEADERS = ['Timestamp', 'Transfer Location', 'Serial Number', 'Serial Number Picture', 'Asset Number', 'Asset Number Picture', 'Notes', 'Site ID if Installed', 'Radio Name', 'RADIO', 'MOVED BY'];
var SESSION_DAYS = 120;
var APP_VERSION = '2026-11-04';
var SETTINGS_TAB = 'Settings';
var SITES_TAB = 'Sites';
var SITE_AREAS = { AU: 'Austin', CC: 'Corpus', SA: 'San Antonio', TK: 'Waco', WA: 'Waco', DA: 'Dallas' };

/* ---------- page ---------- */
function doGet(e) {
  if (e && e.parameter && e.parameter.ping) {   // setup check: open …/exec?ping=1 in a browser
    var info = { ok: true, app: 'Serracom Inventory Tracker', sheet: '' };
    info.version = APP_VERSION;
    try { var bk = book_(), st = bk.getSheetByName(SITES_TAB), tm = bk.getSheetByName(TEAM_TAB);
      info.sheet = bk.getName(); info.sites = st ? Math.max(0, st.getLastRow() - 1) : 'no Sites tab (run setupTabs)'; info.team = tm ? Math.max(0, tm.getLastRow() - 1) : 0;
    } catch (err) { info.ok = false; info.error = String(err.message || err); }
    return ContentService.createTextOutput(JSON.stringify(info)).setMimeType(ContentService.MimeType.JSON);
  }
  var out = HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Serracom Inventory Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  var icon = prop_('ICON_URL');
  if (icon) { try { out.setFaviconUrl(icon); } catch (e) { /* the page still works without an icon */ } }
  return out;
}

/* ---------- API for the home-screen app ---------- */
// The app sends {fn, args, id} and gets {ok, val} or {ok:false, error} back.
// GitHub Pages posts it as plain text (no CORS preflight); the Google-hosted page calls api() directly.
// id: saves made offline are retried; the same id is never applied twice.
var API_FNS = {
  getData: function (a) { return getData(a[0], a[1]); },
  requestCode: function (a) { return requestCode(a[0]); },
  verifyCode: function (a) { return verifyCode(a[0], a[1]); },
  signOut: function (a) { return signOut(a[0]); },
  submitRedTag: function (a) { return submitRedTag(a[0], a[1]); },
  setOrdered: function (a) { return setOrdered(a[0], a[1], a[2], a[3], a[4]); },
  receiveOrder: function (a) { return receiveOrder(a[0], a[1], a[2], a[3], a[4]); },
  transferRadio: function (a) { return transferRadio(a[0], a[1], a[2]); },
  installRadio: function (a) { return installRadio(a[0], a[1], a[2]); },
  markBad: function (a) { return markBad(a[0], a[1], a[2], a[3], a[4]); },
  moveRadio: function (a) { return moveRadio(a[0], a[1], a[2], a[3], a[4], a[5], a[6]); },
  moveMarket: function (a) { return moveMarket(a[0], a[1], a[2]); }
};
function api(body) {
  var out, req, cache, key;
  try {
    req = typeof body === 'string' ? JSON.parse(body) : body;
    var fn = API_FNS.hasOwnProperty(req.fn) ? API_FNS[req.fn] : null;
    if (!fn) throw new Error('BAD_FN');
    if (req.id) {
      cache = CacheService.getScriptCache(); key = 'req_' + String(req.id).replace(/[^\w-]/g, '').slice(0, 60);
      var seen = cache.get(key);
      if (seen) return seen;
    }
    out = JSON.stringify({ ok: true, val: fn(req.args || []) });
    if (key) cache.put(key, out, 21600);
  } catch (err) {
    out = JSON.stringify({ ok: false, error: String(err && err.message || err) });
  }
  return out;
}
function doPost(e) {
  return ContentService.createTextOutput(api(e.postData.contents)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- sign-in ---------- */
/** Emails a 6-digit code to someone on the Team tab. */
function requestCode(email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('BAD_EMAIL');
  var member = teamMember_(book_(), email);
  if (!member) throw new Error('NOT_ON_TEAM');
  var cache = CacheService.getScriptCache();
  if (cache.get('wait_' + email)) throw new Error('WAIT');
  var code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 1000000);
  while (code.length < 6) code = '0' + code;
  cache.put('code_' + email, JSON.stringify({ code: code, tries: 0 }), 600);
  cache.put('wait_' + email, '1', 45);
  MailApp.sendEmail({
    to: email,
    subject: 'Serracom Inventory Tracker sign-in code: ' + code,
    name: 'Serracom Inventory Tracker',
    body: 'Hi ' + member.name + ',\n\nYour sign-in code is ' + code + '. It expires in 10 minutes.\n\nIf you didn\'t ask for this, you can ignore this email.'
  });
  return JSON.stringify({ ok: true });
}

/** Checks the code and returns a session token that keeps this phone signed in. */
function verifyCode(email, code) {
  email = String(email || '').trim().toLowerCase();
  code = String(code || '').replace(/\D/g, '');
  var cache = CacheService.getScriptCache(), raw = cache.get('code_' + email);
  if (!raw) throw new Error('CODE_EXPIRED');
  var c = JSON.parse(raw);
  if (c.code !== code) {
    c.tries++;
    if (c.tries >= 5) { cache.remove('code_' + email); throw new Error('TOO_MANY'); }
    cache.put('code_' + email, JSON.stringify(c), 600);
    throw new Error('BAD_CODE');
  }
  cache.remove('code_' + email);
  var member = teamMember_(book_(), email);
  if (!member) throw new Error('NOT_ON_TEAM');
  var props = PropertiesService.getScriptProperties(), now = Date.now();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {   // tidy up expired sessions
    if (k.indexOf('tok_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('tok_' + token, JSON.stringify({ email: email, exp: now + SESSION_DAYS * 864e5 }));
  return JSON.stringify({ token: token, user: member });
}

function signOut(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty('tok_' + token);
  return JSON.stringify({ ok: true });
}

/** The signed-in team member for a token, or an AUTH error. */
function who_(ss, token) {
  var raw = token ? prop_('tok_' + token) : null;
  if (!raw) throw new Error('AUTH');
  var s = JSON.parse(raw);
  if (s.exp < Date.now()) { PropertiesService.getScriptProperties().deleteProperty('tok_' + token); throw new Error('AUTH'); }
  var m = teamMember_(ss, s.email);
  if (!m) throw new Error('AUTH');
  return m;
}
/** Managers helping a lead: act with that lead's truck; the manager is still the one recorded. */
function actAs_(ss, user, asEmail) {
  if (!asEmail || user.role !== 'MANAGER') return user;
  var m = teamMember_(ss, asEmail);
  if (!m || m.email === user.email) return user;
  return { email: user.email, name: user.name, market: m.market, truck: m.truck, role: 'LEAD', forName: m.name, forEmail: m.email };
}
function byLine_(user) { return user.email + (user.forName ? ' (for ' + user.forName + ')' : ''); }
function requireManager_(m) { if (m.role !== 'MANAGER') throw new Error('MANAGERS_ONLY'); }

function readTeam_(ss) {
  var sh = ss.getSheetByName(TEAM_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  var h = headers_(sh), rows = sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues();
  var col = function (n) { return h.indexOf(n); };
  return rows.map(function (r) {
    var email = String(r[col('EMAIL')] || '').trim().toLowerCase();
    if (!email) return null;
    var name = String(r[col('NAME')] || '').trim() || email.split('@')[0];
    var market = String(r[col('MARKET')] || '').trim().toUpperCase();
    var truck = String(r[col('TRUCK')] || '').trim().toUpperCase();
    var role = String(r[col('ROLE')] || '').trim().toUpperCase() === 'MANAGER' ? 'MANAGER' : 'LEAD';
    return { email: email, name: name, market: MARKETS[market] ? market : 'BOTH', truck: truck, role: role };
  }).filter(Boolean);
}
function teamMember_(ss, email) {
  email = String(email || '').toLowerCase();
  return readTeam_(ss).filter(function (m) { return m.email === email; })[0] || null;
}

/* ---------- reads ---------- */
function getData(token, sitesKey) {
  var ss = book_(), user = who_(ss, token), sk = sitesKey_(ss);
  var out = { user: user, team: readTeam_(ss).map(function (m) { return { email: m.email, name: m.name, truck: m.truck, market: m.market, role: m.role }; }),
    lookup: readTab_(ss, 'Lookup'), settings: readTab_(ss, SETTINGS_TAB), sites: sitesKey && sitesKey === sk ? null : readTab_(ss, SITES_TAB), sitesKey: sk, markets: {}, locations: {}, models: [], tz: ss.getSpreadsheetTimeZone(), book: ss.getName() };
  Object.keys(MARKETS).forEach(function (m) {
    var c = MARKETS[m];
    out.markets[m] = { tags: readTab_(ss, c.tags), bad: readTab_(ss, c.bad), inv: readTab_(ss, c.inv) };
    out.locations[m] = listFromValidation_(ss, c.inv, 'D2');
  });
  out.models = listFromValidation_(ss, MARKETS.AU.inv, 'B3');
  return JSON.stringify(out);
}

/** Changes when the Sites tab changes, so phones only download the (long) site list when they need to. */
function sitesKey_(ss) {
  var sh = ss.getSheetByName(SITES_TAB);
  if (!sh) return '';
  var n = sh.getLastRow();
  return n + ':' + (n > 1 ? String(sh.getRange(n, 1).getValue()) : '');
}
function readTab_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return null;
  var last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 1 || cols < 1) return [];
  var values = sh.getRange(1, 1, last, cols).getValues();
  var end = values.length;   // drop trailing rows that hold nothing but unticked boxes
  while (end > 1 && values[end - 1].every(function (v) { return v === '' || v === false || v === null; })) end--;
  return values.slice(0, end).map(function (r) {
    return r.map(function (v) { return v instanceof Date ? v.toISOString() : v; });
  });
}

function listFromValidation_(ss, tab, a1) {
  var sh = ss.getSheetByName(tab);
  if (!sh) return [];
  var dv = sh.getRange(a1).getDataValidation();
  if (!dv || dv.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) return [];
  return (dv.getCriteriaValues()[0] || []).map(String);
}

/* ---------- red tags ---------- */
/** Logs a red tag and moves the pulled radio to the lead's truck (or the shop) as bad. */
function submitRedTag(token, f) {
  var ss = book_(), user = actAs_(ss, who_(ss, token), f.as), c = market_(f.market);
  if (user.forName) f.notes = (f.notes ? f.notes + ' · ' : '') + 'Logged by ' + user.name + ' for ' + user.forName;
  ['site', 'ticket', 'model', 'badSn', 'reason', 'notes'].forEach(function (k) {
    if (!String(f[k] || '').trim()) throw new Error('MISSING:' + k);
  });
  var photoBad = f.photoBad ? savePhoto_(f.photoBad, f.site + ' ' + f.badSn + ' pulled') : '';
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(c.tags);
    if (!sh) throw new Error('NO_TAB:' + c.tags);
    var h = headers_(sh), row = blankRow_(h.length);
    var put = function (names, value) { var i = findCol_(h, names); if (i >= 0) row[i] = value; };
    var notesCol = h.findIndex(function (x) { return x.indexOf('ALARM NOTES') === 0; });
    put(['TIMESTAMP'], new Date());
    put(['RADIO'], f.model);
    put(['SITE ID'], f.site);
    put(['INC #', 'INC # / TT NUMBER'], f.ticket);
    put(['SERIAL NUMBER OR ASSET IF NO SN', 'SERIAL NUMBER'], f.badSn);
    put(['FAILURE REASON'], notesCol < 0 && f.notes ? f.reason + ' · ' + f.notes : f.reason);
    put(['ASSET NUMBER'], f.asset || '');
    if (f.market === 'HN') put(['STATUS'], 'Bad');
    put(['SERIAL NUMBER PICTURE OR ASSET IF NO SN', 'SERIAL NUMBER PICTURE'], photoBad);
    put(['EMAIL ADDRESS'], user.email);
    if (notesCol >= 0) row[notesCol] = f.notes || '';
    var r = nextRow_(sh, 1);
    sh.getRange(r, 1, 1, row.length).setValues([row]);
    // the pulled radio leaves the site: it's now bad and riding with whoever pulled it
    var box = !!f.box || /BAD OUT THE BOX/i.test(String(f.reason));
    addSite_(ss, f.site, f.market, user);
    var inv = pullToInventory_(ss, user, c, { sn: f.badSn, model: f.model, asset: f.asset, site: f.site, status: box ? 'BAD OUT THE BOX' : 'BAD' });
    return JSON.stringify({ ok: true, row: r, inv: inv });
  } finally {
    lock.releaseLock();
  }
}
function pullToInventory_(ss, user, c, d) {
  var sn = norm_(d.sn);
  if (!/^[A-Z0-9]{6,20}$/.test(sn)) return null;
  var hit = findAnywhere_(ss, sn), mc = hit ? hit.c : c, sh = hit ? hit.sh : invSheet_(ss, c), r = hit ? hit.r : nextInvRow_(sh);
  var col = function (n) { return invCol_(sh, n); }, dest = truckOf_(user) || mc.store;
  var from = hit ? String(sh.getRange(r, col('LOCATION')).getValue()) : '';
  if (!hit) {
    sh.getRange(r, col('SERIAL NUMBER')).setValue(sn);
    sh.getRange(r, col('RADIO')).setValue(d.model || '');
    sh.getRange(r, col('DATE OF SCAN')).setValue(new Date());
  }
  if (d.asset && !String(sh.getRange(r, col('ASSET NUMBER')).getValue()).trim()) sh.getRange(r, col('ASSET NUMBER')).setValue(norm_(d.asset));
  sh.getRange(r, col('STATUS')).setValue(d.status);
  sh.getRange(r, col('LOCATION')).setValue(dest);
  sh.getRange(r, col('NOTES')).setValue('Pulled from ' + d.site);
  stampRow_(sh, r, user);
  logMove_(ss, mc, { loc: dest, sn: sn, model: d.model, asset: d.asset || '', by: byLine_(user), notes: 'Pulled from ' + d.site + ' as ' + d.status + ' (red tag)' + (from ? ', was ' + from : ', added') });
  return { action: hit ? 'moved' : 'added', to: dest, status: d.status };
}

function setOrdered(token, market, tagRow, badSn, value) {
  var ss = book_(), user = who_(ss, token), c = market_(market);
  requireManager_(user);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var b = badRow_(ss, c, tagRow, badSn);
    b.sh.getRange(b.r, b.boxCol).setValue(!!value);
    b.sh.getRange(b.r, ensureCol_(b.sh, 'ORDER MARKED BY')).setValue(value ? user.email + ' · ' + stamp_(ss) : '');
    if (value) b.sh.getRange(b.r, ensureCol_(b.sh, 'ORDERED ON')).setValue(new Date());
    var moved = orderToTellworks_(ss, user, c, b, badSn, !!value);
    return JSON.stringify({ ok: true, row: b.r, moved: moved });
  } finally {
    lock.releaseLock();
  }
}
/**
 * Order submitted: the pulled radio goes to Tellworks. Undo puts it back where it was.
 * Where it was is kept in the PRE-TELLWORKS LOCATION column on the Bad Radios tab.
 */
function orderToTellworks_(ss, user, c, b, badSn, value) {
  var sh = ss.getSheetByName(c.inv);
  if (!sh) return '';
  var col = function (n) { return invCol_(sh, n); }, r = findSerialRow_(sh, badSn, col('SERIAL NUMBER') - 1);
  if (r < 2) return '';
  var prevCol = ensureCol_(b.sh, 'PRE-TELLWORKS LOCATION');
  var loc = String(sh.getRange(r, col('LOCATION')).getValue()).trim().toUpperCase(), model = sh.getRange(r, col('RADIO')).getValue();
  if (value) {
    if (loc === 'TELLWORKS') return '';
    b.sh.getRange(b.r, prevCol).setValue(loc);
    sh.getRange(r, col('LOCATION')).setValue('TELLWORKS');
    sh.getRange(r, col('SHIPPED')).setValue(new Date());
    stampRow_(sh, r, user);
    logMove_(ss, c, { loc: 'TELLWORKS', sn: norm_(badSn), model: model, by: byLine_(user), notes: 'Order submitted, sent to Tellworks' + (loc ? ', was ' + loc : '') });
    return 'TELLWORKS';
  }
  var prev = String(b.sh.getRange(b.r, prevCol).getValue()).trim();
  if (loc !== 'TELLWORKS' || !prev) return '';
  sh.getRange(r, col('LOCATION')).setValue(prev);
  sh.getRange(r, col('SHIPPED')).setValue('');
  b.sh.getRange(b.r, prevCol).setValue('');
  stampRow_(sh, r, user);
  logMove_(ss, c, { loc: prev, sn: norm_(badSn), model: model, by: byLine_(user), notes: 'Order undone, moved back from Tellworks' });
  return prev;
}
/** The replacement arrived: adds it to inventory and closes out the order. */
function receiveOrder(token, market, tagRow, badSn, d) {
  var ss = book_(), user = actAs_(ss, who_(ss, token), d && d.as), c = market_(market);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var b = badRow_(ss, c, tagRow, badSn);
    if (String(b.sh.getRange(b.r, ensureCol_(b.sh, 'REPLACEMENT RECEIVED')).getValue()).trim()) throw new Error('ALREADY_RECEIVED');
    var t = transfer_(ss, user, c, d);
    b.sh.getRange(b.r, ensureCol_(b.sh, 'REPLACEMENT RECEIVED')).setValue(new Date());
    b.sh.getRange(b.r, ensureCol_(b.sh, 'RECEIVED SN')).setValue(norm_(d.sn));
    b.sh.getRange(b.r, ensureCol_(b.sh, 'RECEIVED BY')).setValue(byLine_(user));
    return JSON.stringify({ ok: true, row: b.r, transfer: t });
  } finally {
    lock.releaseLock();
  }
}
function badRow_(ss, c, tagRow, badSn) {
  var sh = ss.getSheetByName(c.bad);
  if (!sh) throw new Error('NO_TAB:' + c.bad);
  var h = headers_(sh);
  var snCol = findCol_(h, ['SERIAL NUMBER']) + 1, boxCol = findCol_(h, ['CHAT ORDER SUBMITTED?']) + 1;
  if (snCol < 1 || boxCol < 1) throw new Error('NO_COLUMN');
  var want = norm_(badSn), r;
  if (tagRow > 1 && norm_(sh.getRange(tagRow, snCol).getValue()) === want) r = tagRow;
  else r = findSerialRow_(sh, badSn, snCol - 1);
  if (r < 2) throw new Error('NOT_FOUND');
  return { sh: sh, r: r, boxCol: boxCol };
}

/* ---------- inventory ---------- */
/**
 * Asset Transfer: puts a scanned radio in the shop, the signed-in person's truck, or ships it to Tellworks.
 * A serial already in inventory is moved, never added twice.
 */
function transferRadio(token, market, d) {
  var ss = book_(), user = actAs_(ss, who_(ss, token), d && d.as), c = market_(market);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return JSON.stringify(transfer_(ss, user, c, d));
  } finally {
    lock.releaseLock();
  }
}
function transfer_(ss, user, c, d) {
  var sn = norm_(d.sn), asset = norm_(d.asset);
  if (!/^[A-Z0-9]{6,20}$/.test(sn)) throw new Error('BAD_SERIAL');
  var dest = d.dest === 'TRUCK' ? truckOf_(user) : d.dest === 'TELLWORKS' ? 'TELLWORKS' : c.store;
  if (!dest) throw new Error('NO_TRUCK');
  var hit = findAnywhere_(ss, sn);
  if (hit && hit.c !== c) throw new Error('IN_OTHER_MARKET:' + hit.m);
  var sh = invSheet_(ss, c), col = function (n) { return invCol_(sh, n); };
  if (asset && asset !== 'NA') checkAsset_(ss, asset, sn);
  var r = hit ? hit.r : -1, from = '', action;
  if (r > 1) {
    from = String(sh.getRange(r, col('LOCATION')).getValue());
    if (from.toUpperCase() === dest) throw new Error('ALREADY_THERE:' + dest);
    sh.getRange(r, col('LOCATION')).setValue(dest);
    if (from.toUpperCase() === 'SITE') sh.getRange(r, col('NOTES')).setValue('');
    action = 'moved';
  } else {
    if (!asset && !d.noAsset) throw new Error('NEED_ASSET');
    r = nextInvRow_(sh);
    sh.getRange(r, col('STATUS')).setValue('GOOD');
    sh.getRange(r, col('SERIAL NUMBER')).setValue(sn);
    sh.getRange(r, col('LOCATION')).setValue(dest);
    sh.getRange(r, col('DATE OF SCAN')).setValue(new Date());
    if (d.scan) sh.getRange(r, col('SCANNED SN')).setValue(String(d.scan));
    if (!asset && d.noAsset) asset = 'NA';
    action = 'added';
  }
  if (d.model && !String(sh.getRange(r, col('RADIO')).getValue()).trim()) sh.getRange(r, col('RADIO')).setValue(d.model);
  if (asset) sh.getRange(r, col('ASSET NUMBER')).setValue(asset);
  if (dest === 'TELLWORKS') {
    sh.getRange(r, col('RMA #')).setValue(String(d.rma || '').trim().toUpperCase());
    sh.getRange(r, col('SHIPPED')).setValue(new Date());
  }
  markTyped_(sh, r, d.typed);
  stampRow_(sh, r, user);
  var how = action === 'added' ? 'Added' : 'Moved from ' + from;
  if (dest === 'TELLWORKS') how += ', shipped to Tellworks' + (d.rma ? ' (RMA ' + String(d.rma).trim().toUpperCase() + ')' : '');
  logMove_(ss, c, { loc: dest, sn: sn, model: d.model || sh.getRange(r, col('RADIO')).getValue(), asset: asset === 'NA' ? '' : asset, by: byLine_(user),
    notes: how + ' (Asset Transfer)' + typedNote_(d.typed) });
  return { ok: true, action: action, from: from, to: dest, row: r };
}

/** Install: moves a spare to a site. A radio that isn't in inventory yet is added as installed. */
function installRadio(token, market, d) {
  var ss = book_(), user = actAs_(ss, who_(ss, token), d && d.as), c = market_(market);
  var sn = norm_(d.sn), site = String(d.site || '').trim().toUpperCase(), asset = norm_(d.asset);
  if (!/^[A-Z0-9]{6,20}$/.test(sn)) throw new Error('BAD_SERIAL');
  if (!site) throw new Error('MISSING:site');
  if (!(d.photo && d.photo.data) && !d.photoDropped) throw new Error('MISSING:photo');
  var photo = d.photo && d.photo.data ? savePhoto_(d.photo, site + ' ' + sn + ' installed') : '';
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var hit = findAnywhere_(ss, sn);
    if (hit && hit.c !== c) throw new Error('IN_OTHER_MARKET:' + hit.m);
    var sh = invSheet_(ss, c), col = function (n) { return invCol_(sh, n); }, r, loc;
    if (asset && asset !== 'NA') checkAsset_(ss, asset, sn);
    if (hit) {
      r = hit.r;
      loc = String(sh.getRange(r, col('LOCATION')).getValue()).toUpperCase();
      if (loc === 'SITE') throw new Error('ALREADY_INSTALLED:' + sh.getRange(r, col('NOTES')).getValue());
      if (String(sh.getRange(r, col('STATUS')).getValue() || 'GOOD').toUpperCase() !== 'GOOD') throw new Error('NOT_GOOD');
    } else {
      if (!d.model) throw new Error('NOT_IN_INVENTORY');
      r = nextInvRow_(sh); loc = 'NEW';
      sh.getRange(r, col('STATUS')).setValue('GOOD');
      sh.getRange(r, col('SERIAL NUMBER')).setValue(sn);
      sh.getRange(r, col('RADIO')).setValue(d.model);
      sh.getRange(r, col('DATE OF SCAN')).setValue(new Date());
      if (d.scan) sh.getRange(r, col('SCANNED SN')).setValue(String(d.scan));
    }
    if (asset) sh.getRange(r, col('ASSET NUMBER')).setValue(asset);
    sh.getRange(r, col('LOCATION')).setValue('SITE');
    sh.getRange(r, col('NOTES')).setValue(site);
    sh.getRange(r, col('INSTALL PHOTO')).setValue(photo);
    markTyped_(sh, r, d.typed);
    stampRow_(sh, r, user);
    addSite_(ss, site, market, user);
    logMove_(ss, c, { loc: 'SITE', sn: sn, site: site, photo: photo, model: sh.getRange(r, col('RADIO')).getValue(), asset: asset === 'NA' ? '' : asset, by: byLine_(user),
      notes: (loc === 'NEW' ? 'Added at install (wasn\'t in inventory)' : 'Installed from ' + loc) + ' (Install)' + typedNote_(d.typed) });
    return JSON.stringify({ ok: true, row: r, from: loc });
  } finally {
    lock.releaseLock();
  }
}

/** Anyone: flag a radio as bad (a spare that turns out dead). */
function markBad(token, market, sn, reason, asEmail) {
  var ss = book_(), user = actAs_(ss, who_(ss, token), asEmail), c = market_(market);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(c.inv);
    if (!sh) throw new Error('NOT_IN_INVENTORY');
    var col = function (n) { return invCol_(sh, n); }, r = findSerialRow_(sh, sn, col('SERIAL NUMBER') - 1);
    if (r < 2) throw new Error('NOT_IN_INVENTORY');
    sh.getRange(r, col('STATUS')).setValue('BAD OUT THE BOX');
    stampRow_(sh, r, user);
    logMove_(ss, c, { loc: String(sh.getRange(r, col('LOCATION')).getValue()), sn: norm_(sn), model: sh.getRange(r, col('RADIO')).getValue(), by: byLine_(user),
      notes: 'Marked bad' + (reason ? ': ' + String(reason).slice(0, 200) : '') });
    return JSON.stringify({ ok: true, row: r });
  } finally {
    lock.releaseLock();
  }
}

/** Managers: move any radio to any location, or change its status. */
function moveRadio(token, market, invRow, sn, loc, site, status) {
  var ss = book_(), user = who_(ss, token), c = market_(market);
  requireManager_(user);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(c.inv);
    if (!sh) throw new Error('NO_TAB:' + c.inv);
    var col = function (n) { return invCol_(sh, n); }, snc = col('SERIAL NUMBER');
    var r = (invRow > 1 && norm_(sh.getRange(invRow, snc).getValue()) === norm_(sn)) ? invRow : findSerialRow_(sh, sn, snc - 1);
    if (r < 2) throw new Error('NOT_FOUND');
    if (loc) {
      sh.getRange(r, col('LOCATION')).setValue(loc);
      sh.getRange(r, col('NOTES')).setValue(loc === 'SITE' ? (site || '') : '');
    }
    if (status) sh.getRange(r, col('STATUS')).setValue(status);
    stampRow_(sh, r, user);
    if (loc) logMove_(ss, c, { loc: loc, sn: sn, site: loc === 'SITE' ? site : '', model: sh.getRange(r, col('RADIO')).getValue(), by: byLine_(user), notes: 'Moved by a manager' });
    return JSON.stringify({ ok: true, row: r });
  } finally {
    lock.releaseLock();
  }
}

/** Managers: move a radio's row from one market's inventory to the other's warehouse. */
function moveMarket(token, from, sn) {
  var ss = book_(), user = who_(ss, token), c = market_(from), to = from === 'AU' ? 'HN' : 'AU', tc = MARKETS[to];
  requireManager_(user);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(c.inv);
    if (!sh) throw new Error('NOT_FOUND');
    var r = findSerialRow_(sh, sn, invCol_(sh, 'SERIAL NUMBER') - 1);
    if (r < 2) throw new Error('NOT_FOUND');
    var h = headers_(sh), vals = sh.getRange(r, 1, 1, h.length).getValues()[0];
    var th = invSheet_(ss, tc);
    h.forEach(function (name) { if (name) invCol_(th, name); });
    var tr = nextInvRow_(th), t2 = headers_(th), out = blankRow_(t2.length);
    h.forEach(function (name, i) { var j = t2.indexOf(name); if (name && j >= 0) out[j] = vals[i]; });
    out[t2.indexOf('LOCATION')] = tc.store;
    out[t2.indexOf('NOTES')] = '';
    th.getRange(tr, 1, 1, out.length).setValues([out]);
    stampRow_(th, tr, user);
    sh.deleteRow(r);
    var model = vals[h.indexOf('RADIO')];
    logMove_(ss, c, { loc: tc.store, sn: norm_(sn), model: model, by: byLine_(user), notes: 'Moved to ' + to + ' inventory by a manager' });
    logMove_(ss, tc, { loc: tc.store, sn: norm_(sn), model: model, by: byLine_(user), notes: 'Moved from ' + from + ' inventory by a manager' });
    return JSON.stringify({ ok: true, to: to, row: tr });
  } finally {
    lock.releaseLock();
  }
}

/** A site typed in the app that isn't on the Sites tab gets added, flagged for a manager to check. */
function addSite_(ss, site, market, user) {
  var sh = ss.getSheetByName(SITES_TAB);
  site = norm_(site);
  if (!sh || !site) return;
  var h = headers_(sh), ic = h.indexOf('SITE ID');
  if (ic < 0) return;
  if (sh.getLastRow() >= 2) {
    var ids = sh.getRange(2, ic + 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (norm_(ids[i][0]) === site) return;
  }
  var row = blankRow_(h.length), put = function (n, v) { var j = h.indexOf(n); if (j >= 0) row[j] = v; };
  put('SITE ID', site); put('MARKET', market); put('AREA', SITE_AREAS[site.slice(0, 2)] || (market === 'HN' ? 'Houston' : ''));
  put('NOTES', 'Added from the app by ' + user.email + ' · ' + stamp_(ss) + '. Check it.');
  sh.getRange(nextRow_(sh, ic + 1), 1, 1, row.length).setValues([row]);
}

/** Where a serial is listed, in either market. */
function findAnywhere_(ss, sn) {
  var keys = Object.keys(MARKETS);
  for (var i = 0; i < keys.length; i++) {
    var c = MARKETS[keys[i]], sh = ss.getSheetByName(c.inv);
    if (!sh) continue;
    var r = findSerialRow_(sh, sn, invCol_(sh, 'SERIAL NUMBER') - 1);
    if (r > 1) return { m: keys[i], c: c, sh: sh, r: r };
  }
  return null;
}
/** An asset tag can only belong to one serial. */
function checkAsset_(ss, asset, sn) {
  Object.keys(MARKETS).forEach(function (m) {
    var sh = ss.getSheetByName(MARKETS[m].inv);
    if (!sh || sh.getLastRow() < 2) return;
    var h = headers_(sh), a = h.indexOf('ASSET NUMBER'), s = h.indexOf('SERIAL NUMBER');
    if (a < 0 || s < 0) return;
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (norm_(vals[i][a]) === asset && norm_(vals[i][s]) !== norm_(sn)) throw new Error('ASSET_USED:' + norm_(vals[i][s]));
    }
  });
}
function markTyped_(sh, r, typed) {
  if (typed && typed.length) sh.getRange(r, invCol_(sh, 'TYPED BY HAND')).setValue(typed.join(', '));
}
function typedNote_(typed) { return typed && typed.length ? ' · typed by hand: ' + typed.join(', ') : ''; }

/* ---------- helpers ---------- */
/** The spreadsheet the app works on: DATA_SHEET_ID if set (an ID or a full link), else the attached sheet. */
function book_() {
  var id = String(prop_('DATA_SHEET_ID') || '').trim();
  var m = id.match(/\/d\/([a-zA-Z0-9_-]+)/); if (m) id = m[1];
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function market_(m) { var c = MARKETS[m]; if (!c) throw new Error('BAD_MARKET'); return c; }
function norm_(v) { return String(v == null ? '' : v).toUpperCase().replace(/\s+/g, '').replace(/^\(S\)/, ''); }
function truckOf_(user) { return user.truck || ''; }
function stamp_(ss) { return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'); }
function blankRow_(n) { var r = []; for (var i = 0; i < n; i++) r.push(''); return r; }
function headers_(sh) {
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(function (x) { return String(x).trim().toUpperCase(); });
}
function findCol_(h, names) {
  for (var n = 0; n < names.length; n++) { var i = h.indexOf(names[n]); if (i >= 0) return i; }
  return -1;
}
/** 1-based column for a header, adding the header at the end when the tab doesn't have it yet. */
function ensureCol_(sh, name) {
  var h = headers_(sh), i = h.indexOf(name.toUpperCase());
  if (i >= 0) return i + 1;
  var c = h.length + (h.length === 1 && !h[0] ? 0 : 1);
  sh.getRange(1, c).setValue(name).setFontWeight('bold');
  return c;
}
function invCol_(sh, name) {
  var h = headers_(sh), i = h.indexOf(name);
  if (i >= 0) return i + 1;
  var std = INV_HEADERS.indexOf(name);
  if (std >= 0 && std < 10 && !h[std]) { sh.getRange(1, std + 1).setValue(name).setFontWeight('bold'); return std + 1; }
  return ensureCol_(sh, name);
}
function invSheet_(ss, c) {
  var sh = ss.getSheetByName(c.inv);
  if (!sh) { sh = ss.insertSheet(c.inv); sh.getRange(1, 1, 1, INV_HEADERS.length).setValues([INV_HEADERS]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}
function stampRow_(sh, r, user) {
  sh.getRange(r, invCol_(sh, 'LAST MOVED BY')).setValue(user.email);
  sh.getRange(r, invCol_(sh, 'LAST MOVED')).setValue(new Date());
}
function findSerialRow_(sh, sn, colIndex) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var col = sh.getRange(2, colIndex + 1, last - 1, 1).getValues(), want = norm_(sn);
  for (var i = 0; i < col.length; i++) if (norm_(col[i][0]) === want) return i + 2;
  return -1;
}
/** First row after the last one with a radio, serial or scan in it. */
function nextInvRow_(sh) {
  var last = Math.max(sh.getLastRow(), 1), h = headers_(sh);
  var cols = ['RADIO', 'SERIAL NUMBER', 'SCANNED SN'].map(function (n) { return h.indexOf(n); }).filter(function (i) { return i >= 0; });
  var vals = sh.getRange(1, 1, last, Math.max(h.length, 1)).getValues(), r = 1;
  for (var i = vals.length - 1; i >= 1; i--) { if (cols.some(function (c) { return String(vals[i][c]).trim(); })) { r = i + 1; break; } }
  return r + 1;
}
/** First empty row after the last row with a value in keyCol (1-based). */
function nextRow_(sh, keyCol) {
  var last = Math.max(sh.getLastRow(), 1);
  var key = sh.getRange(1, keyCol, last, 1).getValues(), r = 1;
  for (var i = key.length - 1; i >= 0; i--) { if (String(key[i][0]).trim()) { r = i + 1; break; } }
  r += 1;
  var width = Math.max(sh.getLastColumn(), 1);
  while (r <= last && sh.getRange(r, 1, 1, width).getValues()[0].some(function (v) { return String(v).trim() !== ''; })) r++;
  return r;
}
function logMove_(ss, c, m) {
  var sh = ss.getSheetByName(c.moves);
  if (!sh) { sh = ss.insertSheet(c.moves); sh.getRange(1, 1, 1, MOVE_HEADERS.length).setValues([MOVE_HEADERS]).setFontWeight('bold'); }
  ensureCol_(sh, 'MOVED BY');
  var h = headers_(sh), row = blankRow_(h.length);
  var put = function (names, v) { var i = findCol_(h, names); if (i >= 0) row[i] = v; };
  put(['TIMESTAMP'], new Date());
  put(['TRANSFER LOCATION'], m.loc || '');
  put(['SERIAL NUMBER'], m.sn || '');
  put(['SERIAL NUMBER PICTURE'], m.photo || '');
  put(['ASSET NUMBER'], m.asset || '');
  put(['NOTES'], m.notes || '');
  put(['SITE ID IF INSTALLED'], m.site || '');
  put(['RADIO'], m.model || '');
  put(['MOVED BY'], m.by || '');
  sh.getRange(nextRow_(sh, 1), 1, 1, row.length).setValues([row]);
}
function savePhoto_(p, name) {
  if (!p || !p.data) return '';
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
  var blob = Utilities.newBlob(Utilities.base64Decode(p.data), p.mime || 'image/jpeg', name.replace(/[^\w .-]/g, '') + '.jpg');
  return 'https://drive.google.com/open?id=' + folder.createFile(blob).getId();
}

/* ---------- set up tabs (run setupTabs once; safe to run again) ---------- */
var NOTES_HEADER = 'ALARM NOTES ( WATER INTRUSION, TX OOO, NO CONNECTION, VSWR, ETC.)';
var TAB_LAYOUT = {
  'AU Virtual Red Tag': ['Timestamp', 'RADIO', 'SITE ID', 'INC #', 'SERIAL NUMBER OR ASSET IF NO SN', 'FAILURE REASON', 'ASSET NUMBER', 'STATUS', 'ASSET NUMBER PICTURE', 'SERIAL NUMBER PICTURE OR ASSET IF NO SN', 'Email Address', 'New Radio SN Installed', 'New Radio SN Installed Picture', NOTES_HEADER],
  'HN Virtual Red Tag': ['Timestamp', 'SITE ID', 'INC #', 'STATUS', 'RADIO', 'SERIAL NUMBER', 'SERIAL NUMBER PICTURE', 'ASSET NUMBER', 'ASSET NUMBER PICTURE', 'FAILURE REASON', 'New Radio SN Installed', 'New Radio SN Installed Picture', NOTES_HEADER, 'Email Address'],
  // Bad Radios tabs mirror the red tag tab row for row; the order box is the only thing typed here
  'AU Bad Radios - VRT': { headers: ['RADIO', 'SITE ID', 'INC # / TT NUMBER', 'SERIAL NUMBER', 'FAILURE REASON', 'ASSET NUMBER', 'CHAT ORDER SUBMITTED?'], from: 'AU Virtual Red Tag', cols: ['B', 'C', 'D', 'E', 'F', 'G'] },
  'HN Bad Radios - VRT': { headers: ['RADIO', 'SITE ID', 'INC # / TT NUMBER', 'SERIAL NUMBER', 'ASSET NUMBER', 'FAILURE REASON', 'CHAT ORDER SUBMITTED?'], from: 'HN Virtual Red Tag', cols: ['E', 'B', 'C', 'F', 'H', 'J'] },
  'AU Inventory Tracker': MOVE_HEADERS,
  'HN Inventory Tracker': MOVE_HEADERS
};
var LOOKUP_ROWS = [[474331, 'AHLOA'], [475125, 'AHFIG'], [475910, 'AHLOB'], [475656, 'AHFII'], [475124, 'AEHC'], [474486, 'AAFIA'], [472679, 'FXFC'], [476268, 'AVHA']];
var RADIO_MODELS = ['AEHC', 'AAFIA', 'AHLOA', 'AHFIG', 'AHLOB', 'AHFII', 'FXFC', 'FXFB', 'AVHA', 'FFVV', 'HBXX'];
/** Resting stock: how many good spares of each we normally keep. FFVV = FFVV-65C-R2N23 antenna, HBXX = HBXX-3319DS-A2M antenna. */
var RESTING_STOCK = { AAFIA: 2, AEHC: 5, AHFIG: 8, AHFII: 3, AHLOA: 11, AHLOB: 1, FXFC: 2, FXFB: 0, AVHA: 0, FFVV: 3, HBXX: 1 };
var MODEL_NAMES = { FFVV: 'FFVV-65C-R2N23 antenna', HBXX: 'HBXX-3319DS-A2M antenna' };
var LOCATIONS = {
  AU: ['AU WAREHOUSE', 'RICK TRUCK', 'EFRAIN TRUCK', 'FRANKY TRUCK', 'PAKO TRUCK', 'EDGAR TRUCK', 'MIKE TRUCK', 'MAYRON TRUCK', 'JR TRUCK', 'SITE', 'TELLWORKS'],
  HN: ['HN WAREHOUSE', 'SITE', 'TELLWORKS']
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Serracom Inventory Tracker').addItem('Set up tabs', 'setupTabs').addItem('Load resting stock', 'setRestingStock').addToUi();
}
/** Run once to put the resting stock numbers (and the FFVV / HBXX antennas) on the Settings tab and in the model dropdowns. */
function setRestingStock() {
  var ss = book_();
  if (!ss.getSheetByName(SETTINGS_TAB)) newTab_(ss, SETTINGS_TAB, ['MODEL', 'AU RESTING STOCK', 'HN RESTING STOCK']);
  applyResting_(ss);
  ['AU', 'HN'].forEach(function (m) { var sh = ss.getSheetByName(MARKETS[m].inv); if (sh) sh.getRange('B2:B1000').setDataValidation(list_(RADIO_MODELS)); });
  var msg = 'Resting stock loaded on the Settings tab. FFVV and HBXX antennas added to the model lists.';
  try { SpreadsheetApp.getUi().alert('Done', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { Logger.log(msg); }
  return msg;
}
function applyResting_(ss) {
  var st = ss.getSheetByName(SETTINGS_TAB);
  st.getRange(1, 1, 1, 3).setValues([['MODEL', 'AU RESTING STOCK', 'HN RESTING STOCK']]).setFontWeight('bold');
  var total = 0; Object.keys(RESTING_STOCK).forEach(function (k) { total += RESTING_STOCK[k]; });
  var want = [['ALL MODELS (TOTAL)', total, total]].concat(RADIO_MODELS.map(function (m) { var n = RESTING_STOCK[m] || 0; return [m, n, n]; }));
  var last = st.getLastRow(), have = last > 1 ? st.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]).trim().toUpperCase(); }) : [];
  want.forEach(function (row) {
    var i = have.indexOf(row[0]);
    if (i >= 0) st.getRange(i + 2, 1, 1, 3).setValues([row]);
    else { st.getRange(st.getLastRow() + 1, 1, 1, 3).setValues([row]); have.push(row[0]); }
  });
  st.getRange('E1').setValue('Resting stock: how many good spares we normally keep. Overview shows on hand / resting stock and flags anything below it. FFVV = FFVV-65C-R2N23, HBXX = HBXX-3319DS-A2M. Change any number here.').setFontStyle('italic');
}

/** Builds anything missing (tabs, columns, the Team tab, the home-screen icon). Never changes data that's there. */
function setupTabs() {
  var ss = book_(), made = [];
  if (!ss.getSheetByName(TEAM_TAB)) {
    var t = newTab_(ss, TEAM_TAB, TEAM_HEADERS);
    t.getRange('C2:C200').setDataValidation(list_(['Both', 'AU', 'HN']));
    t.getRange('E2:E200').setDataValidation(list_(['Lead', 'Manager']));
    t.getRange('G1').setValue('One row per person. Market: Both, AU or HN (just picks which market the app opens on). Truck example: EFRAIN TRUCK (leave blank if no truck). Role: Lead or Manager.').setFontStyle('italic');
    made.push(TEAM_TAB);
  }
  if (!ss.getSheetByName(SETTINGS_TAB)) {
    newTab_(ss, SETTINGS_TAB, ['MODEL', 'AU RESTING STOCK', 'HN RESTING STOCK']);
    applyResting_(ss);
    made.push(SETTINGS_TAB);
  }
  if (!ss.getSheetByName(SITES_TAB)) {
    var si = newTab_(ss, SITES_TAB, ['SITE ID', 'MARKET', 'AREA', 'NOTES']);
    var seed = [];
    ['AU', 'HN'].forEach(function (m) { SITE_LIST[m].split(',').forEach(function (id) { if (id) seed.push([id, m, SITE_AREAS[id.slice(0, 2)] || (m === 'HN' ? 'Houston' : ''), '']); }); });
    if (seed.length) si.getRange(2, 1, seed.length, 4).setValues(seed);
    si.getRange(2, 2, Math.max(seed.length, 1) + 2000, 1).setDataValidation(list_(['AU', 'HN']));
    si.getRange('F1').setValue('Paste site IDs in column A and AU or HN in column B. Area: AU Austin, CC Corpus, SA San Antonio, TK/WA Waco, DA Dallas, HN Houston. Sites typed in the app are added here with a note.').setFontStyle('italic');
    made.push(SITES_TAB);
  }
  if (!ss.getSheetByName('Lookup')) {
    var lk = newTab_(ss, 'Lookup', ['Product Code', 'Radio Model']);
    lk.getRange(2, 1, LOOKUP_ROWS.length, 2).setValues(LOOKUP_ROWS);
    made.push('Lookup');
  }
  ['AU', 'HN'].forEach(function (m) {
    var name = MARKETS[m].inv, sh = ss.getSheetByName(name);
    if (!sh) {
      sh = newTab_(ss, name, INV_HEADERS);
      sh.getRange('A2:A1000').setDataValidation(list_(['GOOD', 'BAD', 'BAD OUT THE BOX']));
      sh.getRange('B2:B1000').setDataValidation(list_(RADIO_MODELS));
      sh.getRange('D2:D1000').setDataValidation(list_(LOCATIONS[m]));
      made.push(name);
    } else {
      ['LAST MOVED BY', 'LAST MOVED'].forEach(function (n) { if (headers_(sh).indexOf(n) < 0) { ensureCol_(sh, n); made.push(name + ' › ' + n); } });
    }
  });
  Object.keys(TAB_LAYOUT).forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    var t = TAB_LAYOUT[name];
    if (Array.isArray(t)) { newTab_(ss, name, t); made.push(name); return; }
    var sh = newTab_(ss, name, t.headers);
    t.cols.forEach(function (c, i) {
      var src = "'" + t.from + "'!" + c + '2:' + c;
      sh.getRange(2, i + 1).setFormula('=ARRAYFORMULA(IF(' + src + '="","",' + src + '))');
    });
    sh.getRange(2, t.headers.length, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    made.push(name);
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  if (!prop_('ICON_URL')) {
    try { setupIcon_(); made.push('home-screen icon'); } catch (e) { made.push('home-screen icon (skipped: ' + e.message + ')'); }
  }
  var msg = made.length ? 'Added: ' + made.join(', ') + '.' : 'Everything was already set up, so nothing changed.';
  try { SpreadsheetApp.getUi().alert('Set up done', msg + '\n\nNext: add everyone to the Team tab (yourself as Manager), then deploy.', SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log(msg); }
  return msg;
}
/** Saves the tower icon to Drive, shares it as view-only by link, and uses it as the app icon. */
function setupIcon_() {
  var file = DriveApp.createFile(Utilities.newBlob(Utilities.base64Decode(ICON_PNG_B64), 'image/png', 'Serracom Inventory Tracker icon.png'));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  PropertiesService.getScriptProperties().setProperty('ICON_URL', 'https://lh3.googleusercontent.com/d/' + file.getId());
}
function newTab_(ss, name, headers) {
  var sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}
function list_(items) { return SpreadsheetApp.newDataValidation().requireValueInList(items, true).setAllowInvalid(true).build(); }

/* Site IDs from SITE IDS FOR TRACKER.xlsx (Nov 1, 2026). setupTabs loads them into the Sites tab. */
var SITE_LIST = { AU: '', HN: '' };   // the site IDs live on the Sites tab (kept out of this public repo)

var ICON_PNG_B64 = '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';
