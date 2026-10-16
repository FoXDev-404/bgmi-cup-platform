/* Stage 6 e2e — matches, check-in (room lineup) and room details.
 *
 *   VERIFY_ADMIN_USER=... VERIFY_ADMIN_PASSWORD=... \
 *     node tests/e2e/matches-flows.js [base]        (default :8090)
 *
 * Fixtures: registers + approves STTA/STTB, puts six approved squads in a
 * fresh group, then drives the full match lifecycle via the admin API:
 * create (validation: missing group, unknown map), list/detail (eligible
 * squads of the group), check-in (approved + in-group only, unknown dropped,
 * dupes deduped), start guard (min 2), lineup lock after start, end,
 * publish guard (placements first), desk placements, publish -> public
 * history, delete guard, unpublish, reset, delete. Then the room details:
 * the admin's per-team schedule note shows on the team's /status page with
 * the group. Finally the /admin/matches UI: form create + check-in drawer +
 * delete with confirm dialog.
 *
 * Needs a freshly seeded DB (run scripts/seed_demo.py first).
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
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  const js = (r) => r.json().catch(() => null);
  const GET = async (p) => { const r = await api.get(BASE + p); return { s: r.status(), d: await js(r) }; };
  const POST = async (p, body, headers) => {
    const r = await api.post(BASE + p, { data: body || {},
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
    return { s: r.status(), d: await js(r), h: r.headers() };
  };
  const PUT = async (p, body, headers) => {
    const r = await api.put(BASE + p, { data: body || {},
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
  check('session + csrf available', me.s === 200 && !!csrf, me.s);

  /* ---------- fixtures: teams + groups ---------- */
  console.log('\n[fixtures]');
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
  const squad = (name, tag, capUid, phone, email, ign) => ({
    teamName: name, teamTag: tag, guildName: 'E2E Guild',
    capIgn: ign, capUid: capUid, capEmail: email, capPhone: phone,
    capDiscord: tag.toLowerCase(),
    roster: JSON.stringify([
      { slot: 'P1', role: 'IGL / Captain', ign: ign, uid: capUid },
      { slot: 'P2', role: 'Starter', ign: tag + 'P2', uid: String(Number(capUid) + 1) },
      { slot: 'P3', role: 'Starter', ign: tag + 'P3', uid: String(Number(capUid) + 2) },
      { slot: 'P4', role: 'Starter', ign: tag + 'P4', uid: String(Number(capUid) + 3) }]),
  });
  const queue = async (qs) => (await GET('/api/admin/registrations' + (qs || ''))).d;
  const setStatus = (tid, status) => POST(
    `/api/admin/registrations/${tid}/status`, { status, note: '' },
    { 'X-Admin-CSRF': csrf });
  const stta = await registerTeam(squad('Round One Squad', 'RNDA', '606101001',
    '9811112222', 'rnda@demo.invalid', 'RNDACAP'));
  const sttb = await registerTeam(squad('Round Two Squad', 'RNDB', '606102001',
    '9833334444', 'rndb@demo.invalid', 'RNDBCAP'));
  check('fixture squads registered', !!(stta && sttb), JSON.stringify([stta, sttb]));
  /* the seeded demo already fills the default 32 slots - make room first */
  const setLim = await POST('/api/admin/settings', { slot_limit: 40 },
    { 'X-Admin-CSRF': csrf });
  check('slot limit raised for the fixture squads', setLim.s === 200, setLim.s);
  check('fixtures approved', (await setStatus(stta.id, 'approved')).s === 200 &&
    (await setStatus(sttb.id, 'approved')).s === 200);

  const arena = await POST('/api/admin/groups', { name: 'E2E Arena', size: 8 },
    { 'X-Admin-CSRF': csrf });
  const empty = await POST('/api/admin/groups', { name: 'E2E Empty', size: 4 },
    { 'X-Admin-CSRF': csrf });
  check('fixture groups created', arena.s === 200 && empty.s === 200,
    arena.s + '/' + empty.s);
  const arenaId = arena.d.groupId;
  const approved = (await queue('?status=approved')).registrations
    .filter((r) => !/^RND/.test(r.team_tag)).slice(0, 4);
  const six = [stta.id, sttb.id].concat(approved.map((r) => r.team_id));
  for (const tid of six) {
    const r = await POST(`/api/admin/groups/${arenaId}/assign`, { teamId: tid },
      { 'X-Admin-CSRF': csrf });
    if (r.s !== 200) check('assign ' + tid, false, r.s);
  }
  const gs = await GET('/api/admin/groups');
  const arenaG = (gs.d.groups || []).find((g) => g.name === 'E2E Arena');
  check('six squads assigned to E2E Arena',
    !!arenaG && arenaG.count === 6, JSON.stringify(arenaG));

  /* ---------- create match: validation ---------- */
  console.log('\n[2. create match: validation]');
  const noGroup = await POST('/api/admin/matches', { group: '', map: 'Erangel' },
    { 'X-Admin-CSRF': csrf });
  check('missing group -> 400 pick-a-group', noGroup.s === 400 &&
    /Pick a group/.test((noGroup.d || {}).error || ''),
    noGroup.s + ' ' + ((noGroup.d || {}).error || ''));
  const badMap = await POST('/api/admin/matches',
    { group: 'E2E Arena', map: 'NopeLand' }, { 'X-Admin-CSRF': csrf });
  check('unknown map -> 400', badMap.s === 400 &&
    /Unknown map/.test((badMap.d || {}).error || ''),
    badMap.s + ' ' + ((badMap.d || {}).error || ''));

  /* ---------- create + list + detail ---------- */
  console.log('\n[3. create match, list, detail]');
  const created = await POST('/api/admin/matches', {
    group: 'E2E Arena', map: 'Erangel', notes: 'E2E lobby notes',
    teamIds: [stta.id, sttb.id],
  }, { 'X-Admin-CSRF': csrf });
  check('match created with a 2-squad lineup', created.s === 200 && created.d.ok &&
    created.d.state.match.status === 'upcoming' &&
    created.d.state.teams.length === 2,
    JSON.stringify((created.d || {}).error || (created.d || {}).state &&
      created.d.state.teams.length));
  const mid = created.d.state.match.id;
  const matchNo = created.d.state.match.match_number;
  check('match carries group/map/notes',
    created.d.state.match.group_name === 'E2E Arena' &&
    created.d.state.match.map === 'Erangel' &&
    created.d.state.match.notes === 'E2E lobby notes');

  const list = await GET('/api/admin/matches');
  const row = (list.d.matches || []).find((m) => m.id === mid);
  check('match list shows it (2 squads, 0 placed)',
    !!row && row.team_count === 2 && row.placed_count === 0,
    JSON.stringify(row));
  const detail = await GET('/api/admin/matches/' + mid);
  check('detail lists 6 eligible squads of the group',
    detail.s === 200 && (detail.d.eligible || []).length === 6,
    (detail.d.eligible || []).length);

  /* ---------- check-in ---------- */
  console.log('\n[4. check-in]');
  const checkin = await POST(`/api/admin/matches/${mid}/checkin`,
    { teamIds: six.concat(['CSM-BG-NOPE', stta.id]) }, { 'X-Admin-CSRF': csrf });
  check('check-in: 6 squads (unknown dropped, dupe deduped)',
    checkin.s === 200 && checkin.d.state.teams.length === 6,
    checkin.d.state.teams.length);
  const emptyMatch = await POST('/api/admin/matches', {
    group: 'E2E Empty', map: 'Sanhok', teamIds: [stta.id],
  }, { 'X-Admin-CSRF': csrf });
  check('team from another group cannot check in',
    emptyMatch.s === 200 && emptyMatch.d.state.teams.length === 0,
    emptyMatch.d.state.teams.length);
  const emid = emptyMatch.d.state.match.id;
  const startEmpty = await POST(`/api/admin/matches/${emid}/status`,
    { status: 'live' }, { 'X-Admin-CSRF': csrf });
  check('start refused with fewer than 2 squads', startEmpty.s === 400 &&
    /at least 2 squads/.test((startEmpty.d || {}).error || ''),
    startEmpty.s + ' ' + ((startEmpty.d || {}).error || ''));
  const delEmpty = await POST(`/api/admin/matches/${emid}`, { delete: true },
    { 'X-Admin-CSRF': csrf });
  check('unused match deleted', delEmpty.s === 200, delEmpty.s);

  const oneSquad = await POST(`/api/admin/matches/${mid}/checkin`,
    { teamIds: [stta.id] }, { 'X-Admin-CSRF': csrf });
  const startOne = await POST(`/api/admin/matches/${mid}/status`,
    { status: 'live' }, { 'X-Admin-CSRF': csrf });
  check('start refused with a 1-squad lobby', oneSquad.s === 200 &&
    startOne.s === 400, startOne.s);
  await POST(`/api/admin/matches/${mid}/checkin`, { teamIds: six },
    { 'X-Admin-CSRF': csrf });

  /* ---------- live -> end -> publish guard ---------- */
  console.log('\n[5. live, end, publish guard]');
  const start = await POST(`/api/admin/matches/${mid}/status`,
    { status: 'live' }, { 'X-Admin-CSRF': csrf });
  check('match started (live)', start.s === 200 &&
    start.d.state.match.status === 'live', start.s);
  const late = await POST(`/api/admin/matches/${mid}/checkin`,
    { teamIds: [stta.id] }, { 'X-Admin-CSRF': csrf });
  check('lineup locked after start', late.s === 400 &&
    /locked once the match has started/.test((late.d || {}).error || ''),
    late.s + ' ' + ((late.d || {}).error || ''));
  const end = await POST(`/api/admin/matches/${mid}/status`,
    { status: 'awaiting_verification' }, { 'X-Admin-CSRF': csrf });
  check('match ended -> awaiting review', end.s === 200 &&
    end.d.state.match.status === 'awaiting_verification', end.s);
  const earlyPub = await POST(`/api/admin/matches/${mid}/publish`,
    {}, { 'X-Admin-CSRF': csrf });
  check('publish refused before placements', earlyPub.s === 400 &&
    /needs a placement/.test((earlyPub.d || {}).error || ''),
    earlyPub.s + ' ' + ((earlyPub.d || {}).error || ''));
  const lineup = end.d.state.teams.map((t) => t.teamId);
  for (let i = 0; i < 5; i++) {
    const r = await POST(`/api/admin/match/${mid}/team/${lineup[i]}/placement`,
      { placement: i + 1 }, { 'X-Admin-CSRF': csrf });
    if (r.s !== 200) {
      check('manual place ' + (i + 1), false, r.s + ' ' + ((r.d || {}).error || ''));
    }
  }
  const dupPlace = await POST(`/api/admin/match/${mid}/team/${lineup[5]}/placement`,
    { placement: 1 }, { 'X-Admin-CSRF': csrf });
  check('claiming a taken place -> 400 "already belongs"', dupPlace.s === 400 &&
    /already belongs/.test((dupPlace.d || {}).error || ''),
    dupPlace.s + ' ' + ((dupPlace.d || {}).error || ''));
  const midState = await GET('/api/admin/matches/' + mid);
  const byId = Object.fromEntries(midState.d.state.teams.map((t) => [t.teamId, t]));
  check('refused claim left places intact; last squad got the free place',
    (byId[lineup[0]] || {}).placement === 1 &&
    (byId[lineup[5]] || {}).placement === 6,
    JSON.stringify(midState.d.state.teams.map((t) => [t.teamTag, t.placement])));

  /* ---------- publish -> public history ---------- */
  console.log('\n[6. publish, history]');
  const pub = await POST(`/api/admin/matches/${mid}/publish`,
    {}, { 'X-Admin-CSRF': csrf });
  check('match published', pub.s === 200 &&
    pub.d.state.match.status === 'published', pub.s);
  const live = await GET('/api/live/state');
  const h = (live.d.recentMatches || []).find((x) => x.matchNumber === matchNo);
  check('public state carries the published match + 6 results',
    !!h && h.results.length === 6 && h.results[0].placement === 1,
    JSON.stringify(live.d.recentMatches || []).slice(0, 80));
  check('published standings include the winner with points',
    !!h && (live.d.overallPublished || []).some((r) =>
      r.teamName === h.results[0].teamName && (r.points || 0) > 0),
    JSON.stringify((live.d.overallPublished || []).slice(0, 2)).slice(0, 120));
  check('public payload has no PII',
    !JSON.stringify(live.d).includes('@') &&
    !JSON.stringify(live.d).includes('9811112222'));

  /* ---------- delete guard, unpublish, reset, delete ---------- */
  console.log('\n[7. delete guard, unpublish, reset, delete]');
  const delPub = await POST(`/api/admin/matches/${mid}`, { delete: true },
    { 'X-Admin-CSRF': csrf });
  check('published match cannot be deleted', delPub.s === 400 &&
    /Unpublish the match before deleting/.test((delPub.d || {}).error || ''),
    delPub.s);
  const unpub = await POST(`/api/admin/matches/${mid}/unpublish`,
    {}, { 'X-Admin-CSRF': csrf });
  const live2 = await GET('/api/live/state');
  check('unpublish removes it from the public state',
    unpub.s === 200 &&
    !(live2.d.recentMatches || []).some((x) => x.matchNumber === matchNo));
  await POST(`/api/admin/matches/${mid}/publish`, {}, { 'X-Admin-CSRF': csrf });
  const reset = await POST(`/api/admin/matches/${mid}/reset`,
    {}, { 'X-Admin-CSRF': csrf });
  const live3 = await GET('/api/live/state');
  check('reset wipes placements and returns to upcoming',
    reset.s === 200 && reset.d.state.match.status === 'upcoming' &&
    reset.d.state.teams.every((t) => !t.placement) &&
    !(live3.d.recentMatches || []).some((x) => x.matchNumber === matchNo),
    reset.s + ' ' + JSON.stringify(reset.d.state.teams.map((t) => t.placement)));
  const del = await POST(`/api/admin/matches/${mid}`, { delete: true },
    { 'X-Admin-CSRF': csrf });
  const list2 = await GET('/api/admin/matches');
  check('after reset the match can be deleted',
    del.s === 200 && !(list2.d.matches || []).some((m) => m.id === mid));

  /* ---------- room details -> team /status ---------- */
  console.log('\n[8. room details on /status]');
  const note = 'E2E: Lobby 15:50 IST — Room ID 8812345, pass e2e-room';
  const put = await PUT('/api/admin/registrations/' + stta.id,
    { scheduleNote: note }, { 'X-Admin-CSRF': csrf });
  check('schedule/room note saves', put.s === 200 && put.d.ok, put.s);
  const audit = await GET('/api/admin/audit?teamId=' + stta.id);
  check('note change is audited',
    (audit.d.audit || []).some((r) => r.field === 'schedule_note' &&
      r.new_value === note));
  await page.goto(BASE + '/status', { waitUntil: 'load' });
  await page.fill('#regCode', stta.code);
  await page.fill('#hint', '9811112222');
  await page.click('#lookupBtn');
  await page.waitForTimeout(800);
  const sched = (await page.textContent('#resSchedule').catch(() => '')).trim();
  const grp = (await page.textContent('#resGroup').catch(() => '')).trim();
  check('team sees the room details + group on /status',
    sched.includes('Room ID 8812345') && grp === 'E2E Arena',
    grp + ' | ' + sched.slice(0, 50));
  await page.screenshot({ path: path.join(SHOTS, 'status-room-details-1440.png'),
    fullPage: true });

  /* ---------- /admin/matches UI ---------- */
  console.log('\n[9. matches UI]');
  await page.goto(BASE + '/admin/matches', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const hasForm = await page.locator('#createForm').isVisible();
  check('create form visible on /admin/matches', hasForm);
  const options = await page.locator('#newGroup option').allTextContents();
  check('group picker lists the fixture group', options.includes('E2E Arena'),
    options.join(','));
  await page.selectOption('#newGroup', 'E2E Arena');
  await page.selectOption('#newMap', 'Sanhok');
  await page.fill('#newNotes', 'UI created');
  await page.click('#createForm button[type=submit]');
  await page.waitForTimeout(900);
  const afterUi = await GET('/api/admin/matches');
  const uiMatch = (afterUi.d.matches || [])
    .find((m) => m.notes === 'UI created' && m.id !== mid);
  check('UI create made a new match', !!uiMatch, JSON.stringify(afterUi.d.matches));
  const drawer = await page.locator('#checkinCard').isVisible();
  const boxes = await page.locator('#checkinList input[type=checkbox]').count();
  check('check-in drawer opened with the 6 eligible squads',
    drawer && boxes === 6, 'drawer=' + drawer + ' boxes=' + boxes);
  await page.screenshot({ path: path.join(SHOTS, 'admin-matches-1440.png'),
    fullPage: true });
  await page.click('#checkinCancel');
  page.once('dialog', (d) => d.accept());
  await page.click(`[data-del="${uiMatch.id}"]`);
  await page.waitForTimeout(800);
  const afterDel = await GET('/api/admin/matches');
  check('UI delete (confirm dialog) removes it',
    !(afterDel.d.matches || []).some((m) => m.id === uiMatch.id));

  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  console.log(`\n== matches: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
