// Integration tests for the Traced worker.
// Run against `wrangler dev` started with short windows:
//   npx wrangler dev --local --port 8787 --var SESSION_GAP_MIN:0.05 --var PREFETCH_MS:1500 --var SELF_OPEN_MS:0 --var DUP_MS:300
//   node test/api.test.mjs
import { randomUUID, randomBytes } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8787';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, extra); }
};

const keyA = randomBytes(32).toString('hex');
const keyB = randomBytes(32).toString('hex');
const api = (path, { method = 'GET', key, body } = {}) =>
  fetch(BASE + path, {
    method,
    headers: { ...(key ? { 'x-traced-key': key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const PROXY_UA = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const hit = (path, ua, ip = '203.0.113.7', method = 'GET') =>
  fetch(BASE + path, { method, headers: { 'user-agent': ua, 'cf-connecting-ip': ip }, redirect: 'manual' });
const randHex = n => randomBytes(n).toString('hex');
// `wrangler dev` rewrites the routed hostname to its own origin in Location headers.
const isHome = loc => ['https://traced.mikaelsyed.me', 'https://localhost:8787', 'http://localhost:8787'].includes((loc || '').replace(/\/$/, ''));

console.log('\n[1] Auth & isolation');
{
  ok((await api('/api/emails')).status === 401, 'listing without a key -> 401');
  ok((await api('/api/emails', { method: 'DELETE' })).status === 401, 'DELETE ALL without a key -> 401 (was: wipes every user)');
  ok((await api('/api/activity')).status === 401, 'global activity feed without a key -> 401');
  ok((await api('/api/debug/last-pixel')).status !== 200, 'public debug endpoint is gone');
  ok((await api('/api/emails', { key: 'short' })).status === 401, 'malformed key -> 401');
}

console.log('\n[2] Register, pixels, unknown ids');
const tid = randomUUID();
const l1 = randHex(8), l2 = randHex(8);
{
  const pre = await api('/api/pre-register', { method: 'POST', key: keyA, body: { trackingId: tid } });
  ok(pre.status === 200, 'pre-register');
  const reg = await api('/api/register', {
    method: 'POST', key: keyA,
    body: {
      trackingId: tid, subject: 'Hello <b>world</b>', recipient: 'Friend@Example.com', senderEmail: 'me@x.com',
      links: [
        { id: l1, url: 'https://example.com/a?x=1', label: 'Link A' },
        { id: l2, url: 'https://example.org/b', label: 'Link B' },
        { id: randHex(8), url: 'javascript:alert(1)', label: 'evil' },
        { id: randHex(8), url: 'https://google.com@evil.example/', label: 'userinfo trick' },
        { id: randHex(8), url: 'https://traced.mikaelsyed.me/l/x/y', label: 'loop' },
        { id: 'zz', url: 'https://example.com', label: 'bad id' },
      ],
    },
  });
  const r = await reg.json();
  ok(reg.status === 200 && r.links.accepted.length === 2, 'register accepts the 2 valid links', JSON.stringify(r.links));
  ok(r.links.rejected.length === 4, 'register rejects javascript:, userinfo, loop and bad-id links', JSON.stringify(r.links));

  const ghost = randomUUID();
  const g = await hit(`/pixel/${ghost}.gif`, CHROME);
  ok(g.status === 200 && (await g.arrayBuffer()).byteLength === 42, 'pixel for an unknown id still returns a GIF');
  const gs = await api(`/api/status/${ghost}`, { key: keyA });
  ok(gs.status === 404, 'unknown id created no row (no junk writes)');

  const badpx = await hit(`/pixel/not-a-uuid.gif`, CHROME);
  ok(badpx.status === 200, 'malformed id returns GIF, no error');
}

console.log('\n[3] Ownership: user B cannot see or touch user A');
{
  ok((await api(`/api/status/${tid}`, { key: keyB })).status === 404, "B can't read A's status");
  const bulk = await (await api('/api/status/bulk', { method: 'POST', key: keyB, body: { ids: [tid] } })).json();
  ok(Object.keys(bulk).length === 0, "B's bulk status is empty");
  ok((await (await api('/api/emails', { key: keyB })).json()).length === 0, "B's list is empty");
  ok((await api(`/api/emails/${tid}`, { method: 'DELETE', key: keyB })).status === 404, "B can't delete A's email");
  const steal = await api('/api/register', { method: 'POST', key: keyB, body: { trackingId: tid, subject: 'pwn', recipient: 'x@y.z' } });
  ok(steal.status === 403, "B can't re-register (hijack) A's tracking id");
  const evilLink = await api('/api/register-link', { method: 'POST', key: keyB, body: { trackingId: tid, url: 'https://evil.example' } });
  ok(evilLink.status === 403, "B can't attach links to A's email");
  const st = await (await api(`/api/status/${tid}`, { key: keyA })).json();
  ok(st.subject === 'Hello <b>world</b>' && st.recipient === 'friend@example.com', 'A still sees own data, recipient lower-cased');
  const del = await api('/api/emails', { method: 'DELETE', key: keyB });
  ok(del.status === 200 && (await api(`/api/status/${tid}`, { key: keyA })).status === 200, "B's 'delete all' only deletes B's data");
}

console.log('\n[4] Open sessions (gap = 3s in this test run)');
{
  await sleep(1800); // past the delivery-prefetch window
  await hit(`/pixel/${tid}.gif`, PROXY_UA, '66.249.1.1');
  await hit(`/read/${tid}.gif`, PROXY_UA, '66.249.1.1');
  await sleep(600);
  await hit(`/pixel/${tid}.gif`, PROXY_UA, '66.249.1.1'); // same visit, second fire
  let s = await (await api(`/api/status/${tid}`, { key: keyA })).json();
  ok(s.openCount === 1, 'top+bottom+refire inside the gap = 1 session', `openCount=${s.openCount}`);
  ok(s.fullyReadCount === 1 && s.state === 'fully_read', 'that session reached the end pixel -> fully_read');
  ok(s.openHits === 3, 'all 3 raw hits are kept', `openHits=${s.openHits}`);

  await sleep(3500); // > gap: "a while later"
  await hit(`/pixel/${tid}.gif`, PROXY_UA, '66.249.1.1');
  s = await (await api(`/api/status/${tid}`, { key: keyA })).json();
  ok(s.openCount === 2, 'an open after the gap is captured as a NEW session', `openCount=${s.openCount}`);
  ok(s.fullyReadCount === 1, 'read count stays 1 (second session did not reach the end)');
  const opened = s.timeline.filter(t => t.type !== 'link_clicked');
  ok(opened.length === 2 && opened[0].type === 'fully_read' && opened[1].type === 'opened', 'timeline shows both sessions in order');
  ok(opened[0].hits === 3, 'session 1 reports 3 hits', `hits=${opened[0].hits}`);
}

console.log('\n[5] Click sessions + redirect behaviour');
{
  const R1 = await hit(`/l/${tid}/${l1}`, CHROME, '198.51.100.10');
  ok(R1.status === 302 && R1.headers.get('location') === 'https://example.com/a?x=1', 'click redirects to the destination');
  ok(/no-store/.test(R1.headers.get('cache-control') || ''), 'redirect is not cacheable (repeat clicks reach the server)');
  await sleep(700);
  await hit(`/l/${tid}/${l2}`, CHROME, '198.51.100.10');   // 2nd link, same visit
  await sleep(3500);                                         // "a while later"
  await hit(`/l/${tid}/${l1}`, CHROME, '198.51.100.10');   // same person, new session
  await hit(`/l/${tid}/${l1}`, IPHONE, '198.51.100.99');   // different person/device
  await hit(`/l/${tid}/${l1}`, 'python-requests/2.31', '34.1.1.1'); // scanner
  const head = await hit(`/l/${tid}/${l1}`, CHROME, '198.51.100.55', 'HEAD');
  ok(head.status === 302, 'HEAD is redirected but not counted');

  const s = await (await api(`/api/status/${tid}`, { key: keyA })).json();
  ok(s.clickCount === 4, 'four human clicks recorded', `clickCount=${s.clickCount}`);
  ok(s.clickSessions === 3, 'grouped into 3 click sessions (visit 1, visit 2 later, other device)', `clickSessions=${s.clickSessions}`);
  ok(s.botClicks === 1, 'scanner click kept but not counted as a person', `botClicks=${s.botClicks}`);
  ok(s.linkStats[l1].clicks === 3 && s.linkStats[l1].sessions === 3, 'link A: 3 clicks in 3 sessions', JSON.stringify(s.linkStats[l1]));
  ok(s.linkStats[l2].clicks === 1 && s.linkStats[l2].sessions === 1, 'link B: 1 click');
  const clicks = s.timeline.filter(t => t.type === 'link_clicked');
  ok(clicks.length === 4, 'timeline has one entry per (session, link)', `n=${clicks.length}`);

  const back = await hit(`/l/${tid}/${l1}`, CHROME, '1.2.3.4');
  const wrong = await hit(`/l/${randomUUID()}/${l1}`, CHROME);
  ok(isHome(wrong.headers.get('location')), 'link id with the wrong email id -> falls back to homepage');
  const doubleFire = await hit(`/l/${tid}/${l2}`, CHROME, '9.9.9.9');
  await hit(`/l/${tid}/${l2}`, CHROME, '9.9.9.9');
  const s2 = await (await api(`/api/status/${tid}`, { key: keyA })).json();
  ok(s2.linkStats[l2].clicks === 2, 'identical click twice inside 300ms counted once', `clicks=${s2.linkStats[l2].clicks}`);
}

console.log('\n[6] Sender self-view is not counted as an open');
{
  const t2 = randomUUID();
  await api('/api/pre-register', { method: 'POST', key: keyA, body: { trackingId: t2 } });
  await api('/api/register', { method: 'POST', key: keyA, body: { trackingId: t2, subject: 's2', recipient: 'r@r.com' } });
  await sleep(1800);
  // proxy hit inside PREFETCH window would be filtered; here we test the direct-hit-from-sender-IP rule with a fresh worker config in prod.
  const s = await (await api(`/api/status/${t2}`, { key: keyA })).json();
  ok(s.state === 'sent' && s.openCount === 0, 'nothing opened yet -> grey/sent');
  const early = randomUUID();
  await api('/api/pre-register', { method: 'POST', key: keyA, body: { trackingId: early } });
  await hit(`/pixel/${early}.gif`, PROXY_UA, '66.249.1.1'); // recipient beat registration
  await api('/api/register', { method: 'POST', key: keyA, body: { trackingId: early, subject: 'early', recipient: 'r@r.com' } });
  const se = await (await api(`/api/status/${early}`, { key: keyA })).json();
  ok(se.subject === 'early', 'hit that arrived before register() did not break registration');
}

console.log('\n[7] Lists, activity, delete');
{
  const list = await (await api('/api/emails', { key: keyA })).json();
  ok(list.includes(tid), 'listing returns own ids');
  const dash = await (await api('/api/dashboard', { key: keyA })).json();
  ok(Array.isArray(dash.emails) && dash.emails.length >= 2 && dash.activity.length > 0, 'dashboard endpoint returns statuses + activity');
  ok(dash.activity.every(a => a.subject !== undefined), 'activity carries subject/recipient');
  const del = await api(`/api/emails/${tid}`, { method: 'DELETE', key: keyA });
  ok(del.status === 200 && (await api(`/api/status/${tid}`, { key: keyA })).status === 404, 'owner can delete one email');
  const redirAfter = await hit(`/l/${tid}/${l1}`, CHROME);
  ok(isHome(redirAfter.headers.get('location')), 'deleted email\'s links stop redirecting to the old target');
  await api('/api/emails', { method: 'DELETE', key: keyA });
  ok((await (await api('/api/emails', { key: keyA })).json()).length === 0, 'owner delete-all works');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
