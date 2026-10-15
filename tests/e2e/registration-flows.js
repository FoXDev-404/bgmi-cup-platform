/* Stage 3 e2e — registration flow.
 *
 *   node tests/e2e/registration-flows.js [base]   (default :8090)
 *
 * A. Valid squad through the real UI (4 starters + 1 sub + logo + consent):
 *    review step -> confirm -> pending confirmation -> Reg ID -> squad pass
 *    (QR + PDF download) -> confirmation card actually becomes visible.
 * B. Invalid payloads against POST /api/register (fresh CSRF each): empty
 *    fields, bad phone/email/UID, duplicate tag, duplicate UID, 5 starters,
 *    3 subs, oversized + fake logos, script/SQL text in every field, honeypot.
 * C. Per-IP rate limit LAST (defaults: 30/h) — deliberately exhausts the
 *    register bucket for this IP, so nothing may register after this point.
 * D. Public pages leak no captain PII (emails/phones/UIDs) of any team.
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8090';
const SHOTS = path.join(__dirname, '..', 'screenshots');
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'bgmi-dl-'));

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

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

/* urlencoded payloads keep the multipart parser out of the picture */
function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) p.set(k, String(v));
  return p;
}

function roster4(prefix, baseUid) {
  return [
    { slot: 'P1', role: 'IGL / Captain', ign: prefix + 'CAP', uid: String(baseUid + 1) },
    { slot: 'P2', role: 'Starter', ign: prefix + 'P2', uid: String(baseUid + 2) },
    { slot: 'P3', role: 'Starter', ign: prefix + 'P3', uid: String(baseUid + 3) },
    { slot: 'P4', role: 'Starter', ign: prefix + 'P4', uid: String(baseUid + 4) },
  ];
}

function validPayload() {
  return {
    teamName: 'E2E Vipers',
    teamTag: 'EZQA',
    guildName: 'E2E Guild',
    capIgn: 'EZQCAP',
    capUid: '606001001',
    capEmail: 'e2e.vipers@demo.invalid',
    capPhone: '9812345670',
    capDiscord: 'e2ecap',
    roster: JSON.stringify([
      ...roster4('EZQ', '606001000'),
      { slot: 'S1', role: 'Substitute', ign: 'EZQSUB', uid: '606001005' },
    ]),
  };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => {
    // Deliberate 4xx/5xx rejects (invalid cases, rate limit) log a generic
    // "Failed to load resource" console error; real script bugs surface as
    // pageerror above and as explicit status/message assertions below.
    if (m.type() === 'error' && !/favicon/.test(m.text()) &&
        !/Failed to load resource/.test(m.text())) {
      errs.push(m.text());
    }
  });
  const post = (body, extra) => page.evaluate(async ([b, x]) => {
    const tok = await fetch('/api/csrf').then((r) => r.json());
    const r = await fetch('/api/register', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type':
        'application/x-www-form-urlencoded', 'X-CSRF-Token': tok.token },
        x || {}),
      body: b,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [body.toString(), extra]);

  /* ---------- A. valid squad through the UI ---------- */
  console.log('\n[A. valid squad via UI]');
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.fill('#teamName', 'E2E Vipers');
  await page.fill('#teamTag', 'EVPR');
  await page.fill('#guildName', 'E2E Guild');
  await page.setInputFiles('#teamLogo', {
    name: 'logo.png', mimeType: 'image/png', buffer: PNG_1PX,
  });
  await page.fill('#capIgn', 'E2ECAP');
  await page.fill('#capUid', '777001001');
  await page.fill('#capEmail', 'e2e.vipers@demo.invalid');
  await page.fill('#capPhone', '9812345670');
  await page.fill('#capDiscord', 'e2ecap');
  for (const [slot, fill] of [['p2', 'E2EP2'], ['p3', 'E2EP3'], ['p4', 'E2EP4']]) {
    const uid = { p2: '777001002', p3: '777001003', p4: '777001004' }[slot];
    await page.fill('#' + slot + 'Ign', fill);
    await page.fill('#' + slot + 'Uid', uid);
  }
  await page.click('#addSub');
  await page.fill('#subsWrap .ign-input', 'E2ESUB');
  await page.fill('#subsWrap .uid-input', '777001005');
  await page.click('label.tc-option:has(#agreeRules)');
  await page.click('label.tc-option:has(#agreeFairPlay)');
  const consent = await page.evaluate(() => ({
    rules: document.getElementById('agreeRules').checked,
    fair: document.getElementById('agreeFairPlay').checked,
  }));
  check('consent checkboxes toggle via their labels',
    consent.rules && consent.fair, JSON.stringify(consent));
  await page.click('#regSubmit');
  await page.waitForSelector('#regReview:not(.hidden)', { timeout: 10000 });
  check('review step gates the submit', true);
  await page.click('#reviewConfirm');
  await page.waitForSelector('#confirmation:not(.hidden)', { timeout: 20000 });
  const regCode = (await page.textContent('#confRegCode')).trim();
  const teamId = (await page.textContent('#confTeamId')).trim();
  check('confirmation shows a Reg ID + team ID',
    /^BGMI26-\d+$/.test(regCode) && /^CSM-BG-[A-Z0-9]+$/.test(teamId),
    regCode + ' / ' + teamId);
  const confText = await page.locator('#confirmation').innerText();
  check('pending review wording present',
    /PENDING REVIEW/i.test(confText) && /pending/i.test(confText));
  const cardOpacity = await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.confirm-card')).opacity === '1',
    null, { timeout: 6000 }).then(() => '1').catch(async () => await page
      .locator('.confirm-card').evaluate((el) => getComputedStyle(el).opacity));
  check('confirmation card is actually visible (reveal fired)',
    cardOpacity === '1', 'opacity=' + cardOpacity);
  const shareLinks = await page.$$eval('.share-btn', (els) => els.map((e) => ({
    href: e.href, rel: e.getAttribute('rel') || '',
    target: e.getAttribute('target') || '',
  })));
  const unsafe = shareLinks.filter((l) => l.target !== '_blank' ||
    !/noopener/.test(l.rel) || !/noreferrer/.test(l.rel));
  check('share links are external-safe (new tab + noopener noreferrer)',
    unsafe.length === 0, JSON.stringify(unsafe[0] || shareLinks[0]));
  const qrKids = await page.$$eval('#teamQR *', (els) => els.length);
  const qrSize = await page.locator('#teamQR canvas, #teamQR img, #teamQR svg')
    .first().boundingBox().catch(() => null);
  check('squad-pass QR rendered',
    qrKids > 0 && !!qrSize && qrSize.width > 20,
    'kids=' + qrKids + ' box=' + JSON.stringify(qrSize && qrSize.width));
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.click('#downloadPass'),
  ]);
  if (download) {
    const target = path.join(DL, download.suggestedFilename());
    await download.saveAs(target);
    const size = fs.statSync(target).size;
    check('squad-pass PDF downloads', size > 1024,
      download.suggestedFilename() + ' ' + size + 'B');
  } else {
    check('squad-pass PDF downloads', false, 'no download event');
  }
  await page.screenshot({ path: path.join(SHOTS, 'reg-confirmation-1440.png'),
    fullPage: true });
  console.log('  reg = ' + regCode);

  /* ---------- B. rejection matrix ---------- */
  console.log('\n[B. invalid payloads]');
  const cases = [];
  const add = (name, mutate, expectStatus, expectRe) => {
    const p = validPayload();
    mutate(p);
    cases.push({ name, p, expectStatus, expectRe });
  };
  add('empty required fields (teamName)', (p) => { delete p.teamName; }, 400, /name/i);
  add('bad phone', (p) => { p.capPhone = '12345'; }, 400, /phone/i);
  add('bad email', (p) => { p.capEmail = 'not-an-email'; }, 400, /email/i);
  add('bad UID (letters)', (p) => { p.capUid = 'abcd1234'; }, 400, /Character ID/i);
  add('bad UID (13 digits)', (p) => { p.capUid = '1234567890123'; }, 400, /Character ID/i);
  add('duplicate team tag (PXRA)', (p) => { p.teamTag = 'PXRA'; }, 409, /tag/i);
  add('duplicate UID across squads', (p) => {
    const r = JSON.parse(p.roster);        // the roster uid is the unique one
    r[0].uid = '900013700';
    p.roster = JSON.stringify(r);
    p.capUid = '900013700';
  }, 409, /already on squad/i);
  add('5 starters', (p) => {
    const r = JSON.parse(p.roster);
    r.push({ slot: 'P5', role: 'Starter', ign: 'E2EP5', uid: '777001410' });
    p.roster = JSON.stringify(r);
  }, 400, /4 starters/i);
  add('3 substitutes', (p) => {
    const r = JSON.parse(p.roster);
    r.push({ slot: 'S2', role: 'Substitute', ign: 'E2ES2', uid: '777001411' });
    r.push({ slot: 'S3', role: 'Substitute', ign: 'E2ES3', uid: '777001412' });
    p.roster = JSON.stringify(r);
  }, 400, /substitutes/i);
  add('oversized logo (>2MB)', (p) => {
    p.logoDataUrl = 'data:image/png;base64,' +
      Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024, 7)]).toString('base64');
  }, 400, /2 MB|thicc/i);
  add('fake logo (wrong magic bytes)', (p) => {
    p.logoDataUrl = 'data:image/png;base64,' +
      Buffer.from('this is definitely not a png').toString('base64');
  }, 400, /PNG|JPG|WEBP/i);
  add('script tag in team name', (p) => { p.teamName = '<script>alert(1)</script>'; }, 400, /name/i);
  add('SQL-like text in every field', (p) => {
    const sql = "'; DROP TABLE registrations;--";
    p.teamName = 'A' + sql; p.teamTag = 'SQL'; p.guildName = sql;
    p.capIgn = 'DRP'; p.capDiscord = sql;
  }, 400, /.+/);
  add('honeypot filled', (p) => { p.company = 'https://spam.example'; }, 403, /Bot/i);

  let allRejected = true;
  for (const c of cases) {
    const { status, json } = await post(form(c.p));
    const msg = (json && json.error) || '';
    const okStatus = status === c.expectStatus;
    const okMsg = c.expectRe.test(msg);
    const noTeam = !(json && json.teamId);
    if (!(okStatus && okMsg && noTeam)) {
      allRejected = false;
      console.log(`  FAIL  ${c.name} -> ${status} "${msg}"`);
    } else {
      console.log(`  PASS  ${c.name} -> ${c.expectStatus} "${msg}"`);
    }
    passed += (okStatus && okMsg && noTeam) ? 1 : 0;
    failed += (okStatus && okMsg && noTeam) ? 0 : 1;
  }
  check('every invalid payload was rejected with a clear message',
    allRejected, cases.length + ' cases');

  /* ---------- C. rate limit (last — burns the register bucket) ---------- */
  console.log('\n[C. per-IP rate limit]');
  let limited = null;
  let attempts = 0;
  for (; attempts < 45; attempts++) {
    const { status, json } = await post(form(validPayload()));
    if (status === 429) { limited = json && json.error; break; }
  }
  check('register rate limit eventually returns 429', !!limited,
    'after ' + attempts + ' extra posts: ' + limited);

  /* ---------- D. no PII on public surfaces ---------- */
  console.log('\n[D. PII scan]');
  const secrets = ['e2e.vipers@demo.invalid', '9812345670', '777001001',
    'demo.invalid'];
  await page.goto(BASE + '/api/public/approved', { waitUntil: 'load' })
    .catch(() => null);
  const feed = await page.evaluate(() => document.body.innerText).catch(() => '');
  const feedBad = secrets.filter((s) => feed.includes(s));
  check('/api/public/approved carries no captain PII', feedBad.length === 0,
    feedBad.join(','));
  for (const p of ['/', '/teams', '/live', '/results']) {
    await page.goto(BASE + p, { waitUntil: 'load' });
    const html = await page.content();
    const bad = secrets.filter((s) => html.includes(s));
    check(`${p} source carries no captain PII`, bad.length === 0, bad.join(','));
  }
  check('no console/page errors during the flow', errs.length === 0,
    errs.slice(0, 2).join(' | '));

  console.log(`\n== registration: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  fs.rmSync(DL, { recursive: true, force: true });
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
