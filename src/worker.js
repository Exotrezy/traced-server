/**
 * Traced — Cloudflare Worker (v2)
 *
 * What changed vs v1:
 *  - Sessions: opens and link clicks are grouped into sessions at read time, so a
 *    first click and a click hours later (or after a browser restart) are both kept
 *    and shown as separate sessions, while double-fires within one visit are merged.
 *  - Owner keys: every write and every listing is scoped to the installing user's
 *    random key (only its SHA-256 is stored). Nobody can list, read or wipe
 *    another user's data any more.
 *  - Link validation: only http(s) targets, no userinfo tricks, per-owner rate limits.
 *  - Unknown tracking IDs are ignored by the pixel endpoints (no junk writes).
 *  - Cheaper reads: bulk status is 3 queries total instead of 3 per email.
 *  - Debug endpoints are gone from the public surface (ADMIN_TOKEN-gated only).
 *  - Nightly retention purge (cron).
 */

const PIXEL_BYTES = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  c => c.charCodeAt(0)
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_ID_RE = /^[a-f0-9]{12,32}$/;
const KEY_RE = /^[a-f0-9]{32,128}$/i;

const PIXEL_HEADERS = {
  'Content-Type': 'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, private',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Access-Control-Allow-Origin': '*',
};
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Traced-Key',
  'Access-Control-Max-Age': '86400',
};

const pixelResponse = () => new Response(PIXEL_BYTES, { headers: PIXEL_HEADERS });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const nowIso = () => new Date().toISOString();
const clip = (s, n) => String(s ?? '').slice(0, n);

function randomHex(bytes = 8) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// ── Config (all overridable with [vars] in wrangler.toml) ──
function cfg(env) {
  const n = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    base: env.BASE_URL || 'https://traced.mikaelsyed.me',
    sessionGapMs: n(env.SESSION_GAP_MIN, 15) * 60 * 1000,   // gap that starts a new session
    prefetchMs: n(env.PREFETCH_MS, 30 * 1000),               // proxy hits this soon after send = delivery scan
    selfOpenMs: n(env.SELF_OPEN_MS, 5 * 60 * 1000),          // opens from sender's own IP this soon = self view
    selfClickMs: n(env.SELF_CLICK_MS, 45 * 1000),            // clicks from sender's own IP this soon = own browser prefetching the link, not a real click
    dupMs: n(env.DUP_MS, 2000),                              // identical request repeated inside this = same hit
    readDelayMs: n(env.READ_DELAY_MS, 4000),                 // min gap between top+bottom pixel to count as "read"
    retentionDays: n(env.RETENTION_DAYS, 180),
    emailsPerHour: n(env.EMAILS_PER_HOUR, 500),
    linksPerHour: n(env.LINKS_PER_HOUR, 3000),
  };
}

// ── UA helpers ──
// One shared list: corporate mail-security scanners (Outlook Safe Links, Proofpoint, Mimecast,
// Barracuda...) prefetch embedded images to scan them, not just links, so the pixel path needs
// the same bot signatures as the click path — not a separate, narrower list.
const BOT_UA = [
  'googlebot/', 'bingbot', 'applebot', 'facebookexternalhit', 'twitterbot', 'slackbot', 'linkedinbot', 'discordbot',
  'bot', 'crawler', 'spider', 'curl/', 'wget/', 'python-requests', 'python-urllib', 'go-http-client', 'okhttp',
  'java/', 'libwww', 'headlesschrome', 'phantomjs', 'safelinks', 'protection.outlook', 'proofpoint', 'mimecast',
  'barracuda', 'urlscan', 'microsoftpreview', 'whatsapp', 'skypeuripreview', 'slack-imgproxy', 'telegrambot',
];
function isBot(ua) {
  const u = (ua || '').toLowerCase();
  return !u || BOT_UA.some(b => u.includes(b));
}
const isBotPixel = isBot;
const isBotClick = isBot;
function isProxy(ua) {
  const u = (ua || '').toLowerCase();
  return u.includes('googleimageproxy') || u.includes('ggpht.com');
}
const uaFP = ua => (ua || '').slice(0, 120).toLowerCase().trim();
function getDevice(ua) {
  const u = (ua || '').toLowerCase();
  if (/ipad|tablet/.test(u)) return 'tablet';
  if (/iphone|android.*mobile|mobile/.test(u)) return 'mobile';
  return 'desktop';
}
function getClient(ua) {
  const u = (ua || '').toLowerCase();
  if (u.includes('googleimageproxy') || u.includes('ggpht.com')) return 'Gmail';
  if (u.includes('edg/')) return 'Edge';
  if (u.includes('opr/')) return 'Opera';
  if (u.includes('firefox')) return 'Firefox';
  if (u.includes('chrome') || u.includes('crios')) return 'Chrome';
  if (u.includes('safari')) return 'Safari';
  return 'Unknown';
}

// ── URL safety (this worker is a redirector — it must never redirect anywhere dangerous) ──
function safeUrl(raw, base) {
  try {
    const s = String(raw).trim();
    if (s.length > 2048) return null;
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;                 // https://google.com@evil.example tricks
    const self = new URL(base);
    if (u.hostname === self.hostname && /^\/(l|p|r|pixel|read)\//.test(u.pathname)) return null; // no redirect loops
    return u.toString();
  } catch { return null; }
}

// ── Auth: per-install owner key. Only its SHA-256 is ever stored. ──
async function ownerFrom(request) {
  const key = request.headers.get('x-traced-key') || '';
  if (!KEY_RE.test(key)) return null;
  return sha256Hex(key);
}

async function readJson(request, max = 100_000) {
  const text = await request.text();
  if (text.length > max) throw new Error('too-large');
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

// ── Sessionisation (read-time; raw hits are always kept) ──
function sessionize(events, keyOf, gapMs) {
  const open = new Map();
  const out = [];
  for (const e of events) { // events must be time-ascending
    const t = Date.parse(e.time);
    const k = keyOf(e);
    const s = open.get(k);
    if (s && t - s.lastTs <= gapMs) {
      s.hits++; s.last = e.time; s.lastTs = t; s.events.push(e);
    } else {
      const ns = { first: e.time, last: e.time, lastTs: t, hits: 1, device: e.device, client: e.client, events: [e] };
      out.push(ns); open.set(k, ns);
    }
  }
  return out;
}

// ── Status builder ──
function buildStatus(email, c) {
  const regAt = email.registeredAt || 0;
  const senderIp = email.senderIp || '';

  // 1. drop hits that are not the recipient (delivery scans / sender viewing their own mail)
  const opens = (email.opens || []).filter(o => {
    const msSince = regAt ? Date.parse(o.time) - regAt : 999999;
    if (o.proxy && msSince < c.prefetchMs) return false;
    if (!o.proxy && senderIp && o.ip === senderIp && msSince < c.selfOpenMs) return false;
    if (!o.proxy && msSince === 999999) return false;
    return true;
  });

  // 2. view sessions: top + bottom pixels from the same visitor within the gap are ONE session.
  // A "fully read" verdict needs more than just seeing the bottom pixel fire: most webmail
  // clients (Gmail's image proxy especially) fetch every image in a message the instant it's
  // opened, regardless of scroll position, so the top and bottom pixel normally land together
  // within the same instant whether or not anyone actually scrolled down. Only count it as read
  // when the bottom pixel arrives a meaningful stretch of time after the top one — that gap is
  // what a real person scrolling/reading looks like instead of one proxy fetching both at once.
  const viewKey = o => (o.proxy ? 'gmail-proxy' : `${o.ip}|${uaFP(o.ua)}`);
  const viewSessions = sessionize(opens, viewKey, c.sessionGapMs).map((s, i) => {
    const tops = s.events.filter(e => e.pixelType === 'top').map(e => Date.parse(e.time));
    const bottoms = s.events.filter(e => e.pixelType === 'bottom').map(e => Date.parse(e.time));
    const firstTop = tops.length ? Math.min(...tops) : null;
    const firstBottom = bottoms.length ? Math.min(...bottoms) : null;
    const read = firstBottom != null && (firstTop == null || firstBottom - firstTop >= c.readDelayMs);
    return {
      n: i + 1,
      read,
      first: s.first, last: s.last, hits: s.hits, device: s.device, client: s.client, ...sessionLocation(s.events),
    };
  });
  const readSessions = viewSessions.filter(s => s.read);

  // 3. links + clicks (bots/scanners are counted separately, never as people)
  const linkStats = {};
  const clickTimeline = [];
  let humanClicks = 0, botClicks = 0;
  const allHuman = [];
  for (const [lid, l] of Object.entries(email.links || {})) {
    const human = (l.clicks || []).filter(x => {
      if (x.bot) return false;
      // The sender's own browser can silently prefetch a link that just became visible in their
      // Sent view (page preloading, a link-preview feature) — but that happens within moments of
      // sending, not minutes later. A click is a deliberate action, so this window is much
      // shorter than the self-*view* one for opens: otherwise anyone on the sender's own network
      // (including the sender themself, testing from a different browser) gets silently ignored
      // for a full five minutes after every send.
      const msSince = regAt ? Date.parse(x.time) - regAt : 999999;
      if (senderIp && x.ip === senderIp && msSince < c.selfClickMs) return false;
      return true;
    });
    botClicks += (l.clicks || []).filter(x => x.bot).length;
    humanClicks += human.length;
    allHuman.push(...human);
    const sessions = sessionize(human, x => `${x.ip}|${uaFP(x.ua)}`, c.sessionGapMs);
    linkStats[lid] = {
      url: l.url, label: l.label || l.url,
      trackedUrl: `${c.base}/l/${email.trackingId}/${lid}`,
      clicks: human.length,
      sessions: sessions.length,
      lastClicked: human.at(-1)?.time || null,
    };
    for (const s of sessions) {
      clickTimeline.push({ type: 'link_clicked', url: l.url, label: l.label || l.url, time: s.first, lastSeen: s.last, hits: s.hits, device: s.device, client: s.client, ...sessionLocation(s.events) });
    }
  }
  allHuman.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const clickSessions = sessionize(allHuman, x => `${x.ip}|${uaFP(x.ua)}`, c.sessionGapMs).length;

  const timeline = [
    ...viewSessions.map(s => ({ type: s.read ? 'fully_read' : 'opened', time: s.first, lastSeen: s.last, hits: s.hits, session: s.n, device: s.device, client: s.client, location: s.location, locationUnavailable: s.locationUnavailable })),
    ...clickTimeline,
  ].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const state = readSessions.length ? 'fully_read' : viewSessions.length ? 'opened' : 'sent';

  return {
    trackingId: email.trackingId, subject: email.subject, recipient: email.recipient,
    senderEmail: email.senderEmail || '', createdAt: email.createdAt, state,
    openCount: viewSessions.length,          // number of separate viewing sessions
    fullyReadCount: readSessions.length,     // sessions that reached the end pixel
    openHits: opens.length,                  // raw pixel hits, for the curious
    clickCount: humanClicks,
    clickSessions,
    botClicks,
    lastOpened: viewSessions.at(-1)?.last || null,
    lastFullyRead: readSessions.at(-1)?.last || null,
    lastClicked: allHuman.at(-1)?.time || null,
    sessionGapMinutes: Math.round(c.sessionGapMs / 60000),
    opens: opens.map(o => ({ time: o.time, device: o.device, client: o.client, pixelType: o.pixelType, ...eventLocation(o) })),
    sessions: viewSessions,
    linkStats, timeline,
  };
}

// ── D1 access ──
const inList = arr => arr.map(() => '?').join(',');

async function dbGetEmails(db, ids, ownerHash) {
  ids = [...new Set(ids)].filter(id => UUID_RE.test(id)).slice(0, 50);
  if (!ids.length) return [];
  const rows = await db.prepare(
    `SELECT * FROM emails WHERE tracking_id IN (${inList(ids)}) AND owner_hash = ?`
  ).bind(...ids, ownerHash).all();
  const owned = rows.results.map(e => e.tracking_id);
  if (!owned.length) return [];

  const [opens, links, clicks] = await db.batch([
    db.prepare(`SELECT id, tracking_id, time, ip, ua, device, client, pixel_type, via_proxy FROM opens WHERE tracking_id IN (${inList(owned)}) ORDER BY time ASC`).bind(...owned),
    db.prepare(`SELECT link_id, tracking_id, url, label FROM links WHERE tracking_id IN (${inList(owned)}) ORDER BY created_at ASC`).bind(...owned),
    db.prepare(`SELECT id, link_id, tracking_id, time, ip, ua, device, client, is_bot FROM clicks WHERE tracking_id IN (${inList(owned)}) ORDER BY time ASC`).bind(...owned),
  ]);

  const byId = new Map(rows.results.map(e => [e.tracking_id, {
    trackingId: e.tracking_id, subject: e.subject, recipient: e.recipient, senderEmail: e.sender_email,
    senderIp: e.sender_ip, createdAt: e.created_at, registeredAt: e.registered_at,
    opens: [], links: {},
  }]));
  const locations = await optionalLocations(db, owned);
  for (const o of opens.results) {
    byId.get(o.tracking_id)?.opens.push({ time: o.time, ip: o.ip, ua: o.ua, device: o.device, client: o.client, pixelType: o.pixel_type, proxy: !!o.via_proxy, location: o.via_proxy ? null : locations?.[0].get(o.id) });
  }
  for (const l of links.results) {
    const e = byId.get(l.tracking_id); if (e) e.links[l.link_id] = { url: l.url, label: l.label, clicks: [] };
  }
  for (const c of clicks.results) {
    byId.get(c.tracking_id)?.links[c.link_id]?.clicks.push({ time: c.time, ip: c.ip, ua: c.ua, device: c.device, client: c.client, bot: !!c.is_bot, location: locations?.[1].get(c.id) });
  }
  // keep the order the caller asked for
  return ids.map(id => byId.get(id)).filter(Boolean);
}

async function dbGetEmailsChunked(db, ids, ownerHash) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) out.push(...await dbGetEmails(db, ids.slice(i, i + 50), ownerHash));
  return out;
}

async function recentIds(db, ownerHash, limit) {
  const r = await db.prepare(
    `SELECT tracking_id FROM emails WHERE owner_hash = ? AND (recipient != '' OR subject != '') ORDER BY created_at DESC LIMIT ?`
  ).bind(ownerHash, limit).all();
  return r.results.map(x => x.tracking_id);
}

const withEvents = s => s.timeline.map(t => ({ ...t, trackingId: s.trackingId, subject: s.subject, recipient: s.recipient }));

async function overLimit(db, ownerHash, c, kind) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  if (kind === 'emails') {
    const r = await db.prepare('SELECT COUNT(*) n FROM emails WHERE owner_hash = ? AND created_at > ?').bind(ownerHash, since).first();
    return (r?.n || 0) >= c.emailsPerHour;
  }
  const r = await db.prepare(
    'SELECT COUNT(*) n FROM links l JOIN emails e ON e.tracking_id = l.tracking_id WHERE e.owner_hash = ? AND l.created_at > ?'
  ).bind(ownerHash, since).first();
  return (r?.n || 0) >= c.linksPerHour;
}

// An ID can only be claimed once: a different owner cannot take it over.
async function claimTracking(db, trackingId, ownerHash) {
  const [reg, email] = await Promise.all([
    db.prepare('SELECT owner_hash FROM reg_timestamps WHERE tracking_id = ?').bind(trackingId).first(),
    db.prepare('SELECT owner_hash FROM emails WHERE tracking_id = ?').bind(trackingId).first(),
  ]);
  const existing = email?.owner_hash || reg?.owner_hash || '';
  return !existing || existing === ownerHash;
}

// Optional location metadata. Core event INSERTs and counting never depend on this.
function queueLocationWrite(request, env, ctx, table, result, proxy = false) {
  try {
    if (env.LOCATION_ENABLED === 'false' || proxy || typeof ctx?.waitUntil !== 'function') return;
    const id = Number(result?.meta?.last_row_id);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const cf = request.cf;
    const city = typeof cf?.city === 'string' ? cf.city.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : '';
    const country = typeof cf?.country === 'string' && /^[A-Za-z]{2}$/.test(cf.country) ? cf.country.toUpperCase() : '';
    if (!city && !country) return;
    // Runs after the original recording operation committed. Missing columns/errors are ignored.
    const task = Promise.resolve().then(() => env.DB.prepare(
      'UPDATE ' + table + ' SET city = ?, country = ? WHERE id = ?'
    ).bind(city, country, id).run()).catch(() => {});
    ctx.waitUntil(task);
  } catch { /* Metadata must never change the pixel/redirect response. */ }
}
async function optionalLocations(db, owned) {
  let timer;
  try {
    const query = db.batch(['opens','clicks'].map(table => db.prepare(
      'SELECT id, city, country FROM ' + table + ' WHERE tracking_id IN (' + inList(owned) + ')'
    ).bind(...owned))).then(rows => rows.map(r => new Map(r.results.map(e => [e.id, {
      city: typeof e.city === 'string' ? e.city : '', country: typeof e.country === 'string' ? e.country : ''
    }])))).catch(() => null);
    return await Promise.race([query, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
  } catch { return null; } finally { clearTimeout(timer); }
}
function eventLocation(event) {
  if (event.proxy) return { location: null, locationUnavailable: 'mail_proxy' };
  const loc = event.location;
  return loc && (loc.city || loc.country)
    ? { location: { city: loc.city || '', country: loc.country || '', approximate: true }, locationUnavailable: null }
    : { location: null, locationUnavailable: 'unavailable' };
}
function sessionLocation(events) {
  return eventLocation(events.find(e => !e.proxy && (e.location?.city || e.location?.country)) || events[0] || {});
}

// ── Pixel ──
async function handlePixel(request, env, pixelType, ctx) {
  const c = cfg(env);
  const db = env.DB;
  const id = new URL(request.url).pathname.replace(/^\/(pixel|read)\//, '').replace(/\.(gif|png|jpg)$/i, '');
  if (!UUID_RE.test(id)) return pixelResponse();

  const ua = request.headers.get('user-agent') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (isBotPixel(ua)) return pixelResponse();

  // Only IDs the extension pre-registered may write. Random URLs cost nothing.
  const reg = await db.prepare('SELECT registered_at, owner_hash FROM reg_timestamps WHERE tracking_id = ?').bind(id).first();
  if (!reg) return pixelResponse();

  const since = new Date(Date.now() - c.dupMs).toISOString();
  const dup = await db.prepare(
    'SELECT 1 x FROM opens WHERE tracking_id = ? AND pixel_type = ? AND ip = ? AND ua = ? AND time > ? LIMIT 1'
  ).bind(id, pixelType, ip, ua, since).first();
  if (dup) return pixelResponse();

  const proxy = isProxy(ua);
  const recorded = await db.batch([
    // If the recipient beats the send-time registration, keep the hit: create the row, register() fills it in.
    db.prepare(
      `INSERT OR IGNORE INTO emails(tracking_id, subject, recipient, sender_email, sender_ip, created_at, registered_at, options, owner_hash)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).bind(id, '', '', '', '', nowIso(), reg.registered_at, '{}', reg.owner_hash || ''),
    db.prepare(
      'INSERT INTO opens(tracking_id, time, ip, ua, device, client, pixel_type, via_proxy) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(id, nowIso(), ip, ua, getDevice(ua), getClient(ua), pixelType, proxy ? 1 : 0),
  ]);
  queueLocationWrite(request, env, ctx, 'opens', recorded[1], proxy);
  return pixelResponse();
}

// ── Link redirect ──
async function handleLink(request, env, ctx) {
  const c = cfg(env);
  const parts = new URL(request.url).pathname.split('/');
  const tid = parts[2], lid = (parts[3] || '').replace(/\.[a-z]+$/i, '');
  const fallback = () => new Response(null, { status: 302, headers: { Location: c.base, 'Cache-Control': 'no-store' } });
  if (!UUID_RE.test(tid) || !LINK_ID_RE.test(lid)) return fallback();

  const link = await env.DB.prepare('SELECT url, tracking_id FROM links WHERE link_id = ? AND tracking_id = ?').bind(lid, tid).first();
  if (!link) return fallback();
  const target = safeUrl(link.url, c.base);
  if (!target) return fallback();

  const redirect = new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' } });
  if (request.method === 'HEAD') return redirect; // scanners often HEAD first — don't count it

  const ua = request.headers.get('user-agent') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  const since = new Date(Date.now() - c.dupMs).toISOString();
  const dup = await env.DB.prepare(
    'SELECT 1 x FROM clicks WHERE link_id = ? AND ip = ? AND ua = ? AND time > ? LIMIT 1'
  ).bind(lid, ip, ua, since).first();
  if (!dup) {
    const recorded = await env.DB.prepare(
      'INSERT INTO clicks(link_id, tracking_id, time, ip, ua, device, client, is_bot) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(lid, tid, nowIso(), ip, ua, getDevice(ua), getClient(ua), isBotClick(ua) ? 1 : 0).run();
    if (!isBotClick(ua)) queueLocationWrite(request, env, ctx, 'clicks', recorded, isProxy(ua));
  }
  return redirect;
}

// ── Retention ──
async function purge(env) {
  const c = cfg(env);
  const cutoff = new Date(Date.now() - c.retentionDays * 86400_000).toISOString();
  const old = `(SELECT tracking_id FROM emails WHERE created_at < ?)`;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM clicks WHERE tracking_id IN ${old}`).bind(cutoff),
    env.DB.prepare(`DELETE FROM links  WHERE tracking_id IN ${old}`).bind(cutoff),
    env.DB.prepare(`DELETE FROM opens  WHERE tracking_id IN ${old}`).bind(cutoff),
    env.DB.prepare('DELETE FROM emails WHERE created_at < ?').bind(cutoff),
    // compose windows that were never sent
    env.DB.prepare('DELETE FROM reg_timestamps WHERE registered_at < ? AND tracking_id NOT IN (SELECT tracking_id FROM emails)').bind(Date.now() - 7 * 86400_000),
  ]);
}

// ── Admin (only if you set a secret: `wrangler secret put ADMIN_TOKEN`) ──
async function admin(request, env, path) {
  const token = env.ADMIN_TOKEN;
  const auth = request.headers.get('authorization') || '';
  if (!token || auth !== `Bearer ${token}`) return new Response('Not found', { status: 404 });
  if (path === '/api/admin/stats') {
    const q = t => env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first().then(r => r.n);
    const [emails, opens, links, clicks] = await Promise.all([q('emails'), q('opens'), q('links'), q('clicks')]);
    const owners = (await env.DB.prepare(`SELECT COUNT(DISTINCT owner_hash) n FROM emails WHERE owner_hash != ''`).first()).n;
    return json({ emails, opens, links, clicks, owners });
  }
  if (path === '/api/admin/purge') { await purge(env); return json({ ok: true }); }
  // Raw hits for one tracking ID, user-agent included — for diagnosing a specific
  // suspicious open/click (e.g. a scanner UA our bot list doesn't know about yet).
  // Not exposed anywhere in the dashboard; only reachable with the admin token.
  if (/^\/api\/admin\/raw\/[^/]+$/.test(path)) {
    const id = path.split('/').pop();
    if (!UUID_RE.test(id)) return json({ error: 'bad id' }, 400);
    const [email, opens, links, clicks] = await Promise.all([
      env.DB.prepare('SELECT * FROM emails WHERE tracking_id = ?').bind(id).first(),
      env.DB.prepare('SELECT time, ip, ua, device, client, pixel_type, via_proxy FROM opens WHERE tracking_id = ? ORDER BY time ASC').bind(id).all(),
      env.DB.prepare('SELECT link_id, url FROM links WHERE tracking_id = ?').bind(id).all(),
      env.DB.prepare('SELECT link_id, time, ip, ua, device, client, is_bot FROM clicks WHERE tracking_id = ? ORDER BY time ASC').bind(id).all(),
    ]);
    return json({ email, opens: opens.results, links: links.results, clicks: clicks.results });
  }
  return new Response('Not found', { status: 404 });
}

// ── Router ──
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.DB;
    const c = cfg(env);

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    try {
      // Public routes (recipient-facing). They can only write for IDs the extension registered.
      if (method === 'GET' && /^\/pixel\/.+/.test(path)) return await handlePixel(request, env, 'top', ctx);
      if (method === 'GET' && /^\/read\/.+/.test(path)) return await handlePixel(request, env, 'bottom', ctx);
      if ((method === 'GET' || method === 'HEAD') && /^\/l\/[^/]+\/[^/]+/.test(path)) return await handleLink(request, env, ctx);
      if (method === 'GET' && path === '/api/health') return json({ ok: true, v: 2 });

      if (path.startsWith('/api/admin/')) return await admin(request, env, path);

      // Everything else under /api needs the owner key
      if (path.startsWith('/api/')) {
        const owner = await ownerFrom(request);
        if (!owner) return json({ error: 'missing or invalid X-Traced-Key' }, 401);

        // pre-register: the compose window opened
        if (method === 'POST' && path === '/api/pre-register') {
          const { trackingId } = await readJson(request);
          if (!UUID_RE.test(trackingId || '')) return json({ error: 'bad trackingId' }, 400);
          if (!(await claimTracking(db, trackingId, owner))) return json({ error: 'id already claimed' }, 403);
          await db.prepare(
            `INSERT INTO reg_timestamps(tracking_id, registered_at, sender_ip, owner_hash) VALUES(?,?,?,?)
             ON CONFLICT(tracking_id) DO UPDATE SET registered_at = excluded.registered_at, sender_ip = excluded.sender_ip`
          ).bind(trackingId, Date.now(), request.headers.get('cf-connecting-ip') || '', owner).run();
          return json({ ok: true });
        }

        // register: the email was sent
        if (method === 'POST' && path === '/api/register') {
          const body = await readJson(request);
          const trackingId = body.trackingId;
          if (!UUID_RE.test(trackingId || '')) return json({ error: 'bad trackingId' }, 400);
          if (!(await claimTracking(db, trackingId, owner))) return json({ error: 'id already claimed' }, 403);
          if (await overLimit(db, owner, c, 'emails')) return json({ error: 'rate limited' }, 429);

          const ip = request.headers.get('cf-connecting-ip') || '';
          const ts = Date.now();
          const options = body.options && typeof body.options === 'object' ? JSON.stringify(body.options).slice(0, 2000) : '{}';
          await db.batch([
            db.prepare(
              `INSERT INTO reg_timestamps(tracking_id, registered_at, sender_ip, owner_hash) VALUES(?,?,?,?)
               ON CONFLICT(tracking_id) DO UPDATE SET registered_at = excluded.registered_at, sender_ip = excluded.sender_ip`
            ).bind(trackingId, ts, ip, owner),
            db.prepare(
              `INSERT INTO emails(tracking_id, subject, recipient, sender_email, sender_ip, created_at, registered_at, options, owner_hash)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tracking_id) DO UPDATE SET
                 subject = excluded.subject, recipient = excluded.recipient, sender_email = excluded.sender_email,
                 sender_ip = excluded.sender_ip, registered_at = excluded.registered_at, options = excluded.options,
                 owner_hash = excluded.owner_hash`
            ).bind(trackingId, clip(body.subject, 300), clip(body.recipient, 320).toLowerCase(), clip(body.senderEmail, 320).toLowerCase(), ip, nowIso(), ts, options, owner),
          ]);

          // Links sent with the email: [{ id, url, label }]  (ids are chosen by the extension so the
          // tracked URL can be written into the message body before Send returns)
          const accepted = [], rejected = [];
          const incoming = Array.isArray(body.links) ? body.links.slice(0, 100) : [];
          if (incoming.length && !(await overLimit(db, owner, c, 'links'))) {
            const stmts = [];
            for (const l of incoming) {
              const target = safeUrl(l?.url, c.base);
              if (!target || !LINK_ID_RE.test(String(l?.id || ''))) { rejected.push(l?.id || null); continue; }
              stmts.push(db.prepare(
                'INSERT OR IGNORE INTO links(link_id, tracking_id, url, label, created_at) VALUES(?,?,?,?,?)'
              ).bind(l.id, trackingId, target, clip(l.label || target, 200), nowIso()));
              accepted.push(l.id);
            }
            if (stmts.length) await db.batch(stmts);
          }
          return json({
            trackingId,
            pixelUrl: `${c.base}/pixel/${trackingId}.gif`,
            bottomPixel: `${c.base}/read/${trackingId}.gif`,
            links: { accepted, rejected },
          });
        }

        // register a single link (the "Add Traced Link" button)
        if (method === 'POST' && path === '/api/register-link') {
          const body = await readJson(request);
          const tid = body.trackingId;
          if (!UUID_RE.test(tid || '')) return json({ error: 'bad trackingId' }, 400);
          const target = safeUrl(body.url, c.base);
          if (!target) return json({ error: 'url must be a normal http(s) link' }, 400);
          if (!(await claimTracking(db, tid, owner))) return json({ error: 'id already claimed' }, 403);
          if (await overLimit(db, owner, c, 'links')) return json({ error: 'rate limited' }, 429);

          const linkId = LINK_ID_RE.test(String(body.linkId || '')) ? body.linkId : randomHex(8);
          await db.batch([
            db.prepare(
              `INSERT OR IGNORE INTO emails(tracking_id, subject, recipient, sender_email, sender_ip, created_at, registered_at, options, owner_hash)
               VALUES(?,?,?,?,?,?,?,?,?)`
            ).bind(tid, '', '', '', '', nowIso(), Date.now(), '{}', owner),
            db.prepare('INSERT OR IGNORE INTO links(link_id, tracking_id, url, label, created_at) VALUES(?,?,?,?,?)')
              .bind(linkId, tid, target, clip(body.label || target, 200), nowIso()),
          ]);
          return json({ trackedUrl: `${c.base}/l/${tid}/${linkId}`, linkId, trackingId: tid });
        }

        // status
        if (method === 'GET' && /^\/api\/status\/[^/]+$/.test(path)) {
          const [email] = await dbGetEmails(db, [path.split('/').pop()], owner);
          return email ? json(buildStatus(email, c)) : json({ error: 'Not found' }, 404);
        }
        if (method === 'POST' && path === '/api/status/bulk') {
          const { ids = [] } = await readJson(request);
          const emails = await dbGetEmails(db, Array.isArray(ids) ? ids.slice(0, 20) : [], owner);
          const out = {};
          for (const e of emails) out[e.trackingId] = buildStatus(e, c);
          return json(out);
        }

        // lists (own data only)
        if (method === 'GET' && path === '/api/emails') {
          const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 200);
          return json(await recentIds(db, owner, limit));
        }
        if (method === 'GET' && path === '/api/dashboard') {
          const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 200);
          const emails = await dbGetEmailsChunked(db, await recentIds(db, owner, limit), owner);
          const statuses = emails.map(e => buildStatus(e, c));
          const activity = statuses.flatMap(withEvents).sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 100);
          return json({ emails: statuses, activity });
        }
        if (method === 'GET' && path === '/api/activity') {
          const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 100);
          const emails = await dbGetEmails(db, await recentIds(db, owner, 20), owner);
          const events = emails.map(e => buildStatus(e, c)).flatMap(withEvents)
            .sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, limit);
          return json(events);
        }

        // delete (own data only)
        if (method === 'DELETE' && path === '/api/emails') {
          const mine = `(SELECT tracking_id FROM emails WHERE owner_hash = ?)`;
          await db.batch([
            db.prepare(`DELETE FROM clicks WHERE tracking_id IN ${mine}`).bind(owner),
            db.prepare(`DELETE FROM links  WHERE tracking_id IN ${mine}`).bind(owner),
            db.prepare(`DELETE FROM opens  WHERE tracking_id IN ${mine}`).bind(owner),
            db.prepare('DELETE FROM emails WHERE owner_hash = ?').bind(owner),
            db.prepare('DELETE FROM reg_timestamps WHERE owner_hash = ?').bind(owner),
          ]);
          return json({ ok: true });
        }
        if (method === 'DELETE' && /^\/api\/emails\/[^/]+$/.test(path)) {
          const id = path.split('/').pop();
          if (!UUID_RE.test(id)) return json({ error: 'bad id' }, 400);
          const own = await db.prepare('SELECT 1 x FROM emails WHERE tracking_id = ? AND owner_hash = ?').bind(id, owner).first();
          if (!own) return json({ error: 'Not found' }, 404);
          await db.batch([
            db.prepare('DELETE FROM clicks WHERE tracking_id = ?').bind(id),
            db.prepare('DELETE FROM links  WHERE tracking_id = ?').bind(id),
            db.prepare('DELETE FROM opens  WHERE tracking_id = ?').bind(id),
            db.prepare('DELETE FROM emails WHERE tracking_id = ?').bind(id),
            db.prepare('DELETE FROM reg_timestamps WHERE tracking_id = ? AND owner_hash = ?').bind(id, owner),
          ]);
          return json({ ok: true });
        }

        return json({ error: 'Not found' }, 404);
      }
    } catch (err) {
      if (err?.message === 'too-large') return json({ error: 'payload too large' }, 413);
      console.error('[traced]', err?.stack || err);
      // recipient-facing routes must never surface an error
      if (/^\/(pixel|read)\//.test(path)) return pixelResponse();
      if (/^\/l\//.test(path)) return new Response(null, { status: 302, headers: { Location: c.base } });
      return json({ error: 'server error' }, 500);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purge(env));
  },
};
