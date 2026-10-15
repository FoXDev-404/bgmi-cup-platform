/* Stage 9 e2e — overlays: token gate, 1920x1080 transparency, PII, SSE fanout.
 *
 *   VERIFY_ADMIN_USER=... VERIFY_ADMIN_PASSWORD=... \
 *     node tests/e2e/overlays.js [base]           (default :8090)
 *
 * Needs a freshly seeded DB (scripts/seed_demo.py + create_admin.py) and a
 * server restarted after seeding (the seed leaves the overlay token empty).
 *
 * Covers: empty/wrong/missing token -> 403, a rotated token -> 200 and the
 * old one -> 403, unknown scenes -> 404, the disabled flag, a PII sweep of
 * every scene payload (no e-mail, phone or player UID, cross-checked against
 * the admin payload), every overlay scene rendered at 1920x1080 with a
 * transparent document background and no console errors, SSE fan-out (two
 * token-gated overlay clients + the public live feed get one publish), and a
 * live desk change flowing through SSE into a rendered overlay row.
 */
'use strict';

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8090';
const SHOTS = path.join(__dirname, '..', 'screenshots');
const ADMIN_USER = process.env.VERIFY_ADMIN_USER || '';
const ADMIN_PASS = process.env.VERIFY_ADMIN_PASSWORD || '';

let passed = 0;
let failed = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS  ' + name); }
  else {
    failed += 1;
    fails.push(name + (detail ? ' :: ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* raw SSE client over node:http (the event itself is only a change signal) */
function sseClient(pathWithQuery) {
  const u = new URL(BASE + pathWithQuery);
  const client = { events: 0, status: 0, req: null, close() {} };
  client.ready = new Promise((resolve) => {
    client.req = http.get({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      client.status = res.statusCode;
      if (res.statusCode !== 200) { res.resume(); resolve(); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^data:/m.test(frame)) client.events += 1;
        }
      });
      resolve();
    });
    client.req.on('error', () => resolve());
    client.req.setTimeout(30000, () => {});
  });
  client.close = () => { try { client.req.destroy(); } catch (e) { /* done */ } };
  return client;
}
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(150);
  }
  return fn();
}

(async () => {
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.error('Set VERIFY_ADMIN_USER / VERIFY_ADMIN_PASSWORD.');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const api = ctx.request;
  const js = (r) => r.json().catch(() => null);
  const GET = async (p) => { const r = await api.get(BASE + p); return { s: r.status(), d: await js(r) }; };
  const POST = async (p, body, headers) => {
    const r = await api.post(BASE + p, { data: body || {},
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
    return { s: r.status(), d: await js(r) };
  };

  /* ---------- login ---------- */
  console.log('\n[login]');
  const tok = await api.get(BASE + '/api/csrf').then(js);
  const login = await api.post(BASE + '/api/admin/login', {
    data: { username: ADMIN_USER, password: ADMIN_PASS },
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok.token || '' },
  });
  check('admin login', login.status() === 200, login.status());
  const me = await GET('/api/admin/me');
  const csrf = me.d && me.d.csrf;
  const H = { 'X-Admin-CSRF': csrf };
  check('session + csrf available', me.s === 200 && !!csrf, me.s);

  const settings0 = await GET('/api/admin/overlay-settings');
  const SCENES = settings0.d.overlays;
  check('overlay scene list served', settings0.s === 200 && SCENES.length === 16,
    SCENES && SCENES.length);

  /* ---------- token gate ---------- */
  console.log('\n[token gate]');
  const noTok = await GET('/api/overlay/state/live');
  const junkTok = await GET('/api/overlay/state/live?token=nope');
  check('missing/junk token -> 403 (seed token starts empty)',
    noTok.s === 403 && junkTok.s === 403,
    noTok.s + '/' + junkTok.s);
  const rot1 = await POST('/api/admin/overlay-settings', { rotateToken: true }, H);
  const afterRot1 = await GET('/api/admin/overlay-settings');
  const tok1 = afterRot1.d.token;
  check('token rotation issues a new secret',
    rot1.s === 200 && !!tok1 && tok1 !== settings0.d.token,
    rot1.s);
  check('the rotated token opens the gate',
    (await GET('/api/overlay/state/live?token=' + encodeURIComponent(tok1))).s === 200);
  const rot2 = await POST('/api/admin/overlay-settings', { rotateToken: true }, H);
  const TOK = (await GET('/api/admin/overlay-settings')).d.token;
  const oldTok = await GET('/api/overlay/state/live?token=' + encodeURIComponent(tok1));
  check('rotation retires the previous token (403) and the new one works',
    rot2.s === 200 && TOK !== tok1 && oldTok.s === 403 &&
    (await GET('/api/overlay/state/live?token=' + encodeURIComponent(TOK))).s === 200,
    oldTok.s);
  check('unknown overlay scene -> 404 even with a valid token',
    (await GET('/api/overlay/state/definitely-not-a-scene?token=' +
      encodeURIComponent(TOK))).s === 404);

  const wrongStream = sseClient('/api/overlay/stream/live?token=nope');
  await wrongStream.ready;
  check('overlay SSE stream rejects a wrong token', wrongStream.status === 403,
    wrongStream.status);
  wrongStream.close();

  const dis = await POST('/api/admin/overlay-settings', { disabled: ['mvp'] }, H);
  const disState = await GET('/api/overlay/state/mvp?token=' + encodeURIComponent(TOK));
  await POST('/api/admin/overlay-settings', { disabled: [] }, H);
  const enState = await GET('/api/overlay/state/mvp?token=' + encodeURIComponent(TOK));
  check('disabled flag round-trips per scene',
    dis.s === 200 && disState.d.disabled === true && enState.d.disabled === false,
    JSON.stringify([disState.d.disabled, enState.d.disabled]));

  /* ---------- PII sweep ---------- */
  console.log('\n[PII sweep]');
  const anon = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const anonReq = anon.request;
  const liveMatch = ((await GET('/api/admin/matches')).d.matches || [])
    .find((m) => m.status === 'live');
  const admState = liveMatch
    ? (await GET('/api/admin/matches/' + liveMatch.id)).d.state : null;
  const uids = [];
  (admState ? admState.teams : []).forEach((t) =>
    (t.players || []).forEach((p) => { if (p.uid) uids.push(String(p.uid)); }));
  check('admin payload carries player UIDs (cross-check base)', uids.length > 0,
    uids.length);
  const piiHits = [];
  for (const name of SCENES) {
    const r = await anonReq.get(BASE + '/api/overlay/state/' + name +
      '?token=' + encodeURIComponent(TOK));
    const text = await r.text();
    if (r.status() !== 200) piiHits.push(name + ': status ' + r.status());
    if (/@/.test(text)) piiHits.push(name + ': e-mail sign');
    if (/"phone"/i.test(text) || /"email"/i.test(text) || /"uid"/i.test(text)) {
      piiHits.push(name + ': PII key');
    }
    if (/\b9\d{9}\b/.test(text)) piiHits.push(name + ': phone-like number');
    for (const u of uids) {
      if (text.includes(u)) piiHits.push(name + ': uid ' + u);
    }
  }
  check('no e-mail, phone or player UID in any scene payload', piiHits.length === 0,
    piiHits.slice(0, 4).join(' | '));

  /* ---------- every scene at 1920x1080, transparent ---------- */
  console.log('\n[scenes: 1920x1080 transparent]');
  const page = await anon.newPage();
  const pageErrors = [];
  let curScene = '';
  page.on('pageerror', (e) => pageErrors.push(curScene + ': ' + e.message));
  for (const name of SCENES) {
    curScene = name;
    const respP = page.waitForResponse(
      (r) => r.url().includes('/api/overlay/state/' + name), { timeout: 8000 })
      .catch(() => null);
    await page.goto(BASE + '/overlay/' + name + '?token=' + encodeURIComponent(TOK),
      { waitUntil: 'load' });
    const resp = await respP;
    check('scene ' + name + ': state 200 with the token',
      !!resp && resp.status() === 200, resp && resp.status());
    if (name === 'live') {
      await page.waitForSelector('#teams .row', { timeout: 8000 });
    } else {
      await page.waitForFunction((n) =>
        document.getElementById('broadcast').className.includes('state-' + n),
        name, { timeout: 8000 }).catch(() => {});
    }
    await page.waitForTimeout(150);
    const st = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      cls: document.getElementById('broadcast').className,
      w: window.innerWidth, h: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
    }));
    check('scene ' + name + ': state class applied',
      st.cls.includes('state-' + name), st.cls);
    check('scene ' + name + ': transparent document at 1920x1080',
      st.html === 'rgba(0, 0, 0, 0)' && st.body === 'rgba(0, 0, 0, 0)' &&
      st.w === 1920 && st.h === 1080 && st.scrollW <= 1920,
      JSON.stringify(st));
    if (name === 'live') {
      await page.screenshot({ path: path.join(SHOTS, 'overlay-live-1920.png') });
    }
    if (name === 'overall') {
      check('overall scene renders standings rows',
        await page.locator('#fullRows .full-row').count() >= 1,
        await page.locator('#fullRows .full-row').count());
      await page.screenshot({ path: path.join(SHOTS, 'overlay-overall-1920.png') });
    }
  }

  /* ---------- SSE fan-out ---------- */
  console.log('\n[SSE fan-out]');
  const c1 = sseClient('/api/overlay/stream/live?token=' + encodeURIComponent(TOK));
  const c2 = sseClient('/api/overlay/stream/live?token=' + encodeURIComponent(TOK));
  const c3 = sseClient('/api/live/stream');
  await Promise.all([c1.ready, c2.ready, c3.ready]);
  check('two overlay clients + one live client connected',
    c1.status === 200 && c2.status === 200 && c3.status === 200,
    [c1.status, c2.status, c3.status].join('/'));
  await sleep(400);
  const base = [c1.events, c2.events, c3.events];
  await POST('/api/admin/overlay-settings', { sponsorText: 'E2E fan-out' }, H);
  const fanned = await waitFor(() =>
    c1.events > base[0] && c2.events > base[1] && c3.events > base[2], 6000);
  check('one publish fans out to every subscriber', fanned,
    JSON.stringify([c1.events - base[0], c2.events - base[1], c3.events - base[2]]));
  const base2 = [c1.events, c2.events, c3.events];
  await POST('/api/admin/overlay-settings', { sponsorText: 'Presented by Demo Studios' }, H);
  const fanned2 = await waitFor(() =>
    c1.events > base2[0] && c2.events > base2[1] && c3.events > base2[2], 6000);
  check('a second publish fans out again', fanned2,
    JSON.stringify([c1.events - base2[0], c2.events - base2[1], c3.events - base2[2]]));
  c1.close(); c2.close(); c3.close();

  /* ---------- desk change -> overlay row, through SSE ---------- */
  console.log('\n[scoring update reaches the overlay]');
  check('a live demo match drives the overlays', !!liveMatch, liveMatch && liveMatch.id);
  curScene = 'live';
  await page.goto(BASE + '/overlay/live?token=' + encodeURIComponent(TOK),
    { waitUntil: 'load' });
  await page.waitForSelector('#teams .row', { timeout: 8000 });
  const team = admState.teams[0];
  const before = await page.$$eval('#teams .row', (rows) => Object.fromEntries(
    rows.map((r) => [r.querySelector('.name').textContent,
                     r.querySelector('.kills').textContent.trim()])));
  const want = String(Number(before[team.teamName]) + 1);
  const kill = await POST(`/api/admin/match/${liveMatch.id}/team/${team.teamId}/kills`,
    { delta: 1 }, H);
  check('desk kill accepted', kill.s === 200,
    kill.s + ' ' + ((kill.d || {}).error || ''));
  const rowUp = await page.waitForFunction(([name, target]) => {
    const row = [...document.querySelectorAll('#teams .row')]
      .find((r) => r.querySelector('.name').textContent === name);
    return row && row.querySelector('.kills').textContent.trim() === String(target);
  }, [team.teamName, want], { timeout: 8000 }).then(() => true).catch(() => false);
  check('overlay row picks the finish up over SSE (before ' +
    before[team.teamName] + ' -> ' + want + ')', rowUp,
    JSON.stringify(before));

  check('no overlay page errors', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | '));

  console.log(`\n== overlays: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
