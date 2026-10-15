/* R2-5 dry run — the whole operator journey in one pass, on a match the
   script creates itself (repeatable, doesn't depend on seeded state):
     login -> create + check in a squad lobby -> open it on the desk -> start
     -> every card shows exactly four players -> log finishes / kills / damage
     / statuses -> manual adjustment -> squads wipe and AUTO seats them 1-4 ->
     publish gating -> duplicate-placement conflict -> publish -> verify the
     engine's points on /live, /results and the legacy overlay payloads.
   Screenshots land in qa-shots/ (desk 1440 + 390 mid-match, desk published,
   /live, /results, overall/results/map-feed/live overlay scenes).

   Usage:
     BGMI_DB=data/demo.db BGMI_ADMIN_USER=admin BGMI_ADMIN_PASSWORD=... \
       node scripts/dry-run.js [http://127.0.0.1:8080]
   Env: DRY_GROUP=Group A      pick the lobby group (default: Group A, else
                               the biggest approved group).

   The match it creates stays PUBLISHED afterwards — that is the point: a
   completed demo event. Run it again and it adds another match.             */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const USER = process.env.BGMI_ADMIN_USER || '';
const PASS = process.env.BGMI_ADMIN_PASSWORD || '';
const GROUP = process.env.DRY_GROUP || '';
const SHOTS = path.join(__dirname, '..', 'qa-shots');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS  ' + name); }
  else {
    failed += 1;
    console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : ''));
  }
}

function dbToken() {
  const out = execFileSync(process.env.PYTHON || 'python', ['-c',
    'import os, sqlite3; c = sqlite3.connect(os.environ["BGMI_DB"]); ' +
    'print(c.execute(' +
    '"SELECT value FROM overlay_settings WHERE key=\'token\'").fetchone()[0])'],
  { encoding: 'utf8' });
  return out.trim();
}

(async () => {
  if (!USER || !PASS) {
    console.error('Set BGMI_ADMIN_USER and BGMI_ADMIN_PASSWORD.');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror ' + e));
  page.on('console', (m) => {
    // the 400 from the deliberate duplicate-placement click is expected
    if (m.type() === 'error' && !/favicon/.test(m.text()) &&
        !/400 \(Bad Request\)/.test(m.text())) {
      errs.push('console ' + m.text());
    }
  });
  page.on('dialog', (d) => d.accept());

  /* ---------- login ---------- */
  console.log('\n[login + lobby]');
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/admin/login')
      && r.status() === 200, { timeout: 15000 }),
    page.click('#loginBtn'),
  ]);
  await page.waitForSelector('#logoutNavBtn', { timeout: 15000 });

  const api = (p) => page.evaluate((u) =>
    fetch(u, { credentials: 'same-origin' }).then((r) => r.json()), BASE + p);

  /* ---------- provision the lobby (create + check in) ---------- */
  const regs = await api('/api/admin/registrations?status=approved');
  const byGroup = {};
  (regs.registrations || []).forEach((r) => {
    const g = r.group_name || r.group || '';
    if (g) (byGroup[g] = byGroup[g] || []).push(r.team_id);
  });
  const group = GROUP || (byGroup['Group A'] ? 'Group A'
    : Object.keys(byGroup).sort((a, b) => byGroup[b].length - byGroup[a].length)[0]);
  const teamIds = (byGroup[group] || []).slice(0, 16);
  check('found a lobby group with squads to check in',
    teamIds.length >= 2, group + ' -> ' + teamIds.join(','));
  if (teamIds.length < 2) { await browser.close(); process.exit(2); }

  const before = await api('/api/live/state');
  const base = {};
  (before.overall || []).forEach((r) => {
    base[r.teamId] = { points: r.points, matches: r.matches, wins: r.wins };
  });

  await page.goto(BASE + '/admin/control', { waitUntil: 'load' });
  await page.waitForFunction(() => window.BC && window.BC.csrf,
    null, { timeout: 15000 });
  const created = await page.evaluate(([g, ids]) =>
    fetch('/api/admin/matches', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': window.BC.csrf },
      body: JSON.stringify({ group: g, map: 'Erangel',
        notes: 'R2-5 dry run', teamIds: ids }),
    }).then((r) => r.json()), [group, teamIds]);
  check('match created + squads checked in',
    created.ok && created.state.teams.length === teamIds.length,
    JSON.stringify(created).slice(0, 140));
  if (!created.ok) { await browser.close(); process.exit(2); }
  const mid = created.state.match.id;
  const matchNo = created.state.match.match_number;
  console.log('  match ' + matchNo + ' (id ' + mid + '), group ' + group);

  /* ---------- open on the desk + start ---------- */
  await page.goto(BASE + '/admin/control', { waitUntil: 'load' });
  await page.waitForFunction((id) => {
    const sel = document.getElementById('matchPick');
    return !!sel && [...sel.options].some((o) => o.value === String(id));
  }, mid, { timeout: 15000 });
  await page.selectOption('#matchPick', String(mid));
  await page.waitForFunction((n) =>
    document.getElementById('deskMatchNo').textContent === 'Match ' + n,
    matchNo, { timeout: 15000 });
  await page.click('#startBtn');
  await page.waitForFunction((id) =>
    fetch('/api/admin/matches/' + id, { credentials: 'same-origin' })
      .then((r) => r.json()).then((d) =>
        d.state.match.status === 'live'), mid, { timeout: 10000 });
  await page.waitForSelector('.bc-squad .bc-player', { timeout: 15000 });

  const cardTeams = await page.$$eval('.bc-squad',
    (els) => els.map((e) => e.dataset.team));
  const rowCounts = await page.$$eval('.bc-squad',
    (els) => els.map((e) => e.querySelectorAll('.bc-player').length));
  const uids = await page.$$eval('.bc-player .bc-pid small',
    (els) => els.map((e) => e.textContent.trim()));
  check('start puts exactly 4 players on every squad card',
    cardTeams.length >= 2 && rowCounts.every((n) => n === 4),
    'cards=' + cardTeams.length + ' rows=' + rowCounts.join(','));
  check('every player row carries IGN + UID',
    uids.length === cardTeams.length * 4 &&
    uids.every((t) => t.indexOf('UID ') === 0), uids[0]);
  const [A, B, C, D] = cardTeams;

  const stat = (team, label) => page.evaluate(([t, l]) => {
    const card = document.querySelector('.bc-squad[data-team="' + t + '"]');
    const el = [...card.querySelectorAll('.bc-stat')]
      .find((s) => s.querySelector('small').textContent.trim() === l);
    return el.querySelector('b').textContent.trim();
  }, [team, label]);
  const waitStat = (team, label, want) => page.waitForFunction(([t, l, w]) => {
    const card = document.querySelector('.bc-squad[data-team="' + t + '"]');
    const el = [...card.querySelectorAll('.bc-stat')]
      .find((s) => s.querySelector('small').textContent.trim() === l);
    return el.querySelector('b').textContent.trim() === w;
  }, [team, label, want], { timeout: 10000 });
  const playerRow = (team, i) =>
    page.locator('.bc-squad[data-team="' + team + '"] .bc-player').nth(i);
  const clickField = async (team, i, field, value) => {
    await playerRow(team, i)
      .locator('[data-field="' + field + '"][data-value="' + value + '"]')
      .click();
    await page.waitForTimeout(500);
  };
  const setStatus = async (team, i, status) => {
    await playerRow(team, i)
      .locator('[data-field="status"][data-value="' + status + '"]')
      .click();
    await page.waitForTimeout(500);
  };

  /* ---------- score the match ---------- */
  console.log('\n[desk actions]');
  await clickField(B, 0, 'kill', '1');
  const bkill = await playerRow(B, 0).locator('.bc-kcount').textContent();
  check('player finish counter + squad FIN follow the kill',
    bkill.trim() === '1' && (await stat(B, 'FIN')) === '1',
    'kcount=' + bkill.trim() + ' FIN=' + await stat(B, 'FIN'));

  await playerRow(B, 0).locator('[data-field="damage"][data-step="100"]')
    .click();
  await page.waitForTimeout(500);
  const dmg = await playerRow(B, 0).locator('.bc-dmg').inputValue();
  check('damage stepper adds 100', dmg === '100', 'dmg=' + dmg);

  await setStatus(B, 0, 'out');
  await setStatus(B, 1, 'out');
  await setStatus(B, 2, 'knocked');
  const bOut = await playerRow(B, 0).locator('[data-field="status"]'
    + '[data-value="out"]').getAttribute('aria-pressed');
  const bKnockCls = await playerRow(B, 2).getAttribute('class');
  const bAliveCls = await playerRow(B, 3).getAttribute('class');
  check('Alive/Knocked/Out buttons drive the row state',
    bOut === 'true' && /bc-player--knocked/.test(bKnockCls)
    && /bc-player--alive/.test(bAliveCls),
    'outPressed=' + bOut + ' row3=' + bKnockCls + ' row4=' + bAliveCls);

  await setStatus(C, 0, 'out');
  await setStatus(C, 1, 'knocked');

  await page.click('.bc-squad[data-team="' + C + '"] .bc-gear');
  await page.click('.bc-menu:not(.hidden) button[data-act="adjust"]');
  await page.waitForSelector('.bc-dlg[open]');
  await page.fill('#adjPts', '2');
  await page.fill('#adjReason', 'R2-5 dry run');
  await page.click('#adjGo');
  await page.waitForSelector('.bc-dlg', { state: 'detached' });
  await waitStat(C, 'PTS', '2');
  const adjChip = await page.$eval('.bc-squad[data-team="' + C + '"] .bc-adj',
    (el) => el.textContent.trim());
  check('manual adjustment applies with a chip + reason',
    adjChip === '+2', 'chip=' + adjChip);

  /* squad A wipes -> AUTO seats it (deepest free seat = 4th) */
  for (let i = 0; i < 4; i++) await setStatus(A, i, 'out');
  await waitStat(A, 'PLACE', '4');
  const deadCls = await page.$eval('.bc-squad[data-team="' + A + '"]',
    (el) => el.className);
  const rankA = await page.$eval('.bc-squad[data-team="' + A + '"] .bc-rank',
    (el) => el.textContent.trim());
  check('wiped squad dims, AUTO-seats 4th and shows the rank badge',
    /bc-squad--dead/.test(deadCls) && rankA === '#4',
    'class=' + deadCls + ' rank=' + rankA);

  console.log('\n[desk screenshots at 1440 / 390]');
  await page.screenshot({ path: path.join(SHOTS, 'r25-desk-1440.png'),
    fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'r25-desk-390.png'),
    fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  console.log('  saved r25-desk-1440.png / r25-desk-390.png');

  /* ---------- end + publish gating ---------- */
  console.log('\n[publish gating + conflict]');
  await page.click('#endBtn');
  await page.waitForFunction((id) =>
    fetch('/api/admin/matches/' + id, { credentials: 'same-origin' })
      .then((r) => r.json()).then((d) =>
        d.state.match.status === 'awaiting_verification'), mid,
    { timeout: 10000 });
  const disabled = await page.$eval('#publishBtn', (b) => b.disabled);
  const problem = await page.$eval('#publishProblem', (el) => el.textContent);
  check('publish stays blocked while squads are unplaced',
    disabled && /placement/i.test(problem),
    'disabled=' + disabled + ' problem=' + problem);

  await page.fill('.bc-squad[data-team="' + C + '"] .bc-place-input', '4');
  await page.$eval('.bc-squad[data-team="' + C + '"] .bc-place-input',
    (el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForSelector('.bc-squad[data-team="' + C + '"] .bc-conflict',
    { timeout: 8000 });
  check('duplicate placement is rejected with the PLACE TAKEN badge',
    (await stat(C, 'PLACE')) !== '4',
    'C place=' + await stat(C, 'PLACE'));

  /* ---------- wipe the rest, AUTO seats them, publish ---------- */
  console.log('\n[finish the match]');
  await setStatus(B, 2, 'out');
  await setStatus(B, 3, 'out');
  await waitStat(B, 'PLACE', '3');
  await setStatus(C, 1, 'out');
  await setStatus(C, 2, 'out');
  await setStatus(C, 3, 'out');
  await waitStat(C, 'PLACE', '2');
  await waitStat(D, 'PLACE', '1');
  const places = {};
  for (const t of [A, B, C, D]) places[t] = await stat(t, 'PLACE');
  check('elimination order + lone survivor = unique 1-4 AUTO seats',
    new Set(Object.values(places)).size === 4
    && places[D] === '1' && places[C] === '2'
    && places[B] === '3' && places[A] === '4', JSON.stringify(places));

  await page.waitForSelector('#publishBtn:not([disabled])', { timeout: 8000 });
  await page.click('#publishBtn');
  await page.waitForFunction((id) =>
    fetch('/api/admin/matches/' + id, { credentials: 'same-origin' })
      .then((r) => r.json()).then((d) =>
        d.state.match.status === 'published'), mid, { timeout: 10000 });
  const unpub = await page.$eval('#unpublishBtn', (b) => !b.hidden);
  check('published (unpublish available as the escape hatch)', unpub);

  const state = await page.evaluate((id) =>
    fetch('/api/admin/matches/' + id, { credentials: 'same-origin' })
      .then((r) => r.json()).then((d) => d.state), mid);
  const pts = {};
  state.teams.forEach((t) => { pts[t.teamId] = t.points; });
  check('match points = placement + finishes + adjustment',
    pts[D] === 10 && pts[C] === 8 && pts[B] === 6 && pts[A] === 5,
    JSON.stringify(pts));
  await page.screenshot({ path: path.join(SHOTS, 'r25-desk-published.png'),
    fullPage: true });

  /* ---------- /live, /results and the overlays ---------- */
  console.log('\n[public pages + overlays]');
  const liveState = await api('/api/live/state');
  const overall = {};
  (liveState.overall || []).forEach((r) => { overall[r.teamId] = r; });
  const expect = {};
  expect[A] = 5; expect[B] = 6; expect[C] = 8; expect[D] = 10;
  const overallOk = [A, B, C, D].every((t) =>
    overall[t].points === (base[t] ? base[t].points : 0) + expect[t] &&
    overall[t].matches === (base[t] ? base[t].matches : 0) + 1 &&
    overall[t].wins === (base[t] ? base[t].wins : 0) + (t === D ? 1 : 0));
  check('/api/live/state overall sums history + the new match',
    overallOk, JSON.stringify([A, B, C, D].map((t) => [t,
      base[t] ? base[t].points : 0, overall[t].points])));
  const topTeam = state.teams.find((t) => t.teamId === D);

  await page.goto(BASE + '/live', { waitUntil: 'load' });
  await page.waitForSelector('tr', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const liveWinnerRow = await page.locator('tr', { hasText: topTeam.teamName })
    .first().innerText().catch(() => '');
  check('/live shows the updated overall table',
    liveWinnerRow.includes(String(overall[D].points)),
    'row=' + liveWinnerRow.replace(/\s+/g, ' ').slice(0, 70));
  await page.screenshot({ path: path.join(SHOTS, 'r25-live-1440.png'),
    fullPage: true });

  await page.goto(BASE + '/results', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const resultsText = (await page.evaluate(() => document.body.innerText))
    .replace(/\s+/g, ' ');
  const card4 = page.locator('section.bc-card', {
    has: page.locator('p.bc-p', { hasText: 'Match #' + matchNo }),
  }).first();
  const card4txt = (await card4.innerText().catch(() => ''))
    .replace(/\s+/g, ' ');
  check('/results lists the new match with winner, placement and 10pts',
    card4txt.includes(topTeam.teamName) && card4txt.includes('1º')
    && card4txt.includes('10pts'),
    'card=' + card4txt.slice(0, 110));
  const winnerRow = await page.locator('tr', { hasText: topTeam.teamName })
    .first().innerText().catch(() => '');
  check('/results overall standings add the new match to the totals',
    winnerRow.includes(String(overall[D].points)),
    'row=' + winnerRow.replace(/\s+/g, ' ').slice(0, 70));
  check('/results names the winner after the new match',
    new RegExp(topTeam.teamName, 'i').test(resultsText), topTeam.teamName);
  await page.screenshot({ path: path.join(SHOTS, 'r25-results-1440.png'),
    fullPage: true });

  const token = dbToken();
  const ovState = (scene) => page.evaluate(([b, t, s]) =>
    fetch(b + '/api/overlay/state/' + s + '?token=' + t,
      { credentials: 'omit' }).then((r) => r.json()),
  [BASE, token, scene]);
  const overallOv = await ovState('overall');
  const ovS = overallOv.state || {};
  const history = ovS.matchHistory || [];
  const nameOf = {};
  state.teams.forEach((t) => { nameOf[t.teamId] = t.teamName; });
  const mine = history.find((h) => h.matchNumber === matchNo) || { results: [] };
  const byName = {};
  mine.results.forEach((r) => { byName[r.teamName] = r; });
  const everyOk = Object.keys(expect).every((t) =>
    byName[nameOf[t]] && byName[nameOf[t]].matchPoints === expect[t]);
  check('overall overlay payload carries the new match + points',
    mine.results.length === teamIds.length && everyOk,
    JSON.stringify(Object.keys(byName).map((n) => [n, byName[n].matchPoints])));
  check('overlay carries the elimination-ordered placements',
    byName[nameOf[D]] && byName[nameOf[D]].placement === 1
    && byName[nameOf[C]].placement === 2 && byName[nameOf[B]].placement === 3
    && byName[nameOf[A]].placement === 4);
  check('legacy placementPoints exclude the manual adjustment',
    byName[nameOf[C]].placementPoints === 6
    && byName[nameOf[C]].matchPoints === 8,
    'pp=' + byName[nameOf[C]].placementPoints);
  const ovTeams = {};
  (ovS.teams || []).forEach((t) => { ovTeams[t.teamName] = t.overallPoints; });
  check('overall overlay standings match the engine',
    ovTeams[topTeam.teamName] === overall[D].points,
    'overlay=' + ovTeams[topTeam.teamName] + ' api=' + overall[D].points);
  const ovText = JSON.stringify(overallOv);
  check('overlay payload leaks no UID or player emails',
    !uids.some((u) => ovText.includes(u.replace('UID ', ''))) &&
    !/@/.test(ovText));

  const cdn = await ovState('chicken-dinner');
  check('chicken-dinner overlay knows the newest winner',
    JSON.stringify(cdn).includes(topTeam.teamName), topTeam.teamName);

  const ovPage = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const scene of ['overall', 'results', 'map-feed', 'live']) {
    await ovPage.goto(BASE + '/overlay/' + scene + '?token=' + token,
      { waitUntil: 'load' });
    await ovPage.waitForTimeout(1600);
    await ovPage.screenshot(
      { path: path.join(SHOTS, 'r25-overlay-' + scene + '.png') });
  }
  await ovPage.close();
  console.log('  saved r25-overlay-{overall,results,map-feed,live}.png');

  check('no unexpected console or page errors', errs.length === 0,
    errs.join(' | ').slice(0, 200));

  console.log('\n== dry run: ' + passed + ' passed, ' + failed + ' failed ==');
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
