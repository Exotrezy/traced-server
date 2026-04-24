/**
 * Traced — Email Tracking Server
 * Hosted at traced.mikaelsyed.me via Render (free tier)
 *
 * Storage: in-memory by default.
 * To enable persistence, set USE_SUPABASE=true and configure SUPABASE_URL + SUPABASE_ANON_KEY env vars.
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const app     = express();
const PORT    = process.env.PORT    || 3000;
const BASE_URL = process.env.BASE_URL || 'https://traced.mikaelsyed.me';

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  STORAGE LAYER (swap for Supabase/Mongo in production)
// ─────────────────────────────────────────────────────────────
// Schema per tracking record:
// {
//   trackingId: string,
//   subject: string,
//   recipient: string,
//   createdAt: ISO string,
//   opens: [{ time, ip, ua, device, client, pixelType: 'top'|'bottom' }],
//   links: { [linkId]: { url: string, clicks: [{ time, ip, ua, device, client }] } }
//   options: { trackOpens, trackLinks, trackFullRead, addWatermark }
// }
const store = {};

// ─────────────────────────────────────────────────────────────
//  DEVICE / CLIENT DETECTION
// ─────────────────────────────────────────────────────────────
function detectDevice(ua = '') {
  const u = ua.toLowerCase();
  if (/iphone|android.*mobile/.test(u))           return 'mobile';
  if (/ipad|tablet|android(?!.*mobile)/.test(u))  return 'tablet';
  return 'desktop';
}

function detectClient(ua = '') {
  const u = ua.toLowerCase();
  if (u.includes('gmail'))                                return 'Gmail App';
  if (u.includes('outlook') || u.includes('microsoft'))  return 'Outlook';
  if (u.includes('applemail') || (u.includes('darwin') && !u.includes('chrome'))) return 'Apple Mail';
  if (u.includes('thunderbird'))                          return 'Thunderbird';
  if (u.includes('yahoo'))                                return 'Yahoo Mail';
  if (u.includes('chrome'))                               return 'Chrome';
  if (u.includes('firefox'))                              return 'Firefox';
  if (u.includes('safari') && !u.includes('chrome'))      return 'Safari';
  return 'Unknown';
}

function clientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || '—';
}

// ─────────────────────────────────────────────────────────────
//  PIXEL RESPONSE  (1×1 transparent GIF, never cached)
// ─────────────────────────────────────────────────────────────
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function sendPixel(res) {
  res.set({
    'Content-Type':  'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0',
    'Surrogate-Control': 'no-store',
  });
  res.send(PIXEL);
}

// ─────────────────────────────────────────────────────────────
//  TOP PIXEL  (email opened)
//  GET /pixel/:id.gif
// ─────────────────────────────────────────────────────────────
app.get('/pixel/:id', (req, res) => {
  const id = req.params.id.replace(/\.(gif|png|jpg)$/i, '');
  if (store[id]) {
    store[id].opens.push({
      time:      new Date().toISOString(),
      ip:        clientIP(req),
      ua:        req.headers['user-agent'] || '',
      device:    detectDevice(req.headers['user-agent']),
      client:    detectClient(req.headers['user-agent']),
      pixelType: 'top',
    });
  }
  sendPixel(res);
});

// ─────────────────────────────────────────────────────────────
//  BOTTOM PIXEL  (fully read — scrolled to end of email)
//  GET /read/:id.gif
// ─────────────────────────────────────────────────────────────
app.get('/read/:id', (req, res) => {
  const id = req.params.id.replace(/\.(gif|png|jpg)$/i, '');
  if (store[id]) {
    store[id].opens.push({
      time:      new Date().toISOString(),
      ip:        clientIP(req),
      ua:        req.headers['user-agent'] || '',
      device:    detectDevice(req.headers['user-agent']),
      client:    detectClient(req.headers['user-agent']),
      pixelType: 'bottom',
    });
  }
  sendPixel(res);
});

// ─────────────────────────────────────────────────────────────
//  LINK REDIRECT  (tracked link click)
//  GET /l/:trackingId/:linkId
// ─────────────────────────────────────────────────────────────
app.get('/l/:tid/:lid', (req, res) => {
  const { tid, lid } = req.params;
  const email = store[tid];
  if (!email || !email.links[lid]) return res.redirect(BASE_URL);

  email.links[lid].clicks.push({
    time:   new Date().toISOString(),
    ip:     clientIP(req),
    ua:     req.headers['user-agent'] || '',
    device: detectDevice(req.headers['user-agent']),
    client: detectClient(req.headers['user-agent']),
  });

  res.redirect(email.links[lid].url);
});

// ─────────────────────────────────────────────────────────────
//  API — Register a new tracked email
//  POST /api/register
//  Body: { subject, recipient, links: [url…], options: {} }
// ─────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { subject = '(no subject)', recipient = '', links = [], options = {} } = req.body;
  const trackingId = crypto.randomUUID();

  const linkMap = {};
  links.forEach(url => {
    linkMap[crypto.randomBytes(6).toString('hex')] = { url, clicks: [] };
  });

  store[trackingId] = {
    trackingId,
    subject,
    recipient,
    createdAt: new Date().toISOString(),
    opens:     [],
    links:     linkMap,
    options,
  };

  const linkReplacements = {};
  Object.entries(linkMap).forEach(([lid, { url }]) => {
    linkReplacements[url] = `${BASE_URL}/l/${trackingId}/${lid}`;
  });

  res.json({
    trackingId,
    pixelUrl:         `${BASE_URL}/pixel/${trackingId}.gif`,
    bottomPixel:      `${BASE_URL}/read/${trackingId}.gif`,
    linkReplacements,
  });
});

// ─────────────────────────────────────────────────────────────
//  HELPERS — build a rich status object
// ─────────────────────────────────────────────────────────────
function buildStatus(email) {
  const topOpens    = email.opens.filter(o => o.pixelType === 'top');
  const bottomOpens = email.opens.filter(o => o.pixelType === 'bottom');

  let state = 'sent';
  if (bottomOpens.length > 0)     state = 'fully_read';
  else if (topOpens.length > 0)   state = 'opened';

  const linkStats = {};
  Object.entries(email.links).forEach(([, data]) => {
    linkStats[data.url] = {
      clicks:      data.clicks.length,
      lastClicked: data.clicks.at(-1)?.time || null,
      clickHistory: data.clicks,
    };
  });

  const timeline = [
    ...email.opens.map(o => ({
      type:   o.pixelType === 'bottom' ? 'fully_read' : 'opened',
      time:   o.time,
      device: o.device,
      client: o.client,
    })),
    ...Object.values(email.links).flatMap(link =>
      link.clicks.map(c => ({
        type:   'link_clicked',
        url:    link.url,
        time:   c.time,
        device: c.device,
        client: c.client,
      }))
    ),
  ].sort((a, b) => new Date(a.time) - new Date(b.time));

  return {
    trackingId:      email.trackingId,
    subject:         email.subject,
    recipient:       email.recipient,
    createdAt:       email.createdAt,
    state,
    openCount:       topOpens.length,
    fullyReadCount:  bottomOpens.length,
    lastOpened:      topOpens.at(-1)?.time    || null,
    lastFullyRead:   bottomOpens.at(-1)?.time || null,
    opens:           email.opens,
    linkStats,
    timeline,
  };
}

// ─────────────────────────────────────────────────────────────
//  API — Single status
//  GET /api/status/:trackingId
// ─────────────────────────────────────────────────────────────
app.get('/api/status/:id', (req, res) => {
  const email = store[req.params.id];
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json(buildStatus(email));
});

// ─────────────────────────────────────────────────────────────
//  API — Bulk status
//  POST /api/status/bulk
//  Body: { ids: [trackingId…] }
// ─────────────────────────────────────────────────────────────
app.post('/api/status/bulk', (req, res) => {
  const result = {};
  (req.body.ids || []).forEach(id => {
    if (store[id]) result[id] = buildStatus(store[id]);
  });
  res.json(result);
});

// ─────────────────────────────────────────────────────────────
//  API — Activity feed (most recent events across all emails)
//  GET /api/activity?limit=30
// ─────────────────────────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const events = [];

  Object.values(store).forEach(email => {
    email.opens.forEach(o => events.push({
      type:        o.pixelType === 'bottom' ? 'fully_read' : 'opened',
      trackingId:  email.trackingId,
      subject:     email.subject,
      recipient:   email.recipient,
      time:        o.time,
      device:      o.device,
      client:      o.client,
    }));
    Object.values(email.links).forEach(link =>
      link.clicks.forEach(c => events.push({
        type:       'link_clicked',
        trackingId: email.trackingId,
        subject:    email.subject,
        recipient:  email.recipient,
        url:        link.url,
        time:       c.time,
        device:     c.device,
        client:     c.client,
      }))
    );
  });

  events.sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json(events.slice(0, limit));
});

// ─────────────────────────────────────────────────────────────
//  STATIC — landing, dashboard, privacy, downloads
// ─────────────────────────────────────────────────────────────
const PUBLIC = path.join(__dirname, 'public');

// Landing page → public/index.html (copy landing/index.html here at build time)
app.use(express.static(PUBLIC));

// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'dashboard', 'index.html'));
});
app.get('/dashboard/', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'dashboard', 'index.html'));
});

// Privacy
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'privacy', 'index.html'));
});

// Extension download
app.get('/downloads/traced-extension.zip', (req, res) => {
  const zipPath = path.join(PUBLIC, 'downloads', 'traced-extension.zip');
  if (fs.existsSync(zipPath)) {
    res.download(zipPath, 'traced-extension.zip');
  } else {
    res.status(404).json({ error: 'Extension zip not found. Please build it first.' });
  }
});

// Fallback to landing for unknown routes
app.get('*', (req, res) => {
  const index = path.join(PUBLIC, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.json({ ok: true, server: 'Traced', version: '1.1.0' });
});

app.listen(PORT, () => console.log(`✅ Traced server running on port ${PORT} — ${BASE_URL}`));
