/* Stage 2 e2e — public site sweep (viewports 1440/768/390).
 *
 *   node tests/e2e/public-site.js [base]     (default http://127.0.0.1:8090)
 *
 * For every public page and each viewport: HTTP 200, console errors AND
 * warnings, page errors, failed same-origin requests, unexpected same-origin
 * 4xx, horizontal scroll, broken images, loaded webfonts, and a full-page
 * screenshot into tests/screenshots/. Also: the 404 page (status, quick
 * links), external links (target=_blank + rel=noopener noreferrer) and the
 * 390px hamburger (opens, closes on link click). Dev-only tool — requires
 * the repo's node_modules (Playwright); the app itself stays stdlib-only.
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8090';
const SHOTS = path.join(__dirname, '..', 'screenshots');
const PAGES = ['/', '/status', '/teams', '/schedule', '/live', '/results',
  '/about', '/privacy.html'];
const VIEWS = [[1440, 900, '1440'], [768, 1024, '768'], [390, 844, '390']];
// Documented "feed disabled" probes (Settings toggles) — a 404 here is the
// page's intended answer, not a broken asset. Missing-page URLs are this
// script's own deliberate 404 navigations.
const ALLOWED_4XX = [/\/api\/public\/approved\b/, /\/api\/public\/schedule\b/,
  /\/no-such-page-/];

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
const slug = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/\W+/g, '-'));

/* Scroll through the page so IntersectionObserver reveals fire, then return
   to the top. scroll-behavior: smooth makes coarse scrollTo() steps
   unreliable, so walk the reveals element by element with instant scrolls.
   Also asserts nothing stays hidden after a full pass. */
async function revealAll(page) {
  await page.evaluate(async () => {
    const els = [...document.querySelectorAll('.fade-in-up')];
    for (const el of els) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 250));
  });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();

  for (const [w, h, tag] of VIEWS) {
    console.log(`\n[${w}x${h}]`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const problems = [];
    let current = '';
    page.on('console', (m) => {
      const type = m.type();
      if (type !== 'error' && type !== 'warning') return;
      const loc = (m.location() && m.location().url) || '';
      if (loc && !loc.startsWith(BASE)) return;      // font CDN / external
      if (loc && ALLOWED_4XX.some((re) => re.test(loc))) return;
      if (!loc && /Failed to load resource/.test(m.text())) return;
      problems.push(`${current} console.${type}${loc ? ' @' + loc : ''}: ` +
        m.text().slice(0, 120));
    });
    page.on('pageerror', (e) => problems.push(`${current} pageerror: ${e}`));
    page.on('requestfailed', (r) => {
      if (!r.url().startsWith(BASE)) return;
      problems.push(`${current} requestfailed ${r.url()} ` +
        ((r.failure() && r.failure().errorText) || ''));
    });
    page.on('response', (r) => {
      if (!r.url().startsWith(BASE) || r.status() < 400) return;
      if (ALLOWED_4XX.some((re) => re.test(r.url()))) return;
      problems.push(`${current} HTTP ${r.status()} ${r.url()}`);
    });

    for (const p of PAGES) {
      current = `${p}@${tag}`;
      const resp = await page.goto(BASE + p, { waitUntil: 'load' });
      check(`${current} -> HTTP 200`,
        !!resp && resp.status() === 200, resp && resp.status());
      await page.waitForTimeout(300);   // straggler fetches + font swaps

      const metrics = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        fonts: document.fonts.status,
      }));
      check(`${current} no horizontal scroll`,
        metrics.scrollW <= metrics.innerW + 1,
        `scrollWidth ${metrics.scrollW} > ${metrics.innerW}`);
      check(`${current} fonts loaded`, metrics.fonts === 'loaded',
        metrics.fonts);

      const broken = await page.$$eval('img', (els) => els
        .filter((e) => {
          const s = e.getAttribute('src') || '';
          return s && !s.startsWith('data:') && e.naturalWidth === 0;
        })
        .map((e) => e.getAttribute('src')));
      check(`${current} images render`, broken.length === 0,
        broken.slice(0, 3).join(','));

      if (p === '/about') {
        /* the line-up dossier: two cards, portraits, backdrop, copy, watermark */
        const lineup = await page.evaluate(() => {
          const grid = document.getElementById('teamGrid');
          const sec = document.querySelector('.ab-lineup');
          const imgs = [...document.querySelectorAll('#teamGrid img')];
          return {
            cards: grid ? grid.querySelectorAll('.ab-op').length : -1,
            imgW: imgs.map((e) => e.naturalWidth),
            text: grid ? grid.innerText : '',
            section: sec ? sec.innerText : '',
            bg: sec ? getComputedStyle(sec).backgroundImage : '',
            watermarks: document.querySelectorAll('.ab-wm').length,
          };
        });
        check(`${current} two operator cards`, lineup.cards === 2,
          String(lineup.cards));
        check(`${current} both portraits render`,
          lineup.imgW.length === 2 && lineup.imgW.every((w) => w > 0),
          lineup.imgW.join(','));
        check(`${current} line-up names (removed member gone)`,
          /FE_PSYCHO/.test(lineup.text) && /FE_KANNU/.test(lineup.text) &&
          !/FE_SAHIL/.test(lineup.text));
        check(`${current} dossier copy`,
          /TWO NAMES/i.test(lineup.section) &&
          /NO MERCY IN THE LAST CIRCLE/i.test(lineup.section) &&
          /UNIT FILE 002/i.test(lineup.section) &&
          /DROP TOGETHER\. SURVIVE TOGETHER/i.test(lineup.section),
          lineup.section.replace(/\s+/g, ' ').slice(0, 80));
        const bgUrl = (lineup.bg.match(/url\("?([^")]+)"?\)/) || [])[1];
        const bgOk = bgUrl ? await page.evaluate((u) => new Promise((res) => {
          const im = new Image();
          im.onload = () => res(im.naturalWidth > 0);
          im.onerror = () => res(false);
          im.src = u;
        }), bgUrl) : false;
        check(`${current} battlefield backdrop loads`, bgOk === true,
          (bgUrl || 'none').slice(0, 90));
        check(`${current} FEARLESS watermark intact`, lineup.watermarks === 2,
          String(lineup.watermarks));
      }

      if (p === '/schedule') {
        /* Noida event details live on the schedule page, not the home page */
        const eventText = await page.locator('.event-card').innerText().catch(() => '');
        check(`${current} event card carries the Noida details`,
          /BGMI CUP NOIDA 2026/i.test(eventText) &&
          /14 NOVEMBER 2026/i.test(eventText) &&
          /GALGOTIAS POLYTECHNIC/i.test(eventText) &&
          /GREATER NOIDA/i.test(eventText),
          eventText.replace(/\s+/g, ' ').slice(0, 100));
      }

      if (p === '/') {
        /* hero: crimson battlefield backdrop layer loads and covers */
        const hero = await page.evaluate(() => {
          const el = document.querySelector('.hero');
          if (!el) return { bg: '', size: '' };
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundImage, size: cs.backgroundSize };
        });
        const heroUrl = (hero.bg.match(/url\("?([^")]+)"?\)/) || [])[1];
        const heroOk = heroUrl ? await page.evaluate((u) => new Promise((res) => {
          const im = new Image();
          im.onload = () => res(im.naturalWidth > 0);
          im.onerror = () => res(false);
          im.src = u;
        }), heroUrl) : false;
        check(`${current} hero battlefield backdrop loads`, heroOk === true,
          (heroUrl || 'none').slice(0, 90));
        check(`${current} hero backdrop covers viewport`, hero.size === 'cover',
          hero.size);

        /* hero: general platform copy, CTAs, stats, HUD */
        const heroBits = await page.evaluate(() => {
          const txt = (sel) => (document.querySelector(sel) || {}).textContent || '';
          const pill = document.querySelector('.hero-cta .btn-primary');
          const rules = document.querySelector('.hero-cta .btn-outline');
          const rulesHref = rules ? rules.getAttribute('href') : '';
          return {
            eyebrow: txt('.hero-eyebrow'),
            title: txt('.hero-title'),
            date: txt('.hero-date'),
            tagline: txt('.hero-tagline'),
            stats: txt('.hero-stats'),
            register: pill ? pill.getAttribute('href') : '',
            rules: rulesHref,
            rulesTarget: !!document.querySelector(rulesHref || '#__missing'),
            hud: txt('.hero-hud--tl') + txt('.hero-hud--bl') + txt('.hero-hud--br'),
            pageText: document.body.innerText,
          };
        });
        check(`${current} hero title lines`,
          /BGMI CUP/.test(heroBits.title) && /SQUAD UP/.test(heroBits.title) &&
          /GET IN/.test(heroBits.title) &&
          /BATTLEGROUNDS MOBILE INDIA/.test(heroBits.eyebrow),
          heroBits.title.replace(/\s+/g, ' ').trim().slice(0, 60));
        check(`${current} hero date + tagline copy`,
          /REGISTRATION OPEN/.test(heroBits.date) && /SQUAD TPP/.test(heroBits.date) &&
          /Four starters\. Two subs\. Zero excuses\./.test(heroBits.tagline) &&
          /not your ego/.test(heroBits.tagline));
        check(`${current} home stays general (no Noida event copy)`,
          !/NOIDA/i.test(heroBits.pageText) &&
          !/14 NOVEMBER/i.test(heroBits.pageText) &&
          !/MMXXVI/i.test(heroBits.pageText),
          heroBits.pageText.match(/NOIDA|14 NOVEMBER|MMXXVI/i) || 'clean');
        check(`${current} hero CTAs wired`,
          heroBits.register === '#register' && heroBits.rules === '#rules' &&
          heroBits.rulesTarget,
          `register=${heroBits.register} rules=${heroBits.rules}`);
        check(`${current} stats strip values`,
          /04/.test(heroBits.stats) && /STARTERS/i.test(heroBits.stats) &&
          /02/.test(heroBits.stats) && /SUBS/i.test(heroBits.stats) &&
          /01/.test(heroBits.stats) && /ACCOUNT/i.test(heroBits.stats));
        check(`${current} hero HUD labels`,
          /BGMI CUP/.test(heroBits.hud) &&
          /SQUAD TPP/.test(heroBits.hud) && /INDIA/i.test(heroBits.hud) &&
          /MORE THAN A TOURNAMENT/.test(heroBits.hud),
          heroBits.hud.replace(/\s+/g, ' ').trim().slice(0, 70));
      }

      await revealAll(page);
      // Rendered-but-unrevealed is the bug; elements inside display:none
      // panels (e.g. the post-submit confirmation card) are expected.
      const hidden = await page.$$eval('.fade-in-up:not(.visible)',
        (els) => els.filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        }).length);
      check(`${current} scroll-reveal content shows`, hidden === 0,
        hidden + ' rendered elements still hidden after a full pass');
      await page.screenshot({
        path: path.join(SHOTS, `pub-${slug(p)}-${tag}.png`),
        fullPage: true,
      });
    }

    /* 404 page */
    current = `missing-page@${tag}`;
    const r404 = await page.goto(BASE + '/no-such-page-' + Date.now(),
      { waitUntil: 'load' });
    check(`${current} -> HTTP 404`, !!r404 && r404.status() === 404,
      r404 && r404.status());
    const nfTitle = await page.locator('.nf-title').innerText().catch(() => '');
    check(`${current} themed body`,
      nfTitle.trim().toLowerCase() === 'wrong drop zone.', nfTitle);
    const quick = await page.$$eval('.nf-links a[href], .nf-actions a[href]',
      (els) => els.map((a) => a.getAttribute('href')));
    check(`${current} quick links present`, quick.length >= 5,
      quick.join(','));
    for (const href of quick) {
      await page.goto(BASE + '/no-such-page-' + Date.now(),
        { waitUntil: 'load' });
      const target = new URL(href, BASE);
      current = `404 quick → ${href}`;
      const resp = await page.locator(
        `.nf-links a[href="${href}"], .nf-actions a[href="${href}"]`)
        .first().click()
        .then(() => page.waitForLoadState('load').catch(() => null))
        .then(() => null).catch(() => null);
      const url = new URL(page.url());
      check(`${current} opens the right section`,
        url.pathname === target.pathname &&
        (!target.hash || url.hash === target.hash), page.url());
      void resp;
    }
    await page.screenshot({
      path: path.join(SHOTS, `pub-404-${tag}.png`), fullPage: true,
    });

    if (tag === '1440') {
      /* external links: new tab + noopener noreferrer, on every page */
      const bad = [];
      for (const p of PAGES) {
        await page.goto(BASE + p, { waitUntil: 'load' });
        const ext = await page.$$eval('a[href^="http"]', (els) => els
          .filter((a) => !a.href.startsWith(location.origin))
          .map((a) => ({
            href: a.href,
            target: a.getAttribute('target') || '',
            rel: a.getAttribute('rel') || '',
          })));
        for (const l of ext) {
          if (l.target !== '_blank' || !/noopener/.test(l.rel) ||
              !/noreferrer/.test(l.rel)) {
            bad.push(`${p} ${l.href} target=${l.target} rel=${l.rel}`);
          }
        }
      }
      check('external links open in a new tab with noopener noreferrer',
        bad.length === 0, bad.slice(0, 3).join(' | '));

      /* one real popup: the Krafton link (network aborted, tab must open) */
      await page.route('**/*', (route) => {
        if (!route.request().url().startsWith(BASE)) return route.abort();
        return route.continue();
      });
      await page.goto(BASE + '/', { waitUntil: 'load' });
      const extLink = page.locator('a[target="_blank"][href^="http"]').first();
      const [popup] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
        extLink.click(),
      ]);
      check('external click opens a new tab', !!popup,
        popup ? popup.url().slice(0, 60) : 'no popup');
      if (popup) await popup.close();
      await page.unroute('**/*');
    }

    if (tag === '390') {
      /* hamburger: opens, closes on link click */
      for (const p of ['/', '/results']) {
        await page.goto(BASE + p, { waitUntil: 'load' });
        current = `hamburger@${p}`;
        const visible = await page.locator('#navToggle').isVisible();
        check(`${current} toggle visible at 390`, visible);
        await page.click('#navToggle');
        const open = await page.locator('#navLinks')
          .evaluate((el) => el.classList.contains('open'));
        check(`${current} opens the menu`, open);
        const first = page.locator('#navLinks a[href]').first();
        const href = await first.getAttribute('href');
        await first.click();
        await page.waitForLoadState('load').catch(() => null);
        await page.waitForTimeout(200);
        const closed = await page.locator('#navLinks')
          .evaluate((el) => !el.classList.contains('open'))
          .catch(() => true);
        check(`${current} closes on link click (${href})`, closed);
      }
    }

    current = `${tag}`;
    check(`${tag} console/network clean`, problems.length === 0,
      problems.slice(0, 3).join(' | '));

    await ctx.close();
  }

  await browser.close();
  console.log(`\n== public-site: ${passed} passed, ${failed} failed ==`);
  if (fails.length) { console.log('failures:'); fails.forEach((f) => console.log('  - ' + f)); }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
