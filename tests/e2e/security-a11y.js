/* Stage 10 e2e — security headers, path traversal, API auth, a11y/keyboard,
 * and lightweight performance (Lighthouse is not installed here).
 *
 *   VERIFY_ADMIN_USER=... VERIFY_ADMIN_PASSWORD=... \
 *     node tests/e2e/security-a11y.js [base]      (default :8090)
 *
 * Needs a freshly seeded DB (scripts/seed_demo.py + create_admin.py) and a
 * server restarted after seeding (the control-desk dialog check drives the
 * seeded live match). Traversal probes go over a raw node:http socket so the
 * client never normalises ../ segments away before sending them.
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

/* raw request — sends the path exactly as written (no URL normalisation) */
function raw(method, pathAndQuery) {
  const u = new URL(BASE);
  return new Promise((resolve) => {
    const req = http.request({ hostname: u.hostname, port: u.port,
      path: pathAndQuery, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ s: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', () => resolve({ s: 0, headers: {}, body: '' }));
    req.end();
  });
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
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonReq = anon.request;

  /* ---------- login ---------- */
  console.log('\n[login]');
  const tok = await api.get(BASE + '/api/csrf').then(js);
  const login = await api.post(BASE + '/api/admin/login', {
    data: { username: ADMIN_USER, password: ADMIN_PASS },
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok.token || '' },
  });
  check('admin login', login.status() === 200, login.status());
  const me = await GET('/api/admin/me');
  const H = { 'X-Admin-CSRF': me.d && me.d.csrf };
  check('session + csrf available', me.s === 200 && !!H['X-Admin-CSRF'], me.s);

  /* ---------- security headers ---------- */
  console.log('\n[security headers]');
  const headChecks = [
    ['/', { frame: 'SAMEORIGIN' }],
    ['/results', { frame: 'SAMEORIGIN' }],
    ['/admin/', { frame: 'DENY' }],
    ['/overlay/live', { frame: 'SAMEORIGIN' }],
  ];
  for (const [p, want] of headChecks) {
    const r = await api.get(BASE + p);
    const h = r.headers();
    check(p + ': nosniff + referrer policy + CSP + frame policy',
      h['x-content-type-options'] === 'nosniff' &&
      h['referrer-policy'] === 'strict-origin-when-cross-origin' &&
      /default-src 'self'/.test(h['content-security-policy'] || '') &&
      /object-src 'none'/.test(h['content-security-policy'] || '') &&
      /base-uri 'self'/.test(h['content-security-policy'] || '') &&
      h['x-frame-options'] === want.frame,
      JSON.stringify({ frame: h['x-frame-options'], csp: !!h['content-security-policy'] }));
  }
  const apiHead = await anonReq.get(BASE + '/api/live/state');
  const ah = apiHead.headers();
  check('API JSON: no-store + nosniff', ah['cache-control'] === 'no-store' &&
    ah['x-content-type-options'] === 'nosniff',
    JSON.stringify({ cc: ah['cache-control'] }));

  /* ---------- path traversal + blocked files ---------- */
  console.log('\n[path traversal]');
  const probes = [
    '/server.py',
    '/.env',
    '/data/registrations.db',
    '/assets/%2e%2e/%2e%2e/server.py',
    '/assets/..%2f..%2fserver.py',
    '/%252e%252e/server.py',
    '/assets/..%5c..%5cserver.py',
    '/uploads/..%2f..%2fserver.py',
    '/uploads/%2e%2e/verify.db',
  ];
  for (const p of probes) {
    const r = await raw('GET', p);
    const leaked = /CREATE TABLE|import os|BGMI_DB|SECRET/.test(r.body);
    check('blocked: ' + p, r.s === 404 && !leaked,
      'status ' + r.s + (leaked ? ' (LEAK)' : ''));
  }
  const legit = await anonReq.get(BASE + '/overlay.css');
  check('legit static file still served', legit.status() === 200, legit.status());

  /* ---------- API auth + CSRF + injection smoke ---------- */
  console.log('\n[api auth / csrf / injection]');
  const noAuth = await anonReq.get(BASE + '/api/admin/matches');
  const noAuthBody = await js(noAuth);
  check('admin API without a session -> 401', noAuth.status() === 401 &&
    noAuthBody && noAuthBody.error === 'Not signed in.', noAuth.status());
  const noCsrf = await api.post(BASE + '/api/admin/groups',
    { data: { name: 'csrf-probe' }, headers: { 'Content-Type': 'application/json' } });
  check('admin write without the CSRF header -> 403', noCsrf.status() === 403,
    noCsrf.status());
  const sqli = await anonReq.post(BASE + '/api/status/lookup', {
    data: { code: "' OR 1=1 --", hint: 'x' },
    headers: { 'Content-Type': 'application/json' },
  });
  check('SQL-ish status lookup -> clean 4xx (no 500)', [400, 404].includes(sqli.status()),
    sqli.status());
  const sqli2 = await GET('/api/admin/registrations?q=%27%20OR%201%3D1--');
  check('SQL-ish admin search -> 200 with an array (no 500)',
    sqli2.s === 200 && Array.isArray(sqli2.d && sqli2.d.registrations),
    sqli2.s);

  /* ---------- a11y sweep (names, labels, alt, h1) ---------- */
  console.log('\n[a11y sweep]');
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const SWEEP = `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' &&
        cs.display !== 'none';
    };
    function name(el) {
      const t = (el.textContent || '').trim();
      const img = el.querySelector && el.querySelector('img[alt]');
      return t || el.getAttribute('aria-label') || el.getAttribute('title') ||
        (img && img.alt) || '';
    }
    const links = [], inputs = [], imgs = [];
    document.querySelectorAll('a,button').forEach((el) => {
      if (visible(el) && !name(el)) links.push(el.outerHTML.slice(0, 90));
    });
    document.querySelectorAll('input,select,textarea').forEach((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden' || !visible(el)) return;
      const lab = el.id && document.querySelector('label[for="' +
        CSS.escape(el.id) + '"]');
      if (!(lab || el.getAttribute('aria-label') ||
            el.getAttribute('aria-labelledby') || el.closest('label'))) {
        inputs.push(el.outerHTML.slice(0, 90));
      }
    });
    document.querySelectorAll('img').forEach((el) => {
      if (!visible(el) || el.getAttribute('role') === 'presentation' ||
          el.getAttribute('aria-hidden') === 'true') return;
      if (el.getAttribute('alt') === null) imgs.push(el.getAttribute('src') || '?');
    });
    return { links, inputs, imgs, h1: document.querySelectorAll('h1').length };
  })()`;
  for (const p of ['/', '/register', '/status', '/results']) {
    await page.goto(BASE + p, { waitUntil: 'load' });
    await page.waitForTimeout(350);
    const s = await page.evaluate(SWEEP);
    check(p + ': every visible link/button has an accessible name',
      s.links.length === 0, s.links.slice(0, 3).join(' | '));
    check(p + ': every visible field has a label',
      s.inputs.length === 0, s.inputs.slice(0, 3).join(' | '));
    check(p + ': every visible image has alt (or is decorative)',
      s.imgs.length === 0, s.imgs.slice(0, 3).join(' | '));
    check(p + ': has an h1', s.h1 >= 1, s.h1);
  }

  /* ---------- keyboard operability ---------- */
  console.log('\n[keyboard]');
  await page.goto(BASE + '/', { waitUntil: 'load' });
  const before = page.url();
  let reached = '';
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => {
      const a = document.activeElement;
      const href = a && a.tagName === 'A' ? (a.getAttribute('href') || '') : '';
      return /register/.test(href) ? href : '';
    });
  }
  check('Tab reaches a Register link (' + (reached || 'none') + ')', !!reached);
  if (reached) {
    await page.keyboard.press('Enter');
    const moved = await page.waitForFunction((b) => location.href !== b, before,
      { timeout: 8000 }).then(() => true).catch(() => false);
    check('Enter activates the link (keyboard navigation works)',
      moved && /register/.test(page.url()), page.url());
  }

  const mob = await ctx.newPage();
  await mob.setViewportSize({ width: 420, height: 800 });
  await mob.goto(BASE + '/', { waitUntil: 'load' });
  await mob.focus('#navToggle');
  await mob.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const open1 = await mob.evaluate(() =>
    document.getElementById('navLinks').classList.contains('open'));
  await mob.screenshot({ path: path.join(SHOTS, 'mobile-nav-open-420.png') });
  await mob.keyboard.press('Enter');
  await mob.waitForTimeout(250);
  const open2 = await mob.evaluate(() =>
    document.getElementById('navLinks').classList.contains('open'));
  check('mobile nav opens and closes with the keyboard (Enter)', open1 && !open2,
    JSON.stringify({ open1, open2 }));
  await mob.close();

  /* ---------- dialogs: Escape closes the desk swap dialog ---------- */
  console.log('\n[dialog keyboard]');
  await page.goto(BASE + '/admin/control', { waitUntil: 'load' });
  await page.waitForSelector('#squadGrid .bc-squad', { timeout: 10000 });
  const liveM = ((await GET('/api/admin/matches')).d.matches || [])
    .find((m) => m.status === 'live');
  const mstate = (await GET('/api/admin/matches/' + liveM.id)).d.state;
  const noBench = mstate.teams.find((t) => !(t.bench || []).length);
  const withBench = mstate.teams.find((t) => (t.bench || []).length > 0);
  if (noBench) {
    const card = page.locator(`.bc-squad[data-team="${noBench.teamId}"]`);
    await card.locator('[data-act="gear"]').click();
    await card.locator('[data-act="swap"]').click();
    await page.waitForTimeout(300);
    const toast = await page.evaluate(() => {
      const el = document.getElementById('bcToast');
      return el ? { text: el.textContent,
                    shown: el.classList.contains('bc-toast--show') } : null;
    });
    const dlg = await page.evaluate(() => !!document.querySelector('dialog[open]'));
    check('swap without substitutes: toast, no dialog',
      !!toast && toast.shown && /No substitutes/.test(toast.text) && !dlg,
      JSON.stringify({ toast, dlg }));
  }
  const pick = withBench || mstate.teams[0];
  const act = withBench ? 'swap' : 'adjust';
  const card2 = page.locator(`.bc-squad[data-team="${pick.teamId}"]`);
  await card2.locator('[data-act="gear"]').click();
  await card2.locator(`[data-act="${act}"]`).click();
  const opened = await page.waitForSelector('dialog[open]', { timeout: 5000 })
    .then(() => true).catch(() => false);
  check('desk dialog opens (' + act + ' on ' + pick.teamTag + ')', opened);
  if (opened) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'),
      null, { timeout: 5000 }).catch(() => {});
    const stillOpen = await page.evaluate(() =>
      !!document.querySelector('dialog[open]'));
    check('Escape closes the dialog (native keyboard support)', !stillOpen);
  }

  /* ---------- lightweight performance (Lighthouse unavailable) ---------- */
  console.log('\n[performance]');
  const timings = {};
  for (const p of ['/', '/results']) {
    await page.goto(BASE + p, { waitUntil: 'load' });
    timings[p] = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n ? { dur: Math.round(n.duration),
                   transfer: n.transferSize } : null;
    });
  }
  check('pages load in < 2.5 s locally (document transfer < 500 KB)',
    Object.values(timings).every((t) => t && t.dur < 2500 && t.transfer < 500000),
    JSON.stringify(timings));
  const times = [];
  for (let i = 0; i < 25; i++) {
    const t0 = Date.now();
    const r = await anonReq.get(BASE + '/api/live/state');
    await r.body();
    times.push(Date.now() - t0);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const max = Math.max.apply(null, times);
  check('GET /api/live/state x25: avg < 250 ms, worst < 1500 ms',
    avg < 250 && max < 1500, JSON.stringify({ avg, max }));

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  console.log(`\n== security/a11y/perf: ${passed} passed, ${failed} failed ==`);
  console.log('  (Lighthouse: SKIPPED — CLI not installed and npx unavailable offline)');
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
