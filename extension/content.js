// content.js — Traced content script for Gmail (v1.2)
//
// - All network access goes through the background worker (it owns the owner key).
// - No network calls on DOM mutations. Gmail re-renders constantly; v1 fetched the global
//   activity feed on every burst of mutations.
// - Everything shown from server data is built with textContent, never innerHTML.

const API = 'https://traced.mikaelsyed.me';
const API_HOST = new URL(API).host;

// ── Settings ──
let settings = { trackOpens: true, trackLinks: true, trackFullRead: true, addWatermark: false };
let enabled = true; // master switch controlled by the extension popup
chrome.storage.sync.get(['settings', 'tracedEnabled'], ({ settings: s, tracedEnabled }) => {
  if (s) settings = { ...settings, ...s };
  enabled = tracedEnabled !== false;
  paintComposeControls();
});
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'sync') {
    if (c.settings) { settings = { ...settings, ...c.settings.newValue }; paintComposeControls(); }
    if (c.tracedEnabled) enabled = c.tracedEnabled.newValue !== false;
  }
  if (area === 'local') {
    if (c.trackedEmails) { cache.tracked = c.trackedEmails.newValue || {}; renderAllRows(); updateSelfHide(); }
    if (c.emailKeyMap) cache.keyMap = c.emailKeyMap.newValue || {};
    if (c.lastEvent?.newValue) showActivity(c.lastEvent.newValue);
  }
});

const cache = { tracked: {}, keyMap: {} };
chrome.storage.local.get(['trackedEmails', 'emailKeyMap'], ({ trackedEmails = {}, emailKeyMap = {} }) => {
  cache.tracked = trackedEmails; cache.keyMap = emailKeyMap; renderAllRows(); updateSelfHide();
});

// ── Small helpers ──
const uuid = () => crypto.randomUUID();
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const genKey = (s, r) => `${(s || '').toLowerCase().trim()}::${(r || '').toLowerCase().trim()}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const send = msg => new Promise(res => { try { chrome.runtime.sendMessage(msg, r => res(chrome.runtime.lastError ? null : r)); } catch { res(null); } });

/** h('div', {class:'x', onclick: fn}, 'text', childNode) — builds DOM without innerHTML */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function tickSvg() {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'traced-tick'); s.setAttribute('viewBox', '0 0 10 8'); s.setAttribute('fill', 'none');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', 'M1 4L3.5 6.5L9 1'); p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  s.append(p); return s;
}
function ago(iso) {
  if (!iso) return '';
  const d = Date.now() - Date.parse(iso);
  if (d < 6e4) return 'just now';
  if (d < 36e5) return `${Math.floor(d / 6e4)}m ago`;
  if (d < 864e5) return `${Math.floor(d / 36e5)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function safeHost(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } }

// The account email is in Gmail's tab title ("Inbox (3) - you@gmail.com - Gmail"), which is far
// more stable than Gmail's obfuscated class names.
function detectSender() {
  const t = document.title.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (t) return t[0].toLowerCase();
  const el = document.querySelector('[aria-label*="Google Account"]');
  return (el?.getAttribute('aria-label') || '').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0]?.toLowerCase() || '';
}

// ── Boot: Gmail is a single-page app, so re-check on DOM changes and navigation ──
const tryInjectAll = debounce(() => {
  hookSendButtons(); injectComposeControls(); renderAllRows();
  repositionComposeFabs(); pruneClosedComposeFabs();
}, 250);
new MutationObserver(tryInjectAll).observe(document.body, { childList: true, subtree: true });
window.addEventListener('hashchange', tryInjectAll);
window.addEventListener('resize', tryInjectAll);
window.addEventListener('scroll', tryInjectAll, true);
setTimeout(tryInjectAll, 800);

// ══ Compose window: pre-register the ID, add the link button and footer pill ══
const composeIds = new WeakMap();
const composeSel = '.AD, .aHU';
const footerSel = '.btC, .aDh, .aZo, .IZ';

function composeBody(win) {
  return win.querySelector('[contenteditable="true"][aria-label*="Message Body"], .Am.Al.editable, [contenteditable="true"].Am, div[contenteditable="true"][role="textbox"]')
    || win.querySelector('[contenteditable="true"]');
}

// A floating control, not a row inserted into Gmail's own compose layout. An earlier version
// added a bar directly above Gmail's Send toolbar — but Gmail's compose popup has a fixed
// height, so that extra row pushed the Send/attach icons down and cropped them. Floating over
// the window (fixed position, not in its document flow) means it can never resize or squeeze
// anything Gmail draws, however the window shuffles (reply vs. new message, mobile-width inbox,
// minimized/expanded compose).
const composeFabs = [];

function composeIsDark(win) {
  let node = composeBody(win) || win;
  while (node && node !== document.body) {
    const bg = getComputedStyle(node).backgroundColor;
    const values = bg.match(/[\d.]+/g)?.map(Number);
    if (bg.startsWith('rgb') && values?.length >= 3 && (values.length < 4 || values[3] >= 0.9)) {
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722 < 128;
    }
    node = node.parentElement;
  }
  return false;
}

function paintComposeControls() {
  for (const { win, controls, footerButton } of composeFabs) {
    const on = settings.addWatermark === true;
    footerButton.classList.toggle('on', on);
    footerButton.setAttribute('aria-pressed', String(on));
    footerButton.title = 'Traced footer: ' + (on ? 'on' : 'off') + '. Include a Tracked with Traced footer in tracked emails.';
    controls.dataset.theme = composeIsDark(win) ? 'dark' : 'light';
  }
}

function injectComposeControls() {
  document.querySelectorAll(composeSel).forEach(win => {
    if (composeIds.has(win)) return;
    const footer = win.querySelector(footerSel);
    if (!footer) return;
    const id = uuid();
    composeIds.set(win, id);
    win.dataset.tracedId = id;
    send({ type: 'PRE_REGISTER', payload: { trackingId: id } });

    const footerButton = h('button', { type: 'button', class: 'traced-compose-button traced-footer-button', 'aria-pressed': 'false' },
      h('span', { class: 'traced-footer-indicator', 'aria-hidden': 'true' }), 'Traced footer');
    footerButton.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      chrome.storage.sync.get('settings', ({ settings: s = {} }) => {
        chrome.storage.sync.set({ settings: { ...s, addWatermark: !s.addWatermark } }, () => {
          settings = { ...settings, ...s, addWatermark: !s.addWatermark };
          paintComposeControls();
        });
      });
    });
    const linkIcon = h('span', { class: 'traced-compose-link-icon', 'aria-hidden': 'true' });
    linkIcon.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
    const linkButton = h('button', { type: 'button', class: 'traced-compose-button traced-link-button', title: 'Add a tracked link and see when it is clicked' }, linkIcon, 'Add Traced Link');
    linkButton.addEventListener('mousedown', ev => ev.preventDefault()); // Keep the insertion point in the message.
    linkButton.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); showLinkModal(win, id); });
    const controls = h('div', { class: 'traced-compose-controls', role: 'group', 'aria-label': 'Traced email tools' }, footerButton, linkButton);
    document.body.append(controls);
    composeFabs.push({ win, controls, footerButton, linkButton });
    paintComposeControls();
    positionComposeFab(win, controls);
  });
}

function positionComposeFab(win, controls) {
  if (!document.body.contains(win)) return;
  const footer = win.querySelector(footerSel);
  const rect = (footer || win).getBoundingClientRect();
  const bounds = win.getBoundingClientRect();
  const bodyRect = composeBody(win)?.getBoundingClientRect();
  if (!rect.width || !rect.height || !bodyRect?.height || bounds.height < 160) { controls.style.display = 'none'; return; }
  controls.style.display = '';
  controls.dataset.theme = composeIsDark(win) ? 'dark' : 'light';
  const left = Math.max(8, rect.left + 4);
  controls.style.maxWidth = Math.max(0, Math.min(bounds.right - left - 10, innerWidth - left - 8)) + 'px';
  controls.style.left = left + 'px';
  controls.style.top = Math.max(8, rect.top - controls.offsetHeight - 8) + 'px';
}

function repositionComposeFabs() {
  for (const { win, controls } of composeFabs) positionComposeFab(win, controls);
}

function pruneClosedComposeFabs() {
  for (let i = composeFabs.length - 1; i >= 0; i--) {
    const { win, controls } = composeFabs[i];
    if (!document.body.contains(win)) { controls.remove(); composeFabs.splice(i, 1); }
  }
}

// ── Link modal ──
function showLinkModal(win, tid) {
  document.getElementById('traced-link-modal')?.remove();
  const url = h('input', { id: 'traced-url-input', type: 'url', placeholder: 'https://example.com', autocomplete: 'off' });
  const label = h('input', { type: 'text', placeholder: 'Link text (optional)', autocomplete: 'off' });
  const status = h('div', { class: 'traced-modal-status', role: 'status' });
  const insert = h('button', { type: 'button', class: 'traced-btn primary' }, 'Insert link');
  const cancel = h('button', { type: 'button', class: 'traced-btn' }, 'Cancel');
  const modal = h('div', { id: 'traced-link-modal' },
    h('div', { class: 'traced-modal', role: 'dialog', 'aria-label': 'Add a Traced link' },
      h('div', { class: 'traced-modal-title' }, 'Add a Traced link'),
      h('p', { class: 'traced-modal-sub' }, 'Recipients go straight to your URL. You’ll see each visit as a session.'),
      url, label, h('div', { class: 'traced-modal-actions' }, cancel, insert), status));
  document.body.append(modal);
  url.focus();
  const close = () => modal.remove();
  cancel.addEventListener('click', close);
  modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') close(); if (e.key === 'Enter') insert.click(); });

  insert.addEventListener('click', async () => {
    const raw = url.value.trim();
    let ok = false; try { ok = /^https?:$/.test(new URL(raw).protocol); } catch { /* invalid */ }
    if (!ok) { status.textContent = 'Enter a full web address starting with https://'; status.className = 'traced-modal-status err'; return; }
    status.textContent = 'Creating tracked link…'; status.className = 'traced-modal-status';
    const r = await send({ type: 'REGISTER_LINK', payload: { url: raw, label: label.value.trim() || raw, trackingId: tid } });
    if (!r?.trackedUrl) { status.textContent = r?.error || 'Could not reach Traced. Check your connection.'; status.className = 'traced-modal-status err'; return; }
    const body = composeBody(win);
    if (body) {
      body.focus();
      const a = h('a', { href: r.trackedUrl }, label.value.trim() || raw);
      a.dataset.tracedDone = '1';
      document.execCommand('insertHTML', false, a.outerHTML);
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }
    status.textContent = 'Link inserted'; status.className = 'traced-modal-status ok';
    setTimeout(close, 500);
  });
}

// ══ Send interception ══
const hooked = new WeakSet();
function hookSendButtons() {
  document.querySelectorAll('[data-tooltip*="Send"], [aria-label*="Send"]').forEach(btn => {
    if (hooked.has(btn) || !btn.closest(composeSel + ', [role="dialog"]')) return;
    hooked.add(btn);
    btn.addEventListener('click', handleSend, { capture: true });
  });
}
document.addEventListener('keydown', e => {
  if (!((e.ctrlKey || e.metaKey) && e.key === 'Enter')) return;
  const win = e.target?.closest?.(composeSel) || document.querySelector(composeSel);
  if (win) handleSend({ target: win });
}, true);

/**
 * IMPORTANT: everything that edits the message must happen synchronously, before the first
 * `await`, because Gmail serialises the compose body as soon as this click handler returns.
 */
function handleSend(e) {
  if (!enabled) return;
  if (!settings.trackOpens && !settings.trackLinks) return;
  const win = e.target.closest?.(composeSel) || e.target.closest?.('[role="dialog"]');
  if (!win) return;
  const bodyEl = composeBody(win);
  if (!bodyEl) return;
  const tid = composeIds.get(win) || win.dataset.tracedId || uuid();
  if (win.dataset.tracedSent === tid) return;           // click + Ctrl+Enter must not double-inject
  win.dataset.tracedSent = tid;

  const toEls = [...win.querySelectorAll('input[name="to"], [name="to"]')];
  const chips = [...win.querySelectorAll('.vO [data-hovercard-id], .aB.gQ span[email], span[email]')].map(x => x.getAttribute('email') || x.getAttribute('data-hovercard-id'));
  const recipient = (toEls.map(x => x.value).find(Boolean) || chips.find(Boolean) || '').trim();
  const subjEl = win.querySelector('[name="subjectbox"], .aoT');
  let subject = (subjEl?.value || subjEl?.textContent || '').trim();
  if (!subject) subject = (document.querySelector('h2.hP, .ha h2')?.textContent || '').replace(/^(Re|Fwd):\s*/i, '').trim() || 'Untitled';

  // 1. Rewrite links (text stays exactly as the sender wrote it)
  const links = [];
  if (settings.trackLinks) {
    bodyEl.querySelectorAll('a[href]').forEach(a => {
      if (links.length >= 50 || a.dataset.tracedDone) return;
      let u; try { u = new URL(a.href); } catch { return; }
      if (!/^https?:$/.test(u.protocol) || u.host === API_HOST || u.host === 'mail.google.com') return;
      const id = hex(8);
      links.push({ id, url: a.href, label: (a.textContent || '').trim().slice(0, 200) || a.href });
      a.href = `${API}/l/${tid}/${id}`;
      a.dataset.tracedDone = '1';
    });
  }
  // 2. Pixels (insertAdjacentHTML keeps existing nodes, unlike innerHTML = a + innerHTML)
  if (settings.trackOpens) {
    bodyEl.insertAdjacentHTML('afterbegin', `<div data-tracked="${tid}" style="background-image:url('${API}/pixel/${tid}.gif');width:1px;height:1px;overflow:hidden;font-size:0;line-height:0;"></div>`);
    if (settings.trackFullRead) {
      bodyEl.insertAdjacentHTML('beforeend', `<div data-tracked="${tid}" style="background-image:url('${API}/read/${tid}.gif');width:1px;height:1px;overflow:hidden;font-size:0;line-height:0;"></div>`);
    }
  }
  if (settings.addWatermark) {
    bodyEl.insertAdjacentHTML('beforeend', '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e8e8e8;font:11.5px Arial,sans-serif;color:#999;">Tracked with <a href="https://traced.mikaelsyed.me" style="color:#5f8a00;font-weight:700;text-decoration:none;">Traced</a></div>');
  }
  bodyEl.dispatchEvent(new Event('input', { bubbles: true }));

  // 3. Now (async) tell the server. The background keeps an offline queue if this fails.
  const senderEmail = detectSender();
  send({ type: 'REGISTER_EMAIL', payload: { subject, recipient, links, options: { ...settings }, trackingId: tid, senderEmail } });
  [5000, 30000, 90000].forEach(ms => setTimeout(() => send({ type: 'POLL_NOW' }), ms));
}

// ══ Sent-list checkmarks ══
function findTid(subject, recipient) {
  const sl = subject.toLowerCase().trim();
  return cache.keyMap[genKey(subject, recipient)]
    || Object.entries(cache.keyMap).find(([k]) => k.startsWith(sl + '::'))?.[1]
    || Object.values(cache.tracked).find(v => v.subject && v.subject.toLowerCase().trim() === sl)?.trackingId;
}

let rendering = false;
function renderAllRows() {
  // Remove a visible mark after its local tracking record was confirmed deleted.
  document.querySelectorAll('.traced-checks[data-tracking-id]').forEach(mark => {
    if (!cache.tracked[mark.dataset.trackingId]) mark.remove();
  });
  if (rendering || !Object.keys(cache.tracked).length) return;
  const rows = document.querySelectorAll('tr.zA');
  if (!rows.length) return;
  rendering = true;
  try {
    rows.forEach(row => {
      const bog = row.querySelector('.bog');
      if (!bog) return;
      const subject = (bog.querySelector('.bqe') || bog.querySelector('span:first-child'))?.textContent.trim() || bog.textContent.split('—')[0].trim();
      if (!subject) return;
      const rEl = row.querySelector('.yW span[email], .zF[email], .yW span, .zF');
      const recipient = (rEl?.getAttribute('email') || rEl?.textContent.replace(/^To:\s*/i, '') || '').trim();
      const tid = findTid(subject, recipient);
      const data = tid && cache.tracked[tid];
      if (!data) return;
      const sig = `${tid}|${data.state}|${data.openCount}|${data.fullyReadCount}|${data.clickSessions}|${data.clickCount}|${recentPlace(data)}`;
      if (row.dataset.tracedSig === sig && row.querySelector('.traced-checks')) return;
      renderCheckmark(row, tid, data);
      row.dataset.tracedSig = sig;
    });
  } finally { rendering = false; }
}

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

function tooltipEl(d) {
  const state = d.state || 'sent';
  const title = state === 'fully_read' ? 'Read to the end' : state === 'opened' ? 'Opened' : 'Not opened yet';
  const lines = [h('strong', null, title), h('div', null, `To: ${d.recipient || '—'}`)];
  if (d.openCount > 0) {
    const clients = [...new Set((d.opens || []).map(o => o.client).filter(Boolean))].join(', ');
    lines.push(h('div', null, `${d.openCount} ${d.openCount === 1 ? 'open' : 'opens'}${clients ? ' · ' + clients : ''}`));
  }
  if (d.fullyReadCount > 0) lines.push(h('div', null, `Read to the end: ${d.fullyReadCount}×`));
  if (d.clickCount > 0) {
    const ses = d.clickSessions > 1 ? ` in ${d.clickSessions} sessions` : '';
    lines.push(h('div', null, `Link clicks: ${d.clickCount}${ses}`));
  }
  if (d.lastOpened) lines.push(h('div', { class: 'traced-tip-dim' }, `Last seen ${ago(d.lastOpened)}`));
  const place = recentPlace(d);
  if (place) lines.push(h('div', { class: 'traced-tip-dim' }, place));
  lines.push(h('div', { class: 'traced-tip-dim' }, 'Click for details'));
  return h('div', { class: 'traced-tooltip' }, lines);
}

function renderCheckmark(row, tid, d) {
  row.querySelector('.traced-checks')?.remove();
  const state = d.state || 'sent';
  const cls = state === 'fully_read' ? 'traced-fully-read' : state === 'opened' ? 'traced-opened' : 'traced-sent';
  const count = state === 'sent' ? 0 : (d.openCount || 0);
  const wrap = h('div', { class: 'traced-checks', 'data-tracking-id': tid },
    h('span', { class: `traced-check-inner ${cls}` }, tickSvg(), tickSvg(), count > 1 ? h('span', { class: 'traced-count' }, count) : null),
    tooltipEl(d));

  const yW = row.querySelector('.yW');
  const cell = yW ? yW.closest('td') : row.cells?.[3];
  if (!cell) return;
  cell.style.display = 'flex'; cell.style.alignItems = 'center'; cell.style.gap = '5px'; cell.style.overflow = 'visible';
  if (yW?.nextSibling) cell.insertBefore(wrap, yW.nextSibling); else cell.append(wrap);

  wrap.addEventListener('click', async ev => {
    ev.stopPropagation(); ev.preventDefault();
    const fresh = await send({ type: 'GET_STATUS', trackingId: tid });
    showPanel(fresh && !fresh.error ? fresh : d);
  });
}

// ══ Analytics panel (sessions timeline) ══
function showPanel(d) {
  document.getElementById('traced-panel')?.remove();
  const rows = (d.timeline || []).slice(-12).reverse().map(e => {
    const meta = [e.device, e.client].filter(Boolean).join(' · ');
    let title, sub;
    if (e.type === 'link_clicked') {
      title = `Clicked ${safeHost(e.url) || 'a link'}`;
      sub = `${ago(e.time)}${e.hits > 1 ? ` · ${e.hits} clicks in this visit` : ''}${meta ? ' · ' + meta : ''}`;
    } else {
      title = `${e.type === 'fully_read' ? 'Read to the end' : 'Opened'}${e.session ? ` · session ${e.session}` : ''}`;
      sub = `${ago(e.time)}${meta ? ' · ' + meta : ''}`;
    }
    const place = eventPlace(e);
    if (place) sub += ' · ' + place;
    return h('div', { class: `traced-tl-row t-${e.type}` }, h('span', { class: 'traced-tl-dot' }),
      h('div', { class: 'traced-tl-info' }, h('span', { class: 'traced-tl-title' }, title), h('span', { class: 'traced-tl-meta' }, sub)));
  });
  const stat = (n, l) => h('div', { class: 'traced-stat' }, h('div', { class: 'traced-stat-num' }, n), h('div', { class: 'traced-stat-lbl' }, l));
  const close = h('button', { type: 'button', class: 'traced-panel-close', 'aria-label': 'Close' }, '×');
  const refresh = h('button', { type: 'button', class: 'traced-panel-close', 'aria-label': 'Refresh', title: 'Refresh' }, '↻');
  const panel = h('div', { id: 'traced-panel', class: 'traced-analytics-panel', role: 'dialog', 'aria-label': 'Traced analytics' },
    h('div', { class: 'traced-panel-header' },
      h('div', { class: 'traced-panel-titles' }, h('div', { class: 'traced-panel-title' }, d.subject || '(no subject)'), h('div', { class: 'traced-panel-sub' }, `To ${d.recipient || '—'}`)),
      h('div', { class: 'traced-panel-btns' }, refresh, close)),
    h('div', { class: 'traced-panel-stats' }, stat(d.openCount || 0, 'Opens'), stat(d.fullyReadCount || 0, 'Read'), stat(d.clickCount || 0, 'Clicks')),
    d.clickSessions > 1 ? h('div', { class: 'traced-panel-sessions' }, `${d.clickCount} clicks across ${d.clickSessions} separate visits`) : null,
    h('div', { class: 'traced-panel-section' }, 'Sessions'),
    h('div', { class: 'traced-timeline' }, rows.length ? rows : h('div', { class: 'traced-empty' }, 'No activity yet. Opens and clicks show up here as they happen.')),
    h('div', { class: 'traced-panel-footer' }, `A new session starts after ${d.sessionGapMinutes || 15} min without activity.`));
  document.body.append(panel);
  requestAnimationFrame(() => panel.classList.add('traced-panel-visible'));
  const shut = () => { panel.classList.remove('traced-panel-visible'); setTimeout(() => panel.remove(), 250); };
  close.addEventListener('click', shut);
  refresh.addEventListener('click', async () => { const f = await send({ type: 'GET_STATUS', trackingId: d.trackingId }); if (f && !f.error) showPanel(f); });
}

// ══ Activity toast (driven by the background poll, no network here) ══
let lastToast = null;
function showActivity(ev) {
  if (!ev || ev.id === lastToast || document.visibilityState !== 'visible') return;
  lastToast = ev.id;
  document.querySelector('.traced-activity-bar')?.remove();
  const verb = ev.type === 'fully_read' ? 'read to the end' : ev.type === 'link_clicked' ? 'clicked a link in' : 'opened';
  const bar = h('div', { class: 'traced-activity-bar', role: 'status' },
    h('span', { class: `traced-act-dot d-${ev.type}` }),
    h('span', { class: 'traced-act-text' }, h('strong', null, ev.recipient || 'Someone'), ` ${verb} “${ev.subject || 'your email'}”`),
    ev.device || ev.client ? h('span', { class: 'traced-act-chip' }, [ev.device, ev.client].filter(Boolean).join(' · ')) : null,
    h('button', { type: 'button', class: 'traced-act-close', 'aria-label': 'Dismiss' }, '×'));
  bar.querySelector('button').addEventListener('click', () => bar.remove());
  document.body.append(bar);
  requestAnimationFrame(() => bar.classList.add('traced-act-visible'));
  setTimeout(() => { bar.classList.remove('traced-act-visible'); setTimeout(() => bar.remove(), 400); }, 8000);
}

// ══ Don't count the sender looking at their own sent mail ══
// Hides the tracking pixels of THIS user's own emails in their own Gmail (a hidden element
// never loads its background image). Only own IDs are listed, so mail from other Traced users
// is unaffected. Best effort; the server also filters sender self-views.
function updateSelfHide() {
  const ids = Object.keys(cache.tracked).slice(0, 150).filter(id => /^[0-9a-f-]{36}$/i.test(id));
  let st = document.getElementById('traced-self-hide');
  if (!st) { st = document.createElement('style'); st.id = 'traced-self-hide'; (document.head || document.documentElement).append(st); }
  st.textContent = ids.length ? ids.map(id => `[data-tracked="${id}"],[style*="${id}"]`).join(',') + '{display:none!important}' : '';
}
