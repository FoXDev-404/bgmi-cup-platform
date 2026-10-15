// @ts-check
// Link & asset audit: boots its own isolated server (same isolation contract
// as review-step.spec.js / test_api.py — temp DB + uploads on a free port,
// the real registrations.db is never touched), opens every public page and:
//   1. fails on any console/page error or unexpected same-origin 4xx
//      (CSS, JS, images and fonts) while the page loads,
//   2. resolves every nav/footer/inline link and every link/script/img asset
//      with a real HTTP GET,
//   3. clicks through the nav, footer and CTA links and checks each hop,
//   4. checks the legacy /public/team/ path still 301-redirects,
//   5. checks unknown URLs get the themed 404 with status 404.
// External origins (the Google Fonts CDN) are tolerated so an offline machine
// does not flake the suite; the app serves no same-origin fonts.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

// package.json is type:commonjs — Playwright transpiles this file to CJS, so
// __dirname exists here and import.meta must not appear anywhere.
const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (
        srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let server;
/** @type {string} */
let base = '';
/** @type {string} */
let tmp = '';

test.beforeAll(async () => {
  const port = await freePort();
  tmp = mkdtempSync(path.join(tmpdir(), 'bgmi_pw_'));
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    BGMI_DB: path.join(tmp, 'test.db'),
    BGMI_UPLOADS: path.join(tmp, 'uploads'),
    BGMI_NOTIFY_POLL: '3600',       // keep the worker quiet during the run
  };
  server = spawn(process.env.PYTHON || 'python',
    [path.join(ROOT, 'server.py')],
    { env, cwd: ROOT, stdio: 'ignore' });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) break;
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('isolated test server did not start');
});

test.afterAll(() => {
  if (server && server.exitCode === null) server.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Pages any visitor can reach without a session. */
const PAGES = ['/', '/status', '/teams', '/about', '/rules', '/schedule',
               '/live', '/results',
               '/admin', '/admin-login.html', '/privacy', '/privacy.html',
               '/404.html'];

// Expected while the public-feed toggles are off (Settings default): the
// teams/schedule pages probe these endpoints on load and a 404 is the
// documented "feed disabled" answer, not a broken asset.
const ALLOWED_4XX = [/\/api\/public\/approved\b/, /\/api\/public\/schedule\b/];

// nav + hero CTAs + footer — the three link groups the site actually ships.
const LINK_SEL = '#navLinks a[href], header.hero a[href], footer a[href]';

test('every page loads clean: no console errors, no unexpected same-origin 4xx',
  async ({ page }) => {
    test.setTimeout(120000);
    /** @type {string[]} */
    const problems = [];
    let current = '';
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const loc = (m.location() && m.location().url) || '';
      if (loc && !loc.startsWith(base)) return;   // external (font CDN offline)
      if (loc && ALLOWED_4XX.some((re) => re.test(loc))) return; // feed-off probe
      if (!loc && /^Failed to load resource/.test(m.text())) return;
      problems.push(`${current} console: ${m.text()}${loc ? ' @ ' + loc : ''}`);
    });
    page.on('pageerror', (e) => problems.push(`${current} pageerror: ${e}`));
    page.on('response', (r) => {
      if (!r.url().startsWith(base)) return;      // external origins tolerated
      if (r.status() < 400) return;
      if (ALLOWED_4XX.some((re) => re.test(r.url()))) return;
      problems.push(`${current} HTTP ${r.status()} ${r.url()}`);
    });

    for (const p of PAGES) {
      current = p;
      const resp = await page.goto(base + p, { waitUntil: 'load' });
      expect(resp, `response for ${p}`).not.toBeNull();
      expect(resp && resp.status(), `status for ${p}`).toBeLessThan(400);
      await page.waitForTimeout(150);   // let straggler fetches land
    }
    current = '';
    expect(problems, 'console/network problems').toEqual([]);
  });

test('every link and page asset resolves with HTTP < 400', async ({ page }) => {
  test.setTimeout(120000);
  /** @type {Set<string>} */
  const checked = new Set();
  let anchors = 0;
  let assets = 0;
  const check = async (/** @type {string} */ url) => {
    if (checked.has(url)) return;
    checked.add(url);
    const r = await page.request.get(url);
    expect(r.status(), `GET ${url}`).toBeLessThan(400);
  };

  for (const p of PAGES) {
    await page.goto(base + p, { waitUntil: 'load' });
    const hrefs = await page.$$eval(
      'a[href]', (els) => els.map((e) => e.getAttribute('href')));
    for (const href of hrefs) {
      if (!href || /^(#|mailto:|tel:|javascript:|data:)/.test(href)) continue;
      const abs = new URL(href, page.url());
      if (!abs.href.startsWith(base)) continue;   // external
      abs.hash = '';
      anchors += 1;
      await check(abs.href);
    }
    const srcs = await page.$$eval(
      'link[href], script[src], img[src]',
      (els) => els.map((e) => e.getAttribute('href')
                              || e.getAttribute('src')));
    for (const s of srcs) {
      if (!s || /^data:/i.test(s)) continue;
      if (/^(https?:)?\/\//i.test(s)) continue;   // external / protocol-relative
      const abs = new URL(s, page.url());
      if (!abs.href.startsWith(base)) continue;
      assets += 1;
      await check(abs.href);
    }
  }
  // floors: guard against the selectors silently matching nothing
  expect(anchors, 'anchor instances resolved').toBeGreaterThanOrEqual(15);
  expect(assets, 'asset instances resolved').toBeGreaterThanOrEqual(25);
});

test('nav, footer and CTA links click through to the right pages',
  async ({ page }) => {
    test.setTimeout(180000);
    /** @type {Set<string>} */
    const clicked = new Set();
    let clicks = 0;
    for (const p of PAGES) {
      await page.goto(base + p, { waitUntil: 'load' });
      const links = await page.$$eval(LINK_SEL, (els) => els.map((a) => ({
        href: a.getAttribute('href'),
        target: a.getAttribute('target') || '',
      })));
      for (const { href, target } of links) {
        if (!href || /^(#?$|mailto:|tel:|javascript:)/.test(href)) continue;
        if (target && target !== '_self') continue;  // new-tab: resolve-test covers
        // resolve against the page the link LIVES on — page.url() may have
        // drifted to a page an earlier click navigated to
        const abs = new URL(href, base + p);
        if (!abs.href.startsWith(base)) continue;    // external
        const key = abs.pathname + abs.hash;
        if (clicked.has(key)) continue;              // one real click per target
        clicked.add(key);

        // reset to the page this link actually lives on before clicking it
        await page.goto(base + p, { waitUntil: 'load' });
        let navStatus = 0;
        const onResp = (/** @type {import('@playwright/test').Response} */ r) => {
          if (r.request().resourceType() === 'document'
              && r.frame() === page.mainFrame()) navStatus = r.status();
        };
        page.on('response', onResp);
        await page
          .locator(`#navLinks a[href="${href}"], ` +
                   `header.hero a[href="${href}"], ` +
                   `footer a[href="${href}"]:visible`)
          .first().click();
        await page.waitForLoadState('load').catch(() => { /* hash link */ });
        page.off('response', onResp);
        clicks += 1;

        if (abs.hash && abs.pathname === new URL(page.url()).pathname) {
          // same-page CTA button: nothing navigates, the hash must apply
          expect(new URL(page.url()).hash, `${p} ${href} hash`)
            .toBe(abs.hash);
          continue;
        }
        expect(navStatus, `${p} -> ${href} document status`)
          .toBeGreaterThan(0);
        expect(navStatus, `${p} -> ${href} document status`)
          .toBeLessThan(400);
        expect(new URL(page.url()).pathname, `${p} -> ${href} lands on`)
          .toBe(abs.pathname);
      }
    }
    expect(clicks, 'links actually clicked').toBeGreaterThanOrEqual(8);
  });

test('legacy /public/team/ image URLs 301-redirect to /images/team/',
  async ({ page }) => {
    const photos = readdirSync(path.join(ROOT, 'public', 'images', 'team'))
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
    expect(photos.length, 'team photos exist').toBeGreaterThan(0);
    /** @type {{url: string, status: number}[]} */
    const chain = [];
    const onResp = (/** @type {import('@playwright/test').Response} */ r) =>
      chain.push({ url: r.url(), status: r.status() });
    page.on('response', onResp);
    const resp = await page.goto(
      base + '/public/team/' + encodeURIComponent(photos[0]),
      { waitUntil: 'load' });
    page.off('response', onResp);
    expect(resp && resp.status(), 'legacy path resolves to 200 after redirect')
      .toBe(200);
    const hop = chain.find((c) => c.url.includes('/public/team/'));
    expect(hop && hop.status, 'legacy path answers 301').toBe(301);
    expect(chain.some((c) => c.url.includes('/images/team/')
                             && c.status === 200),
      'lands on the moved image').toBe(true);
  });

test('unknown URLs get the themed 404 with status 404', async ({ page }) => {
  const resp = await page.goto(base + '/no-such-page-' + Date.now(),
    { waitUntil: 'load' });
  expect(resp && resp.status(), 'missing page status').toBe(404);
  await expect(page.locator('.nf-title'), 'themed 404 body')
    .toHaveText('Wrong drop zone.');
  // a missing file under a real directory is a plain 404 too
  const asset = await page.request.get(
    base + '/images/team/definitely-missing.png');
  expect(asset.status(), 'missing asset status').toBe(404);
});

test('nav and footer sitemap carry no duplicate links', async ({ page }) => {
  // #navLinks is the navbar on every page; the footer sitemap items are
  // .f-link (the big .footer-cta button intentionally repeats the register
  // CTA, it is not a sitemap item). Pre-auth admin shells render an empty
  // #navLinks, tolerated here; a global floor guards against selector rot.
  let totalNav = 0;
  for (const p of PAGES) {
    await page.goto(base + p, { waitUntil: 'load' });
    /** @type {{nav: string[], foot: string[]}} */
    const groups = await page.evaluate(() => ({
      nav: [...document.querySelectorAll('#navLinks a[href]')]
        .map((a) => a.getAttribute('href') + '|' + a.textContent.trim()),
      foot: [...document.querySelectorAll('footer .f-link[href]')]
        .map((a) => a.getAttribute('href') + '|' + a.textContent.trim()),
    }));
    for (const [where, list] of Object.entries(groups)) {
      const dup = list.filter((v, i) => list.indexOf(v) !== i);
      expect(dup, `${p} ${where} duplicate links`).toEqual([]);
    }
    totalNav += groups.nav.length;
  }
  expect(totalNav, 'nav links seen across pages').toBeGreaterThan(20);
});
