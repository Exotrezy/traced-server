/**
 * Traced — Cloudflare Worker
 * Handles pixel tracking, link redirects, API, and static file serving
 * Storage: Cloudflare KV (TRACED_KV binding)
 */

const BASE_URL = 'https://traced.mikaelsyed.me';

// 1×1 transparent GIF
const PIXEL_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PIXEL_BYTES = Uint8Array.from(atob(PIXEL_B64), c => c.charCodeAt(0));

const PIXEL_HEADERS = {
  'Content-Type': 'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Access-Control-Allow-Origin': '*',
};

// ── Bot / Google Image Proxy detection ──
function isBotOrProxy(ua = '') {
  const u = ua.toLowerCase();
  return (
    u.includes('googleimageproxy') ||
    u.includes('googlebot') ||
    u.includes('mediapartners-google') ||
    u.includes('adsbot-google') ||
    u.includes('feedfetcher') ||
    u.includes('yahoo! slurp') ||
    u.includes('bingbot') ||
    u.includes('applebot') ||
    u.includes('facebookexternalhit') ||
    u.includes('twitterbot') ||
    u.includes('linkedinbot') ||
    u === '' // empty UA = likely a proxy/scanner
  );
}

// ── Check if the request IP matches the sender's registered IP ──
function isSenderIP(email, ip) {
  if (!email || !ip) return false;
  return email.senderIp === ip;
}

// ── Ignore opens within 45s of registration (catches Gmail Image Proxy pre-fetch) ──
function isTooSoon(email) {
  if (!email || !email.registeredAt) return false;
  return (Date.now() - email.registeredAt) < 45000;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Device / Client detection ───────────────────────────────
function detectDevice(ua = '') {
  const u = ua.toLowerCase();
  if (/iphone|android.*mobile/.test(u)) return 'mobile';
  if (/ipad|tablet|android(?!.*mobile)/.test(u)) return 'tablet';
  return 'desktop';
}

function detectClient(ua = '') {
  const u = ua.toLowerCase();
  if (u.includes('gmail')) return 'Gmail App';
  if (u.includes('outlook') || u.includes('microsoft')) return 'Outlook';
  if (u.includes('applemail') || (u.includes('darwin') && !u.includes('chrome'))) return 'Apple Mail';
  if (u.includes('thunderbird')) return 'Thunderbird';
  if (u.includes('yahoo')) return 'Yahoo Mail';
  if (u.includes('chrome')) return 'Chrome';
  if (u.includes('firefox')) return 'Firefox';
  if (u.includes('safari') && !u.includes('chrome')) return 'Safari';
  return 'Unknown';
}

// ─── KV helpers ──────────────────────────────────────────────
async function getEmail(kv, id) {
  const raw = await kv.get(id);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveEmail(kv, id, data) {
  // Keep for 90 days
  await kv.put(id, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 90 });
}

// ─── UUID / random ────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID();
}

function randomHex(bytes = 6) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Build status object ─────────────────────────────────────
function buildStatus(email) {
  const topOpens = email.opens.filter(o => o.pixelType === 'top');
  const bottomOpens = email.opens.filter(o => o.pixelType === 'bottom');

  let state = 'sent';
  if (bottomOpens.length > 0) state = 'fully_read';
  else if (topOpens.length > 0) state = 'opened';

  const linkStats = {};
  Object.entries(email.links || {}).forEach(([, data]) => {
    linkStats[data.url] = {
      clicks: data.clicks.length,
      lastClicked: data.clicks.at(-1)?.time || null,
      clickHistory: data.clicks,
    };
  });

  const timeline = [
    ...email.opens.map(o => ({
      type: o.pixelType === 'bottom' ? 'fully_read' : 'opened',
      time: o.time,
      device: o.device,
      client: o.client,
    })),
    ...Object.values(email.links || {}).flatMap(link =>
      link.clicks.map(c => ({
        type: 'link_clicked',
        url: link.url,
        time: c.time,
        device: c.device,
        client: c.client,
      }))
    ),
  ].sort((a, b) => new Date(a.time) - new Date(b.time));

  return {
    trackingId: email.trackingId,
    subject: email.subject,
    recipient: email.recipient,
    createdAt: email.createdAt,
    state,
    openCount: topOpens.length,
    fullyReadCount: bottomOpens.length,
    lastOpened: topOpens.at(-1)?.time || null,
    lastFullyRead: bottomOpens.at(-1)?.time || null,
    opens: email.opens,
    linkStats,
    timeline,
  };
}

// ─── Response helpers ────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function pixelResponse() {
  return new Response(PIXEL_BYTES, { headers: PIXEL_HEADERS });
}

// ─── Main fetch handler ───────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const kv = env.TRACED_KV;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    // ── GET /pixel/:id  (top pixel — email opened) ──
    if (method === 'GET' && path.match(/^\/pixel\/(.+)/)) {
      const id = path.replace('/pixel/', '').replace(/\.(gif|png|jpg)$/i, '');
      const ua = request.headers.get('user-agent') || '';
      const ip = request.headers.get('cf-connecting-ip') || '';

      // Ignore bots, Google Image Proxy, sender IP, and opens within 45s of send
      const email1 = await getEmail(kv, id);
      if (!isBotOrProxy(ua) && !isSenderIP(email1, ip) && !isTooSoon(email1)) {
        if (email1) {
          email1.opens.push({
            time: new Date().toISOString(),
            ip,
            ua,
            device: detectDevice(ua),
            client: detectClient(ua),
            pixelType: 'top',
          });
          await saveEmail(kv, id, email1);
        }
      }
      return pixelResponse();
    }

    // ── GET /read/:id  (bottom pixel — fully read) ──
    if (method === 'GET' && path.match(/^\/read\/(.+)/)) {
      const id = path.replace('/read/', '').replace(/\.(gif|png|jpg)$/i, '');
      const ua = request.headers.get('user-agent') || '';
      const ip = request.headers.get('cf-connecting-ip') || '';

      const email2 = await getEmail(kv, id);
      if (!isBotOrProxy(ua) && !isSenderIP(email2, ip) && !isTooSoon(email2)) {
        if (email2) {
          email2.opens.push({
            time: new Date().toISOString(),
            ip,
            ua,
            device: detectDevice(ua),
            client: detectClient(ua),
            pixelType: 'bottom',
          });
          await saveEmail(kv, id, email2);
        }
      }
      return pixelResponse();
    }

    // ── GET /l/:tid/:lid  (link click redirect) ──
    if (method === 'GET' && path.match(/^\/l\/[^/]+\/[^/]+/)) {
      const parts = path.split('/');
      const tid = parts[2];
      const lid = parts[3];
      const email = await getEmail(kv, tid);
      if (!email || !email.links[lid]) {
        return Response.redirect(BASE_URL, 302);
      }
      const ua = request.headers.get('user-agent') || '';
      email.links[lid].clicks.push({
        time: new Date().toISOString(),
        ip: request.headers.get('cf-connecting-ip') || '',
        ua,
        device: detectDevice(ua),
        client: detectClient(ua),
      });
      await saveEmail(kv, tid, email);
      return Response.redirect(email.links[lid].url, 302);
    }

    // ── POST /api/register ──
    if (method === 'POST' && path === '/api/register') {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const { subject = '(no subject)', recipient = '', links = [], options = {} } = body;
      const trackingId = uuid();

      const linkMap = {};
      links.forEach(url => {
        linkMap[randomHex(6)] = { url, clicks: [] };
      });

      const emailData = {
        trackingId,
        subject,
        recipient,
        createdAt: new Date().toISOString(),
        registeredAt: Date.now(), // used to ignore immediate proxy hits
        opens: [],
        links: linkMap,
        options,
        senderIp: request.headers.get('cf-connecting-ip') || '',
      };

      await saveEmail(kv, trackingId, emailData);

      // Also update the index list for /api/activity
      let index = [];
      try {
        const raw = await kv.get('__index__');
        if (raw) index = JSON.parse(raw);
      } catch {}
      index.unshift(trackingId);
      if (index.length > 500) index = index.slice(0, 500);
      await kv.put('__index__', JSON.stringify(index), { expirationTtl: 60 * 60 * 24 * 90 });

      const linkReplacements = {};
      Object.entries(linkMap).forEach(([lid, { url }]) => {
        linkReplacements[url] = `${BASE_URL}/l/${trackingId}/${lid}`;
      });

      return jsonResponse({
        trackingId,
        pixelUrl: `${BASE_URL}/pixel/${trackingId}.gif`,
        bottomPixel: `${BASE_URL}/read/${trackingId}.gif`,
        linkReplacements,
      });
    }

    // ── GET /api/status/:id ──
    if (method === 'GET' && path.match(/^\/api\/status\/[^/]+$/)) {
      const id = path.split('/').pop();
      const email = await getEmail(kv, id);
      if (!email) return jsonResponse({ error: 'Not found' }, 404);
      return jsonResponse(buildStatus(email));
    }

    // ── POST /api/status/bulk ──
    if (method === 'POST' && path === '/api/status/bulk') {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const ids = body.ids || [];
      const result = {};
      await Promise.all(ids.map(async id => {
        const email = await getEmail(kv, id);
        if (email) result[id] = buildStatus(email);
      }));
      return jsonResponse(result);
    }

    // ── GET /api/emails ── returns all tracking IDs (for dashboard)
    if (method === 'GET' && path === '/api/emails') {
      let index = [];
      try {
        const raw = await kv.get('__index__');
        if (raw) index = JSON.parse(raw);
      } catch {}
      return jsonResponse(index);
    }

    // ── DELETE /api/emails ── clears all tracked emails from KV
    if (method === 'DELETE' && path === '/api/emails') {
      let index = [];
      try {
        const raw = await kv.get('__index__');
        if (raw) index = JSON.parse(raw);
      } catch {}
      // Delete each email record and the index
      await Promise.all(index.map(id => kv.delete(id)));
      await kv.delete('__index__');
      return jsonResponse({ cleared: index.length });
    }

    // ── GET /api/activity ──
    if (method === 'GET' && path === '/api/activity') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100);
      let index = [];
      try {
        const raw = await kv.get('__index__');
        if (raw) index = JSON.parse(raw);
      } catch {}

      const events = [];
      await Promise.all(index.slice(0, 50).map(async id => {
        const email = await getEmail(kv, id);
        if (!email) return;
        email.opens.forEach(o => events.push({
          type: o.pixelType === 'bottom' ? 'fully_read' : 'opened',
          trackingId: email.trackingId,
          subject: email.subject,
          recipient: email.recipient,
          time: o.time,
          device: o.device,
          client: o.client,
        }));
        Object.values(email.links || {}).forEach(link =>
          link.clicks.forEach(c => events.push({
            type: 'link_clicked',
            trackingId: email.trackingId,
            subject: email.subject,
            recipient: email.recipient,
            url: link.url,
            time: c.time,
            device: c.device,
            client: c.client,
          }))
        );
      }));

      events.sort((a, b) => new Date(b.time) - new Date(a.time));
      return jsonResponse(events.slice(0, limit));
    }

    // ── Static files served from /public via Assets binding ──
    // Cloudflare Pages/Workers Assets handles this automatically
    // when wrangler.toml has assets configured

    // Fallback
    return new Response('Not found', { status: 404 });
  },
};
