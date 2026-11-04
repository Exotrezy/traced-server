// background.js — Traced service worker (v1.2)
//
// Everything durable lives in chrome.storage, never in variables: MV3 service workers are
// stopped after ~30s idle and always after a browser restart, so state kept in memory is lost.
//
//   local: tracedKey, trackedEmails {id -> status}, emailKeyMap {"subject::recipient" -> id},
//          pendingRegs [...], pollMeta {lastPoll}, lastEvent
//   sync : settings, tracedEnabled, tracedKey (so the same Chrome profile shares one dashboard)

const API = 'https://traced.mikaelsyed.me';
const MAX_TRACKED = 200;          // emails kept locally
const POLL_WINDOW_MS = 30 * 864e5; // only poll emails sent in the last 30 days
const IDLE_POLL_MS = 4.5 * 60e3;   // when Gmail isn't open, poll at most this often

// ── Owner key: random per install, never derived from the user's email ──
let keyPromise = null;
function getKey() {
  keyPromise ||= (async () => {
    let { tracedKey } = await chrome.storage.local.get('tracedKey');
    if (!tracedKey) ({ tracedKey } = await chrome.storage.sync.get('tracedKey'));
    if (!tracedKey) {
      const b = crypto.getRandomValues(new Uint8Array(32));
      tracedKey = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    }
    await chrome.storage.local.set({ tracedKey });
    await chrome.storage.sync.set({ tracedKey }).catch(() => {});
    return tracedKey;
  })();
  return keyPromise;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'X-Traced-Key': await getKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

const getLocal = keys => chrome.storage.local.get(keys);

// Every read-modify-write of trackedEmails goes through this queue. Without it two overlapping
// polls (or a poll landing right after a send) can overwrite each other's results, or drop a
// freshly-sent email from the list. Cheap insurance: work runs strictly one at a time.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}
const emailKey = (s, r) => `${(s || '').toLowerCase().trim()}::${(r || '').toLowerCase().trim()}`;

// ── Lifecycle: survive restarts ──
function ensureAlarm() {
  chrome.alarms.get('poll', a => { if (!a) chrome.alarms.create('poll', { periodInMinutes: 0.5 }); });
}
ensureAlarm();                                   // runs every time the worker wakes
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); syncFromServer().then(() => pollAll({ force: true })); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); syncFromServer().then(() => pollAll({ force: true })); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') pollAll(); });

// ── Merge (never replace) the local list with what the server knows ──
function syncFromServer() { return locked(syncInner); }
async function syncInner() {
  try {
    const list = await api('/api/emails?limit=50');
    if (!list.ok || !Array.isArray(list.data) || !list.data.length) return;
    const { trackedEmails = {}, emailKeyMap = {} } = await getLocal(['trackedEmails', 'emailKeyMap']);
    const missing = list.data.filter(id => !trackedEmails[id]).slice(0, 40);
    for (let i = 0; i < missing.length; i += 20) {
      const r = await api('/api/status/bulk', { method: 'POST', body: { ids: missing.slice(i, i + 20) } });
      if (!r.ok) continue;
      for (const [id, s] of Object.entries(r.data || {})) {
        trackedEmails[id] = s;
        if (s.subject || s.recipient) emailKeyMap[emailKey(s.subject, s.recipient)] = id;
      }
    }
    await saveTracked(trackedEmails, emailKeyMap);
  } catch (e) { console.warn('[Traced] sync failed', e); }
}

async function saveTracked(trackedEmails, emailKeyMap) {
  const ids = Object.keys(trackedEmails).sort((a, b) => Date.parse(trackedEmails[b].createdAt || 0) - Date.parse(trackedEmails[a].createdAt || 0));
  for (const id of ids.slice(MAX_TRACKED)) delete trackedEmails[id];
  for (const [k, id] of Object.entries(emailKeyMap || {})) if (!trackedEmails[id]) delete emailKeyMap[k];
  await chrome.storage.local.set({ trackedEmails, ...(emailKeyMap ? { emailKeyMap } : {}) });
}


// Cache reconciliation only. Never delete server records or change registration/recording.
async function removeConfirmedMissing(ids, statuses, trackedEmails, emailKeyMap) {
  const { pendingRegs = [] } = await getLocal('pendingRegs');
  const queued = new Set(pendingRegs.map(p => p.body?.trackingId).filter(Boolean));
  for (const id of ids) {
    if (Object.hasOwn(statuses, id) || queued.has(id)) continue;
    const cached = trackedEmails[id];
    if (!cached) continue;
    // A brand-new local row can precede its asynchronous registration request.
    const confirmedBefore = Array.isArray(cached.timeline) || Array.isArray(cached.sessions);
    if (!confirmedBefore && Date.now() - Date.parse(cached.createdAt || '') < 120_000) continue;
    try {
      const check = await api('/api/status/' + encodeURIComponent(id));
      if (check.ok && check.data?.trackingId === id) { statuses[id] = check.data; continue; }
      if (check.status !== 404) continue;
      delete trackedEmails[id];
      for (const [key, value] of Object.entries(emailKeyMap)) if (value === id) delete emailKeyMap[key];
    } catch { /* Offline or failed verification: retain the saved record. */ }
  }
}

// ── Polling ──
async function gmailOpen() {
  try { return (await chrome.tabs.query({ url: 'https://mail.google.com/*' })).length > 0; } catch { return false; }
}

function pollAll(opts) { return locked(() => pollInner(opts)); }
async function pollInner({ force = false } = {}) {
  await flushPending();
  const { trackedEmails = {}, emailKeyMap = {}, pollMeta = {} } = await getLocal(['trackedEmails', 'emailKeyMap', 'pollMeta']);
  if (!force && !(await gmailOpen()) && Date.now() - (pollMeta.lastPoll || 0) < IDLE_POLL_MS) return;

  // NEWEST first. (v1 sliced Object.keys(), which is insertion order = the 10 OLDEST emails.)
  const ids = Object.values(trackedEmails)
    .filter(e => force || Date.now() - Date.parse(e.createdAt || 0) < POLL_WINDOW_MS)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, force ? MAX_TRACKED : 20).map(e => e.trackingId).filter(Boolean);
  if (!ids.length) { await chrome.storage.local.set({ pollMeta: { lastPoll: Date.now(), ok: true } }); return; }

  const statuses = {};
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = ids.slice(offset, offset + 20);
    let response;
    try { response = await api('/api/status/bulk', { method:'POST', body:{ids:batch} }); }
    catch { await chrome.storage.local.set({pollMeta:{lastPoll:Date.now(),ok:false}}); return; }
    const data = response.data;
    const valid = data && typeof data === 'object' && !Array.isArray(data)
      && Object.entries(data).every(([id, value]) => batch.includes(id) && value?.trackingId === id);
    if (!response.ok || !valid) { await chrome.storage.local.set({pollMeta:{lastPoll:Date.now(),ok:false,status:response.status}}); return; }
    Object.assign(statuses, data);
  }
  await removeConfirmedMissing(ids, statuses, trackedEmails, emailKeyMap);
  const r = {data:statuses};

  const { settings = {} } = await chrome.storage.sync.get('settings');
  const notes = [];
  let newest = null;
  for (const [id, s] of Object.entries(r.data || {})) {
    const prev = trackedEmails[id] || {};
    const d = {
      open: (s.openCount || 0) - (prev.openCount || 0),
      read: (s.fullyReadCount || 0) - (prev.fullyReadCount || 0),
      click: (s.clickSessions || 0) - (prev.clickSessions || 0),
    };
    const who = s.recipient || 'recipient';
    // One notification per NEW SESSION — a return visit after a break counts, a double-fire doesn't.
    if (d.read > 0) notes.push([`read-${id}-${s.fullyReadCount}`, 'Read to the end', `“${s.subject}” — ${who}`, 'fully_read', s]);
    else if (d.open > 0) notes.push([`open-${id}-${s.openCount}`, s.openCount > 1 ? `Opened again (${s.openCount}×)` : 'Email opened', `“${s.subject}” — ${who}`, 'opened', s]);
    if (d.click > 0) notes.push([`click-${id}-${s.clickSessions}`, 'Link clicked', `“${s.subject}” — ${who}`, 'link_clicked', s]);
    trackedEmails[id] = { ...prev, ...s };
  }
  for (const [nid, title, msg, type, s] of notes.slice(0, 3)) {
    if (settings.notifications !== false) notify(nid, title, msg);
    const t = s.timeline?.filter(x => x.type === type).at(-1);
    newest = { type, subject: s.subject, recipient: s.recipient, time: t?.lastSeen || t?.time || new Date().toISOString(), device: t?.device, client: t?.client, id: nid };
  }
  await saveTracked(trackedEmails, emailKeyMap);
  await chrome.storage.local.set({ pollMeta: { lastPoll: Date.now(), ok: true }, ...(newest ? { lastEvent: newest } : {}) });
}

function notify(id, title, message) {
  if (!chrome.notifications) return;
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message });
}

// ── Registration with an offline queue ──
async function flushPending() {
  const { pendingRegs = [] } = await getLocal('pendingRegs');
  if (!pendingRegs.length) return;
  const keep = [];
  for (const p of pendingRegs) {
    if (Date.now() - p.queuedAt > 864e5) continue; // give up after a day
    try {
      const r = await api('/api/register', { method: 'POST', body: p.body });
      if (!r.ok && (r.status >= 500 || r.status === 429)) keep.push(p);
    } catch { keep.push(p); }
  }
  await chrome.storage.local.set({ pendingRegs: keep.slice(-50) });
}

async function registerEmail(p) {
  const { subject = '', recipient = '', links = [], options = {}, trackingId, senderEmail = '' } = p;
  if (!trackingId) throw new Error('no trackingId');
  if (senderEmail) chrome.storage.local.set({ senderEmail });

  // Show the grey check immediately, even if the network is down.
  await locked(async () => {
    const { trackedEmails = {}, emailKeyMap = {} } = await getLocal(['trackedEmails', 'emailKeyMap']);
    trackedEmails[trackingId] = { trackingId, subject, recipient, createdAt: new Date().toISOString(), openCount: 0, fullyReadCount: 0, clickCount: 0, clickSessions: 0, state: 'sent', options };
    emailKeyMap[emailKey(subject, recipient)] = trackingId;
    await saveTracked(trackedEmails, emailKeyMap);
  });

  const body = { trackingId, subject, recipient, senderEmail, options, links };
  try {
    const r = await api('/api/register', { method: 'POST', body });
    if (!r.ok && (r.status >= 500 || r.status === 429)) throw new Error('retry');
    return { ok: r.ok, status: r.status, ...(r.data || {}) };
  } catch {
    const { pendingRegs = [] } = await getLocal('pendingRegs');
    pendingRegs.push({ body, queuedAt: Date.now() });
    await chrome.storage.local.set({ pendingRegs: pendingRegs.slice(-50) });
    return { ok: false, queued: true };
  }
}

// ── Messages from content script / popup ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = fn => { fn().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e.message || e) })); return true; };
  switch (msg?.type) {
    case 'PRE_REGISTER':
      return run(async () => (await api('/api/pre-register', { method: 'POST', body: { trackingId: msg.payload?.trackingId } })).ok ? { ok: true } : { ok: false });
    case 'REGISTER_EMAIL': return run(() => registerEmail(msg.payload || {}));
    case 'REGISTER_LINK':
      return run(async () => { const r = await api('/api/register-link', { method: 'POST', body: msg.payload }); return r.ok ? r.data : { error: r.data?.error || 'failed' }; });
    case 'GET_STATUS':
      return run(async () => { const r = await api(`/api/status/${encodeURIComponent(msg.trackingId)}`); return r.ok ? r.data : { error: 'not found' }; });
    case 'POLL_NOW': return run(async () => { await pollAll({ force: true }); return { ok: true }; });
    case 'GET_ALL': return run(async () => (await getLocal('trackedEmails')).trackedEmails || {});
    case 'DASHBOARD_URL': return run(async () => ({ url: `${API}/dashboard#k=${await getKey()}` }));
    case 'DELETE_ALL':
      return run(async () => {
        const r = await api('/api/emails', { method: 'DELETE' });
        if (r.ok) await locked(() => chrome.storage.local.set({ trackedEmails: {}, emailKeyMap: {}, pendingRegs: [], lastEvent: null }));
        return { ok: r.ok };
      });
    default: return false;
  }
});
