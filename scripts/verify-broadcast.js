// Quick visual smoke of the broadcast pages against a running demo server.
// Usage: node scripts/verify-broadcast.js [baseURL]
const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8123';
const OUT = path.resolve(__dirname, '..', 'qa-shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const shot = async (page, name, width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, name + '-' + width + '.png'), fullPage: width !== 1920 });
  };

  // public pages at 3 widths
  const pub = await browser.newPage();
  pub.on('console', (m) => { if (m.type() === 'error') problems.push(`console ${m.text()}`); });
  pub.on('pageerror', (e) => problems.push(`pageerror ${e}`));
  pub.on('response', (r) => {
    if (r.url().startsWith(BASE) && r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
  for (const p of ['/live', '/results']) {
    await pub.goto(BASE + p, { waitUntil: 'load' });
    for (const w of [1440, 768, 390]) await shot(pub, p.slice(1), w, 900);
    const rows = await pub.locator('tbody tr').count();
    console.log(`${p}: ${rows} table rows`);
  }

  // overlay scenes at 1920x1080 (token from the seeded DB)
  const python = require('node:child_process').execFileSync;
  const tokenOut = python(process.env.PYTHON || 'python', ['-c',
    `import os, sqlite3; c = sqlite3.connect(os.environ["BGMI_DB"]);` +
    `print(c.execute("SELECT value FROM overlay_settings WHERE key='token'").fetchone()[0])`],
    { env: process.env, cwd: path.resolve(__dirname, '..') }).toString().trim();
  const ov = await browser.newPage();
  ov.on('pageerror', (e) => problems.push(`overlay pageerror ${e}`));
  for (const name of ['live-leaderboard', 'teams-alive', 'team-status-strip',
                      'match-results', 'overall-standings', 'chicken-dinner',
                      'break-screen', 'sponsor-bug', 'mvp-card', 'elimination-popup',
                      'team-intro']) {
    await ov.setViewportSize({ width: 1920, height: 1080 });
    await ov.goto(`${BASE}/overlay/${name}?token=${tokenOut}`, { waitUntil: 'load' });
    await ov.waitForTimeout(500);
    await ov.screenshot({ path: path.join(OUT, 'overlay-' + name + '.png') });
    const html = await ov.locator('#scene').innerHTML();
    console.log(`overlay ${name}: ${html.length} chars of scene`);
  }

  // overlay without token must serve the shell but fetch 403 (no data leaks)
  await ov.goto(`${BASE}/overlay/live-leaderboard`, { waitUntil: 'load' });
  const bodyText = await ov.locator('body').innerText();
  if (/cap\d@demo\.invalid|9\d{8}/.test(bodyText)) problems.push('PII visible on overlay shell');

  // admin pages (control desk, matches, overlays, caster) — needs credentials
  const auser = process.env.BGMI_ADMIN_USER || '';
  const apass = process.env.BGMI_ADMIN_PASSWORD || '';
  if (auser && apass) {
    const actx = await browser.newContext();
    const adm = await actx.newPage();
    adm.on('console', (m) => { if (m.type() === 'error') problems.push(`admin console ${m.text()}`); });
    adm.on('pageerror', (e) => problems.push(`admin pageerror ${e}`));
    adm.on('response', (r) => {
      if (r.url().startsWith(BASE) && r.status() >= 400) problems.push(`admin HTTP ${r.status()} ${r.url()}`);
    });
    await adm.goto(BASE + '/admin', { waitUntil: 'load' });
    await adm.fill('#loginUser', auser);
    await adm.fill('#loginPass', apass);
    await Promise.all([
      adm.waitForResponse((r) => r.url().includes('/api/admin/login')
        && r.status() === 200, { timeout: 15000 }),
      adm.click('#loginBtn'),
    ]);
    for (const p of ['/admin/matches', '/admin/control', '/admin/overlays', '/admin/caster']) {
      await adm.goto(BASE + p, { waitUntil: 'load' });
      // fail loudly if we were bounced to the login page
      await adm.waitForSelector('#logoutNavBtn', { timeout: 15000 });
      const seg = p.split('/').pop();
      for (const w of [1440, 768]) await shot(adm, 'admin-' + seg, w, 900);
      console.log('admin page ' + p + ' ok');
    }
    await actx.close();
  } else {
    console.log('admin pass skipped (set BGMI_ADMIN_USER/PASSWORD)');
  }

  await browser.close();
  if (problems.length) { console.log('PROBLEMS:', problems); process.exit(1); }
  console.log('broadcast visual smoke OK');
})();
