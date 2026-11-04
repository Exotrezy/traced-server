// Display optional location metadata without using it for counts or session grouping.
function eventPlace(event) {
  const loc = event?.location;
  if (loc && (loc.city || loc.country)) {
    let country = loc.country || '';
    try { if (country) country = new Intl.DisplayNames([navigator.language || 'en'], {type:'region'}).of(country) || country; } catch {}
    return [loc.city, country].filter(Boolean).join(', ') + ' (approx.)';
  }
  return event?.locationUnavailable === 'mail_proxy' ? 'Location unavailable (mail proxy)' : '';
}
function recentPlace(data) {
  const events = [...(data.timeline || [])].reverse();
  const located = events.find(e => e.location?.city || e.location?.country);
  if (located) return (located.type === 'link_clicked' ? 'Click: ' : 'Open: ') + eventPlace(located);
  return events.some(e => e.locationUnavailable === 'mail_proxy') ? 'Location unavailable (mail proxy)' : '';
}

// popup.js — Traced popup. Renders from local storage instantly, then refreshes from the server.
// All server-derived text is inserted with textContent (never innerHTML).

const $ = id => document.getElementById(id);
const SETTING_KEYS = ['trackOpens', 'trackLinks', 'trackFullRead', 'notifications', 'addWatermark'];
const DEFAULTS = { trackOpens: true, trackLinks: true, trackFullRead: true, notifications: true, addWatermark: false };
const send = msg => new Promise(res => chrome.runtime.sendMessage(msg, r => res(chrome.runtime.lastError ? null : r)));

let emails = [];
let filter = 'all';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const NS = 'http://www.w3.org/2000/svg';
function svg(viewBox, paths, cls) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', viewBox); s.setAttribute('fill', 'none');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  if (cls) s.setAttribute('class', cls);
  for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
function ago(iso) {
  if (!iso) return '';
  const d = Date.now() - Date.parse(iso);
  if (d < 6e4) return 'now';
  if (d < 36e5) return `${Math.floor(d / 6e4)}m`;
  if (d < 864e5) return `${Math.floor(d / 36e5)}h`;
  if (d < 7 * 864e5) return `${Math.floor(d / 864e5)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── Settings ──
async function loadSettings() {
  const { settings = {}, tracedEnabled } = await chrome.storage.sync.get(['settings', 'tracedEnabled']);
  const s = { ...DEFAULTS, ...settings };
  for (const k of SETTING_KEYS) $(k).checked = !!s[k];
  $('tracedEnabled').checked = tracedEnabled !== false;
  paintMaster();
}
function paintMaster() {
  const on = $('tracedEnabled').checked;
  $('master-label').textContent = on ? 'On' : 'Paused';
  const b = $('banner');
  b.hidden = on;
  if (!on) b.textContent = 'Tracking is paused. Emails you send now won’t be tracked.';
}
$('tracedEnabled').addEventListener('change', async e => {
  await chrome.storage.sync.set({ tracedEnabled: e.target.checked });
  paintMaster();
});
for (const k of SETTING_KEYS) {
  $(k).addEventListener('change', async e => {
    const { settings = {} } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...DEFAULTS, ...settings, [k]: e.target.checked } });
  });
}
$('settings-btn').addEventListener('click', () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('settings-btn').setAttribute('aria-expanded', String(open));
});

// Delete-all with inline confirmation (no alert() dialogs)
$('delete-btn').addEventListener('click', () => { $('delete-btn').hidden = true; $('confirm').hidden = false; });
$('delete-no').addEventListener('click', () => { $('confirm').hidden = true; $('delete-btn').hidden = false; });
$('delete-yes').addEventListener('click', async () => {
  const r = await send({ type: 'DELETE_ALL' });
  $('confirm').hidden = true; $('delete-btn').hidden = false;
  $('delete-btn').textContent = r?.ok ? 'Deleted' : 'Couldn’t delete — try again';
  setTimeout(() => { $('delete-btn').textContent = 'Delete all my tracking data'; }, 2500);
  load(false);
});

// ── List ──
function render() {
  const sorted = [...emails].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const opened = sorted.filter(e => e.state === 'opened' || e.state === 'fully_read');
  $('st-total').textContent = sorted.length;
  $('st-opened').textContent = opened.length;
  $('st-read').textContent = sorted.filter(e => e.state === 'fully_read').length;
  $('st-clicks').textContent = sorted.filter(e => (e.clickSessions || 0) > 0).length;

  const shown = filter === 'opened' ? opened : filter === 'unopened' ? sorted.filter(e => (e.state || 'sent') === 'sent') : sorted;
  const list = $('list');
  list.replaceChildren();

  if (!shown.length) {
    const box = el('div', 'empty');
    box.append(svg('0 0 24 24', ['M3 7l9 6 9-6', 'M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z']));
    if (!sorted.length) {
      box.append(el('h3', null, 'No tracked emails yet'), el('p', null, 'Compose in Gmail as usual. Traced adds tracking when you hit Send.'));
      const a = el('a', 'btn', 'Open Gmail'); a.href = 'https://mail.google.com/'; a.target = '_blank'; a.rel = 'noopener';
      box.append(a);
    } else {
      box.append(el('h3', null, filter === 'opened' ? 'Nothing opened yet' : 'Everything has been opened'), el('p', null, 'Check back soon. This updates automatically.'));
    }
    list.append(box);
    return;
  }

  for (const e of shown.slice(0, 30)) {
    const state = e.state || 'sent';
    const item = el('div', 'item');
    const tick = svg('0 0 18 14', ['M2 7.5l3.6 3.6L11 3.5', 'M7.6 11.1l.6.6L14.6 3.5'], `tick s-${state}`);
    tick.setAttribute('stroke', 'currentColor');
    tick.lastChild.setAttribute('opacity', state === 'sent' ? '.55' : '1');

    const body = el('div', 'body');
    body.append(el('div', 'subj', e.subject || '(no subject)'));
    const bits = [];
    if (state === 'sent') bits.push(`Waiting for ${e.recipient || 'recipient'}`);
    else {
      bits.push(state === 'fully_read' ? 'Read' : 'Opened');
      if ((e.openCount || 0) > 1) bits.push(plural(e.openCount, 'session'));
    }
    if ((e.clickCount || 0) > 0) bits.push(plural(e.clickCount, 'click'));
    const meta = el('div', 'meta', bits.join(' · ')); meta.title = e.recipient || '';
    body.append(meta);
    const place = recentPlace(e);
    if (place) body.append(el('div', 'meta-location', place));

    const when = el('div', 'when', ago(e.lastClicked || e.lastFullyRead || e.lastOpened || e.createdAt));
    item.append(tick, body, when);
    list.append(item);
  }
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  filter = t.dataset.f;
  document.querySelectorAll('.tab').forEach(x => { const on = x === t; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); });
  render();
}));

async function load(poll = true) {
  const all = await send({ type: 'GET_ALL' });
  emails = Object.values(all || {});
  render();
  if (!poll) return;
  $('refresh-btn').classList.add('spin');
  await send({ type: 'POLL_NOW' });
  const fresh = await send({ type: 'GET_ALL' });
  emails = Object.values(fresh || {});
  $('refresh-btn').classList.remove('spin');
  render();
  const { pollMeta } = await chrome.storage.local.get('pollMeta');
  if (pollMeta && pollMeta.ok === false && $('tracedEnabled').checked) {
    $('banner').hidden = false; $('banner').textContent = 'Can’t reach Traced right now. Showing saved data.';
  }
}
$('refresh-btn').addEventListener('click', () => load(true));

// Dashboard link carries the per-install key in the URL *fragment* (never sent to any server in a request)
send({ type: 'DASHBOARD_URL' }).then(r => { if (r?.url) $('dashboard-link').href = r.url; });
$('ver').textContent = `v${chrome.runtime.getManifest().version}`;

// Keep an open popup synchronized with background cache changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.trackedEmails) {
    emails = Object.values(changes.trackedEmails.newValue || {});
    render();
  }
});
loadSettings();
load(true);
