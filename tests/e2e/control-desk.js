/* Stage 7 e2e — control desk: 16-squad lobby, 4-player rule, swaps, AUTO,
 * the live/publish flow, all through the real /admin/control UI + API.
 *
 *   VERIFY_ADMIN_USER=... VERIFY_ADMIN_PASSWORD=... \
 *     node tests/e2e/control-desk.js [base]          (default :8090)
 *
 * Needs a freshly seeded DB (scripts/seed_demo.py + create_admin.py) and a
 * server that was restarted after seeding.
 *
 * Provisioning (idempotent): registers the two fixture squads RNDA (4
 * starters) and RNDB (4 starters + 2 substitutes), approves pending seed
 * squads until exactly 16 are approved, puts all 16 in a fresh group and
 * opens a 16-squad match checked in to the lobby.
 *
 * Then, on /admin/control: 16 cards x 4 players, start, per-player finish
 * with undo, a bench swap (roster sub in, swapped player keeps stats and is
 * refused further desk actions), AUTO reverting a pinned squad to the engine,
 * squad wipes filling 16th..13th place in elimination order, the unplaced
 * publish guard, manual pins 1..12, publish with confirm, and the public
 * results state.
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

(async () => {
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.error('Set VERIFY_ADMIN_USER / VERIFY_ADMIN_PASSWORD.');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const api = ctx.request;
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
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

  /* ---------- provisioning ---------- */
  console.log('\n[fixtures: 16 approved squads]');
  const queue = async (qs) => (await GET('/api/admin/registrations' + (qs || ''))).d;
  const setStatus = (tid, status) => POST(
    `/api/admin/registrations/${tid}/status`, { status, note: '' }, H);
  /* the seeded demo already fills the default 32 slots; make room for the
   * two fixture squads before approving anything */
  const setLim = await POST('/api/admin/settings', { slot_limit: 40 }, H);
  check('slot limit raised for the fixture squads', setLim.s === 200, setLim.s);
  const registerTeam = async (form) => {
    const t = await api.get(BASE + '/api/csrf').then(js);
    const r = await api.post(BASE + '/api/register', {
      form, headers: { 'X-CSRF-Token': t.token || '' },
    });
    if (r.status() === 201) { const d = await js(r); return { id: d.teamId, code: d.regCode }; }
    const q = await queue('?q=' + form.teamTag);
    const row = (q.registrations || []).find((x) => x.team_tag === form.teamTag);
    return row ? { id: row.team_id, code: row.reg_code } : null;
  };
  const squad = (tag, capUid, ign, subIgns) => ({
    teamName: 'Desk Squad ' + tag, teamTag: tag, guildName: 'E2E Guild',
    capIgn: ign, capUid: capUid, capEmail: tag.toLowerCase() + '@demo.invalid',
    capPhone: tag === 'RNDA' ? '9811112222' : '9833334444', capDiscord: tag.toLowerCase(),
    roster: JSON.stringify([
      { slot: 'P1', role: 'IGL / Captain', ign: ign, uid: capUid },
      { slot: 'P2', role: 'Starter', ign: tag + 'P2', uid: String(Number(capUid) + 1) },
      { slot: 'P3', role: 'Starter', ign: tag + 'P3', uid: String(Number(capUid) + 2) },
      { slot: 'P4', role: 'Starter', ign: tag + 'P4', uid: String(Number(capUid) + 3) },
    ].concat((subIgns || []).map((s, i) => ({
      slot: 'S' + (i + 1), role: 'Substitute', ign: s,
      uid: String(Number(capUid) + 10 + i),
    })))),
  });
  const rnda = await registerTeam(squad('RNDA', '606301001', 'E2E_CAP_A', []));
  const rndb = await registerTeam(squad('RNDB', '606302001', 'E2E_CAP_B',
    ['E2E_SUB1', 'E2E_SUB2']));
  check('fixture squads available', !!(rnda && rndb), JSON.stringify([rnda, rndb]));
  check('fixtures approved', (await setStatus(rnda.id, 'approved')).s === 200 &&
    (await setStatus(rndb.id, 'approved')).s === 200);
  let approvedCount = ((await queue('?status=approved')).counts || {}).approved || 0;
  const pending = (await queue('?status=pending')).registrations || [];
  for (const row of pending) {
    if (approvedCount >= 16) break;
    const res = await setStatus(row.team_id, 'approved');
    if (res.s === 200) approvedCount += 1;
  }
  check('16 approved squads ready', approvedCount >= 16, approvedCount);

  const groupsAll = ((await GET('/api/admin/matches')).d.groups) || [];
  let g16 = groupsAll.find((g) => g.name === 'E2E Sixteen');
  if (!g16) {
    const g = await POST('/api/admin/groups', { name: 'E2E Sixteen', size: 20 }, H);
    check('fixture group created', g.s === 200, g.s + ' ' + ((g.d || {}).error || ''));
    g16 = { id: g.d.groupId, name: 'E2E Sixteen' };
  }
  const approvedRows = (await queue('?status=approved')).registrations || [];
  const approvedIds = approvedRows.map((r) => r.team_id);
  /* RNDA + RNDB must be in the lobby regardless of listing order */
  const ids16 = [rnda.id, rndb.id].concat(
    approvedIds.filter((id) => id !== rnda.id && id !== rndb.id)).slice(0, 16);
  for (const tid of ids16) {
    const r = await POST(`/api/admin/groups/${g16.id}/assign`, { teamId: tid }, H);
    if (r.s !== 200) check('assign ' + tid, false, r.s + ' ' + ((r.d || {}).error || ''));
  }
  check('16 squads in E2E Sixteen', ids16.length === 16, ids16.length);

  const created = await POST('/api/admin/matches', {
    group: 'E2E Sixteen', map: 'Miramar', notes: 'E2E desk', teamIds: ids16,
  }, H);
  const mid = created.d.state.match.id;
  const mno = created.d.state.match.match_number;
  check('16-squad match created + checked in',
    created.s === 200 && created.d.state.teams.length === 16,
    ((created.d || {}).state || {}).teams && created.d.state.teams.length);
  const rndbTeam = created.d.state.teams.find((t) => t.teamTag === 'RNDB');
  check('RNDB bench lists its 2 substitutes',
    !!rndbTeam && rndbTeam.bench.filter((b) => b.kind === 'roster').length === 2,
    JSON.stringify((rndbTeam || {}).bench));

  /* ---------- desk UI: lobby ---------- */
  console.log('\n[desk: 16 cards, start]');
  await page.goto(BASE + '/admin/control', { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.selectOption('#matchPick', String(mid));
  await page.waitForTimeout(800);
  const cards = page.locator('#squadGrid .bc-squad');
  check('desk renders 16 squad cards', await cards.count() === 16, await cards.count());

  await page.click('#startBtn');
  await page.waitForFunction(
    () => document.querySelector('#deskStatus').textContent.includes('LIVE'),
    null, { timeout: 8000 });
  check('start button flipped the match live', true);
  await page.waitForTimeout(600);
  const started = (await GET('/api/admin/matches/' + mid)).d.state;
  check('4-player rule: every squad fields exactly 4 players',
    started.teams.every((t) => t.players.length === 4),
    JSON.stringify(started.teams.map((t) => [t.teamTag, t.players.length])));
  check('desk alive counter 16/16',
    (await page.textContent('#deskAlive')).trim() === '16/16',
    await page.textContent('#deskAlive'));
  const perCard = await cards.first().locator('.bc-player').count();
  check('cards show 4 player rows', perCard === 4, perCard);

  /* ---------- player finishes + undo ---------- */
  console.log('\n[desk: finish + undo]');
  const cardA = page.locator(`.bc-squad[data-team="${rnda.id}"]`);
  await cardA.locator('.bc-player').first()
    .locator('[data-field="kill"][data-value="1"]').click();
  await page.waitForFunction((tid) => {
    const c = document.querySelector(`.bc-squad[data-team="${tid}"]`);
    return c && c.querySelector('.bc-kcount').textContent.trim() === '1';
  }, rnda.id, { timeout: 8000 });
  const finA = await cardA.locator('.bc-squad-stats .bc-stat b').first().textContent();
  check('+1 finish lands on the player and the squad FIN', finA.trim() === '1', finA);
  /* default layout opens in Drawer mode (closed): the floating undo is the
     reachable one, the in-panel button when the log is visible */
  if (await page.locator('#floatUndo').isVisible()) await page.click('#floatUndo');
  else await page.click('#undoBtn');
  await page.waitForFunction((tid) => {
    const c = document.querySelector(`.bc-squad[data-team="${tid}"]`);
    return c && c.querySelector('.bc-kcount').textContent.trim() === '0';
  }, rnda.id, { timeout: 8000 });
  check('undo reverts the finish', true);
  check('event log records the undo',
    /Undid/i.test(await page.textContent('#sideEvents')));

  /* ---------- bench swap via the UI ---------- */
  console.log('\n[desk: substitute swap]');
  const cardB = page.locator(`.bc-squad[data-team="${rndb.id}"]`);
  await cardB.locator('[data-act="gear"]').click();
  await cardB.locator('[data-act="swap"]').click();
  await page.waitForSelector('#swIn', { timeout: 5000 });
  const inOptions = await page.locator('#swIn option').evaluateAll(
    (os) => os.map((o) => ({ value: o.value, text: o.textContent })));
  const subOpt = inOptions.find((o) => o.text.includes('E2E_SUB1'));
  check('swap dialog offers the registered substitute', !!subOpt,
    JSON.stringify(inOptions));
  await page.selectOption('#swOut', { index: 0 });
  await page.selectOption('#swIn', subOpt.value);
  await page.click('#swGo');
  await page.waitForFunction((tid) => {
    const c = document.querySelector(`.bc-squad[data-team="${tid}"]`);
    return c && c.textContent.includes('E2E_SUB1');
  }, rndb.id, { timeout: 8000 });
  check('swapped-in sub now plays in the card', true);
  check('the card still fields exactly 4 players',
    await cardB.locator('.bc-player').count() === 4);
  let st = (await GET('/api/admin/matches/' + mid)).d.state;
  let rb = st.teams.find((t) => t.teamTag === 'RNDB');
  const benchStats = (rb.bench || []).find((b) => b.kind === 'stats');
  check('the replaced player keeps his stats on the bench',
    !!benchStats && benchStats.name === 'E2E_CAP_B',
    JSON.stringify(rb.bench));
  const bench = await POST(`/api/admin/match/${mid}/player`, {
    teamId: rndb.id, playerId: benchStats.id, field: 'kill', value: 1,
  }, H);
  check('desk action on a benched player -> 400', bench.s === 400 &&
    /benched/.test((bench.d || {}).error || ''),
    bench.s + ' ' + ((bench.d || {}).error || ''));
  const act4 = rb.players.map((p) => p.id);
  const dupIn = await POST(`/api/admin/match/${mid}/team/${rndb.id}/swap`, {
    benchId: act4[0], inKind: 'stats', inId: act4[1],
  }, H);
  check('swapping in an already-active player -> 400 "already playing"',
    dupIn.s === 400 && /already playing/.test((dupIn.d || {}).error || ''),
    dupIn.s + ' ' + ((dupIn.d || {}).error || ''));
  const ghost = await POST(`/api/admin/match/${mid}/team/${rndb.id}/swap`, {
    benchId: act4[0], inKind: 'roster', inId: 999999,
  }, H);
  check('unknown substitute -> 400', ghost.s === 400 &&
    /not on this team's roster/.test((ghost.d || {}).error || ''),
    ghost.s + ' ' + ((ghost.d || {}).error || ''));
  const wrongBench = await POST(`/api/admin/match/${mid}/team/${rndb.id}/swap`, {
    benchId: benchStats.id, inKind: 'roster',
    inId: (rb.bench || []).find((b) => b.kind === 'roster').id,
  }, H);
  check('benching an already-benched player -> 400', wrongBench.s === 400 &&
    /already on the bench/.test((wrongBench.d || {}).error || ''),
    wrongBench.s + ' ' + ((wrongBench.d || {}).error || ''));
  await page.screenshot({ path: path.join(SHOTS, 'admin-control-1440.png'),
    fullPage: true });

  /* ---------- AUTO engine ---------- */
  console.log('\n[desk: wipes + AUTO]');
  st = (await GET('/api/admin/matches/' + mid)).d.state;
  const vict = st.teams.filter((t) => !/^RND/.test(t.teamTag)).slice(0, 4);
  const placed = [];
  for (const t of vict) {
    const r = await POST(`/api/admin/match/${mid}/team/${t.teamId}/eliminate`, {}, H);
    const ent = r.d.state.teams.find((x) => x.teamId === t.teamId);
    placed.push(ent.placement);
  }
  check('wipes fill 16th..13th in elimination order (AUTO)',
    JSON.stringify(placed) === '[16,15,14,13]', JSON.stringify(placed));
  await page.waitForTimeout(900);
  check('desk marks 4 wiped squads',
    await page.locator('#squadGrid .bc-squad--dead').count() === 4,
    await page.locator('#squadGrid .bc-squad--dead').count());
  const ranks = await page.locator('#squadGrid .bc-rank').allTextContents();
  check('deepest wipe owns 16th place on the desk', ranks.includes('#16'),
    ranks.join(','));

  st = (await GET('/api/admin/matches/' + mid)).d.state;
  const alive12 = st.teams.filter((t) => !(t.alive === 0 && t.knocked === 0))
    .sort((a, b) => (a.slot || 0) - (b.slot || 0));
  check('12 squads still alive', alive12.length === 12, alive12.length);
  const autoTid = alive12[11].teamId;
  await POST(`/api/admin/match/${mid}/team/${autoTid}/placement`,
    { placement: 12 }, H);
  await page.waitForTimeout(600);
  await page.locator(`.bc-squad[data-team="${autoTid}"] [data-act="auto"]`).click();
  await page.waitForFunction((tid) => {
    const c = document.querySelector(`.bc-squad[data-team="${tid}"]`);
    const b = c && c.querySelector('.bc-auto');
    return b && b.className.includes('bc-auto--on');
  }, autoTid, { timeout: 8000 });
  let afterAuto = (await GET('/api/admin/matches/' + mid)).d.state.teams
    .find((t) => t.teamId === autoTid);
  check('AUTO returns a pinned squad to the engine (place cleared)',
    afterAuto.placement === 0 && afterAuto.placementAuto === true,
    JSON.stringify([afterAuto.placement, afterAuto.placementAuto]));

  /* ---------- unplaced guard -> pins -> publish ---------- */
  console.log('\n[desk: publish flow]');
  await page.click('#endBtn');
  await page.waitForFunction(
    () => document.querySelector('#deskStatus').textContent.includes('Await'),
    null, { timeout: 8000 });
  const prob = (await page.textContent('#publishProblem')).trim();
  check('publish guard shows while squads are unplaced',
    /needs a placement/.test(prob) && !(await page.locator('#publishBtn').isEnabled()),
    prob);
  for (let i = 0; i < alive12.length; i++) {
    await POST(`/api/admin/match/${mid}/team/${alive12[i].teamId}/placement`,
      { placement: i + 1 }, H);
  }
  await page.waitForFunction(
    () => !document.querySelector('#publishBtn').disabled,
    null, { timeout: 8000 });
  check('publish unlocks once every squad has a place',
    await page.locator('#publishProblem').isHidden());
  page.once('dialog', (d) => d.accept());
  await page.click('#publishBtn');
  await page.waitForFunction(
    () => document.querySelector('#deskStatus').textContent.includes('Published'),
    null, { timeout: 8000 });
  check('publish button published the match', true);
  check('unpublish button appears for a published match',
    await page.locator('#unpublishBtn').isVisible());
  check('publish hint points at the live surfaces',
    /live on \/live and \/results/.test(await page.textContent('#publishHint')),
    await page.textContent('#publishHint'));
  await page.screenshot({ path: path.join(SHOTS, 'admin-control-published-1440.png'),
    fullPage: true });

  const liveS = await GET('/api/live/state');
  const h = (liveS.d.recentMatches || []).find((x) => x.matchNumber === mno);
  check('public results carry all 16 squads', !!h && h.results.length === 16,
    JSON.stringify((h || {}).results ? h.results.length : liveS.d.recentMatches));
  check('winner is listed first', !!h && h.results[0].placement === 1);
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`\n== control: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
