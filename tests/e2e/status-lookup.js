/* Stage 4 e2e — status lookup.
 *
 *   VERIFY_ADMIN_USER=... VERIFY_ADMIN_PASSWORD=... \
 *     node tests/e2e/status-lookup.js [base]        (default :8090)
 *
 * Registers two squads via the API, then on /status:
 *  - correct Reg ID + phone, and Reg ID + email show that team's status,
 *    note state, group/schedule cells and the "next steps" guidance;
 *  - wrong ID / wrong contact / mixed-up pair all show the SAME generic
 *    "No registration found" message with no result card;
 *  - the correction-request form submits and confirms;
 *  - an admin approval (API) shows up on the very next lookup;
 *  - the 5/min lookup rate limit returns 429 for the 6th attempt.
 * The rate bucket is shared by lookup + correction requests, so the script
 * sleeps out one 60 s window before the rate-limit leg.
 */
'use strict';

const { chromium } = require('playwright');
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

function squad(tag, name, baseUid, phone, email) {
  return {
    teamName: name,
    teamTag: tag,
    guildName: name + ' Guild',
    capIgn: tag + 'CAP',
    capUid: String(baseUid),
    capEmail: email,
    capPhone: phone,
    capDiscord: tag.toLowerCase() + 'cap',
    roster: JSON.stringify([
      { slot: 'P1', role: 'IGL / Captain', ign: tag + 'CAP', uid: String(baseUid) },
      { slot: 'P2', role: 'Starter', ign: tag + 'P2', uid: String(baseUid + 1) },
      { slot: 'P3', role: 'Starter', ign: tag + 'P3', uid: String(baseUid + 2) },
      { slot: 'P4', role: 'Starter', ign: tag + 'P4', uid: String(baseUid + 3) },
    ]),
  };
}

(async () => {
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.error('Set VERIFY_ADMIN_USER / VERIFY_ADMIN_PASSWORD.');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text()) &&
        !/Failed to load resource/.test(m.text())) {
      errs.push(m.text());
    }
  });

  const jsonPost = (url, body) => page.evaluate(async ([u, b]) => {
    const tok = await fetch('/api/csrf').then((r) => r.json());
    const p = new URLSearchParams(b);
    const r = await fetch(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': tok.token },
      body: p,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [url, body]);

  /* ---------- provision two squads ---------- */
  await page.goto(BASE + '/', { waitUntil: 'load' });
  const a = squad('STTA', 'Status Squad A', 606003001, '9811112222',
    'stta@demo.invalid');
  const b = squad('STTB', 'Status Squad B', 606003101, '9833334444',
    'sttb@demo.invalid');
  const ra = await jsonPost('/api/register', a);
  const rb = await jsonPost('/api/register', b);
  check('provisioned two squads', ra.status === 201 && rb.status === 201,
    ra.status + '/' + rb.status);
  const regA = ra.json && ra.json.regCode;
  const teamA = ra.json && ra.json.teamId;
  console.log('  team A = ' + regA + ' (' + teamA + ')');

  const lookup = async (code, hint) => {
    await page.fill('#regCode', code);
    await page.fill('#hint', hint);
    await page.click('#lookupBtn');
    await page.waitForTimeout(700);
    return {
      error: (await page.textContent('#lookupError')).trim(),
      visible: await page.locator('#result').isVisible(),
      badge: (await page.textContent('#resBadge').catch(() => '')).trim(),
      team: (await page.textContent('#resTeam').catch(() => '')).trim(),
      next: (await page.textContent('#resNext').catch(() => '')).trim(),
      groupVisible: await page.locator('#resGroupCell').isVisible(),
    };
  };

  console.log('\n[A. correct pairs]');
  await page.goto(BASE + '/status', { waitUntil: 'load' });
  const byPhone = await lookup(regA, '9811112222');
  check('Reg ID + phone shows only that team',
    byPhone.visible && byPhone.team === 'Status Squad A' &&
    /pending/i.test(byPhone.badge) && /no action needed/i.test(byPhone.next),
    JSON.stringify(byPhone));
  check('pending team has no group/schedule cells',
    !byPhone.groupVisible);
  await page.screenshot({ path: path.join(SHOTS, 'status-pending-1440.png'),
    fullPage: true });

  const byEmail = await lookup(regA, 'stta@demo.invalid');
  check('Reg ID + email shows the same team',
    byEmail.visible && byEmail.team === 'Status Squad A', byEmail.team);

  console.log('\n[B. wrong / mixed pairs -> one generic message]');
  const wrongId = await lookup('BGMI26-0000', '9811112222');
  check('wrong Reg ID -> generic message, no card',
    !wrongId.visible && /No registration found/i.test(wrongId.error),
    wrongId.error);
  const wrongHint = await lookup(regA, '9899999999');
  check('wrong contact -> the SAME generic message',
    !wrongHint.visible && wrongHint.error === wrongId.error,
    wrongHint.error);
  const mixed = await lookup(regA, '9833334444');   // team B's real phone
  check('mixed-up pair (A\'s ID + B\'s phone) -> generic message',
    !mixed.visible && mixed.error === wrongId.error, mixed.error);
  // 5 lookups used in this 60 s window (2 in A, 3 here) — wait it out so the
  // correction request and the post-approval lookup get through.
  console.log('  (sleeping 61s to refresh the 5/min lookup window)');
  await sleep(61000);

  console.log('\n[C. correction request]');
  await lookup(regA, '9811112222');                 // get a result card back
  await page.click('#reqToggle');
  await page.fill('#reqMessage', 'E2E: please fix the captain UID typo.');
  await page.click('#reqBtn');
  await page.waitForTimeout(700);
  const reqOk = (await page.textContent('#reqOk').catch(() => '')).trim();
  const reqErr = (await page.textContent('#reqError').catch(() => '')).trim();
  const reqOkVisible = await page.locator('#reqOk').isVisible();
  check('correction request submits with a confirmation',
    reqOkVisible && reqOk.length > 0 && reqErr.length === 0,
    'visible=' + reqOkVisible + ' ok="' + reqOk.slice(0, 60) + '" ' +
    'err="' + reqErr.slice(0, 60) + '"');

  console.log('\n[D. admin decision shows immediately]');
  const token = await page.evaluate(async ([u, p]) => {
    const tok = await fetch('/api/csrf').then((r) => r.json());
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        'X-CSRF-Token': tok.token },
      body: JSON.stringify({ username: u, password: p }),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [ADMIN_USER, ADMIN_PASS]);
  check('admin login via API', token.status === 200 && !!token.json,
    token.status);
  /* the seeded demo fills the default 32 slots - make room first */
  const raiseLim = await page.evaluate(async (csrf) =>
    fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf },
      body: JSON.stringify({ slot_limit: 40 }),
    }).then(async (r) => ({ status: r.status,
      json: await r.json().catch(() => null) })), token.json && token.json.csrf);
  check('slot limit raised for the approval', raiseLim.status === 200,
    raiseLim.status + ' ' + JSON.stringify(raiseLim.json).slice(0, 60));
  const approve = await page.evaluate(async ([tid, csrf]) =>
    fetch('/api/admin/registrations/' + tid + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf },
      body: JSON.stringify({ status: 'approved' }),
    }).then((r) => r.json()), [teamA, token.json && token.json.csrf]);
  check('admin approves team A', approve && approve.ok === true,
    JSON.stringify(approve).slice(0, 80));
  const afterApprove = await lookup(regA, '9811112222');
  check('next lookup shows approved immediately',
    afterApprove.visible && /approved/i.test(afterApprove.badge) &&
    /You're in/i.test(afterApprove.next),
    afterApprove.badge + ' | ' + afterApprove.next.slice(0, 40));
  await page.screenshot({ path: path.join(SHOTS, 'status-approved-1440.png'),
    fullPage: true });

  console.log('\n[E. rate limit 5/min — waiting out the window first]');
  console.log('  (sleeping 61s for a fresh window)');
  await sleep(61000);
  let limited = null;
  for (let i = 1; i <= 7; i++) {
    const r = await lookup(regA, '9811112222');
    if (/Too many (lookups|attempts)/i.test(r.error)) { limited = r; break; }
  }
  check('6th lookup in a minute returns the rate-limit message',
    !!limited && !limited.visible,
    limited ? limited.error : 'never limited within 7 tries');

  check('no console/page errors', errs.length === 0,
    errs.slice(0, 2).join(' | '));
  console.log(`\n== status: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
