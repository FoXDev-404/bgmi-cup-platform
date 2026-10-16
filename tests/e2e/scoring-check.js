/* Stage 8 e2e — independent scoring check.
 *
 *   VERIFY_ADMIN_USER=... VERIFY_ADMIN_PASSWORD=... \
 *     node tests/e2e/scoring-check.js [base]        (default :8090)
 *
 * Needs a freshly seeded DB (scripts/seed_demo.py + create_admin.py) and a
 * server restarted after seeding.
 *
 * The expected table is computed here from an independent copy of the scoring
 * model (never imported from the app): points = kills*kill_points +
 * placement_points + adjustment, overall order = points desc then the
 * configured tie-breakers. Four fixture squads play three matches with a
 * deliberate 21-point tie, a win-count tie-breaker case, a penalty, then a
 * tie-breaker reorder and a scoring-rules change; every snapshot is compared
 * against the independent table on three surfaces: /api/live/state,
 * the /results page DOM and the admin standings CSV (plus the public
 * per-match result lists).
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

/* independent scoring model ------------------------------------------------ */
const TAGS = ['SCRA', 'SCRB', 'SCRC', 'SCRD'];
const NAMES = {};
TAGS.forEach((t) => { NAMES[t] = 'Score Squad ' + t; });
let KILL = 1;                                    // current kill points
let PLACE = { 1: 10, 2: 6, 3: 5, 4: 4 };         // current placement points
let TB = ['wins', 'placement_points', 'finish_points', 'last_placement'];
const published = [];                            // {mno, plan, pointsByTag}
const GROUP = 'E2E Score';

const M1 = {
  SCRA: { place: 1, kills: 2, adj: -10, reason: 'rule 4.2 — late drop penalty' },
  SCRB: { place: 2, kills: 2 }, SCRC: { place: 3, kills: 1 },
  SCRD: { place: 4, kills: 0 },
};
const M2 = {
  SCRA: { place: 2, kills: 1 }, SCRB: { place: 4, kills: 3 },
  SCRC: { place: 1, kills: 0 }, SCRD: { place: 3, kills: 0 },
};
const M3 = {
  SCRA: { place: 1, kills: 0 }, SCRB: { place: 3, kills: 1 },
  SCRC: { place: 4, kills: 1 }, SCRD: { place: 2, kills: 0 },
};

function matchPoints(plan, kill, place) {
  const out = {};
  for (const t of TAGS) {
    const r = plan[t];
    out[t] = Math.max(0, r.kills * kill + (place[r.place] || 0) + (r.adj || 0));
  }
  return out;
}
function tbKey(r, tb) {
  if (tb === 'wins') return -r.wins;
  if (tb === 'placement_points') return -r.placementPoints;
  if (tb === 'finish_points') return -r.finishPoints;
  return r.lastPlacement || 1e6;
}
function expectedRows() {
  const acc = {};
  for (const t of TAGS) {
    acc[t] = { tag: t, name: NAMES[t], matches: 0, wins: 0, kills: 0,
               placementPoints: 0, finishPoints: 0, points: 0, lastPlacement: null };
  }
  for (const pm of published) {
    for (const t of TAGS) {
      const r = pm.plan[t];
      const a = acc[t];
      a.matches += 1; a.kills += r.kills;
      if (r.place === 1) a.wins += 1;
      a.placementPoints += PLACE[r.place] || 0;
      a.finishPoints += r.kills * KILL;
      a.points += pm.pointsByTag[t];
      a.lastPlacement = r.place;
    }
  }
  const rows = TAGS.map((t) => acc[t]);
  rows.sort((a, b) => {
    let d = a.points - b.points;
    if (d) return -d;
    for (const tb of TB) { d = tbKey(a, tb) - tbKey(b, tb); if (d) return d; }
    return 0;
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
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
  console.log('\n[fixtures: 4 squads, 1 group]');
  const queue = async (qs) => (await GET('/api/admin/registrations' + (qs || ''))).d;
  const setStatus = (tid, status) => POST(
    `/api/admin/registrations/${tid}/status`, { status, note: '' }, H);
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
  const squad = (tag, capUid, phone) => ({
    teamName: NAMES[tag], teamTag: tag, guildName: 'E2E Guild',
    capIgn: tag + '_CAP', capUid: capUid, capEmail: tag.toLowerCase() + '@demo.invalid',
    capPhone: phone, capDiscord: tag.toLowerCase(),
    roster: JSON.stringify([
      { slot: 'P1', role: 'IGL / Captain', ign: tag + '_CAP', uid: capUid },
      { slot: 'P2', role: 'Starter', ign: tag + 'P2', uid: String(Number(capUid) + 1) },
      { slot: 'P3', role: 'Starter', ign: tag + 'P3', uid: String(Number(capUid) + 2) },
      { slot: 'P4', role: 'Starter', ign: tag + 'P4', uid: String(Number(capUid) + 3) },
    ]),
  });
  /* the seeded demo fills the default 32 slots - make room for the fixtures */
  const setLim = await POST('/api/admin/settings', { slot_limit: 40 }, H);
  check('slot limit raised for the fixture squads', setLim.s === 200, setLim.s);
  const byTag = {};
  let allMounted = true;
  for (let i = 0; i < TAGS.length; i++) {
    const f = await registerTeam(squad(TAGS[i], '6067' + String(i + 1).padStart(2, '0') + '001',
      String(9755000100 + i)));
    if (!f) { allMounted = false; continue; }
    byTag[TAGS[i]] = f.id;
    const st = await setStatus(f.id, 'approved');
    if (st.s !== 200) allMounted = false;
  }
  check('4 fixture squads registered + approved', allMounted && TAGS.every((t) => byTag[t]),
    JSON.stringify(byTag));
  const g = await POST('/api/admin/groups', { name: GROUP, size: 8 }, H);
  const gid = g.s === 200 ? g.d.groupId
    : (await GET('/api/admin/matches')).d.groups.find((x) => x.name === GROUP).id;
  for (const t of TAGS) {
    const r = await POST(`/api/admin/groups/${gid}/assign`, { teamId: byTag[t] }, H);
    if (r.s !== 200) check('assign ' + t, false, r.s + ' ' + ((r.d || {}).error || ''));
  }
  check('group ready', !!gid, gid);

  const rules0 = await GET('/api/admin/scoring-rules');
  check('rules API returns the defaults', rules0.s === 200 &&
    rules0.d.rules.kill_points === 1 &&
    rules0.d.rules.placement['4'] === 4 &&
    rules0.d.rules.tiebreakers.join(',') === 'wins,placement_points,finish_points,last_placement',
    JSON.stringify(rules0.d));

  /* retract the seed's published demo match so the overall table is ours */
  const seedPub = ((await GET('/api/admin/matches')).d.matches || [])
    .filter((m) => m.status === 'published');
  for (const m of seedPub) {
    await POST(`/api/admin/matches/${m.id}/unpublish`, {}, H);
  }
  const empty = (await GET('/api/live/state')).d.overallPublished || [];
  check('overall table starts empty (seed match retracted)', empty.length === 0, empty.length);

  /* ---------- surface comparators ---------- */
  async function verifySurfaces(label) {
    const exp = expectedRows();
    const live = (await GET('/api/live/state')).d.overallPublished || [];
    const apiOk = live.length === exp.length && exp.every((e, i) => {
      const a = live[i];
      return a.rank === e.rank && a.teamTag === e.tag && a.matches === e.matches &&
        a.wins === e.wins && a.kills === e.kills &&
        a.placementPoints === e.placementPoints &&
        a.finishPoints === e.finishPoints && a.points === e.points &&
        (a.lastPlacement || null) === e.lastPlacement;
    });
    check(label + ': /api/live/state matches the independent table', apiOk,
      JSON.stringify(live.map((a) => [a.teamTag, a.rank, a.points, a.wins])) +
      ' vs ' + JSON.stringify(exp.map((e) => [e.tag, e.rank, e.points, e.wins])));

    await page.goto(BASE + '/results', { waitUntil: 'load' });
    await page.waitForFunction((n) =>
      document.querySelectorAll('#standings tr').length === n, exp.length,
      { timeout: 8000 }).catch(() => {});
    const dom = await page.$$eval('#standings tr', (trs) => trs.map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())));
    const domOk = dom.length === exp.length && exp.every((e, i) => {
      const c = dom[i] || [];
      return c[0] === String(e.rank) && c[1] === e.name && c[2] === GROUP &&
        c[3] === String(e.matches) && c[4] === String(e.wins) &&
        c[5] === String(e.kills) && c[6] === String(e.placementPoints) &&
        c[7] === String(e.points);
    });
    check(label + ': /results DOM matches the independent table', domOk, JSON.stringify(dom));

    const csvRes = await api.get(BASE + '/api/admin/export/standings.csv');
    const csvText = (await csvRes.text()).replace(/^\uFEFF/, '');
    const csv = parseCsv(csvText).filter((r) => r.length && r[0] !== 'rank');
    const csvOk = csv.length === exp.length && exp.every((e, i) => {
      const c = csv[i] || [];
      return c[0] === String(e.rank) && c[1] === byTag[e.tag] && c[2] === e.tag &&
        c[3] === e.name && c[4] === GROUP && c[5] === String(e.matches) &&
        c[6] === String(e.wins) && c[7] === String(e.points) &&
        c[8] === String(e.placementPoints) && c[9] === String(e.kills) &&
        c[10] === String(e.finishPoints) &&
        c[11] === String(e.lastPlacement) && c[12] === TB.join(',');
    });
    check(label + ': standings CSV matches the independent table', csvOk, JSON.stringify(csv));
  }

  async function verifyRecent(label) {
    const recent = (await GET('/api/live/state')).d.recentMatches || [];
    let ok = true; const bad = [];
    for (const pm of published) {
      const m = recent.find((x) => x.matchNumber === pm.mno);
      if (!m || m.results.length !== TAGS.length) { ok = false; bad.push('#' + pm.mno); continue; }
      for (let i = 0; i < TAGS.length; i++) {
        const tag = TAGS.find((t) => pm.plan[t].place === i + 1);
        const r = m.results[i];
        const want = [NAMES[tag], i + 1, pm.plan[tag].kills, pm.pointsByTag[tag]];
        const got = [r.teamName, r.placement, r.kills, r.points];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          ok = false; bad.push('#' + pm.mno + ' ' + tag + ' got ' + JSON.stringify(got));
        }
      }
    }
    check(label + ': public per-match result lists agree', ok, bad.join(' | ').slice(0, 240));
  }

  /* ---------- run a match end to end ---------- */
  async function runMatch(plan, mapName) {
    const prefix = 'M' + (published.length + 1);
    const created = await POST('/api/admin/matches', {
      group: GROUP, map: mapName, notes: 'E2E scoring ' + prefix,
      teamIds: TAGS.map((t) => byTag[t]),
    }, H);
    const mid = created.d.state.match.id;
    const mno = created.d.state.match.match_number;
    const st = await POST(`/api/admin/matches/${mid}/status`, { status: 'live' }, H);
    check(prefix + ': match live', st.s === 200 && st.d.state.match.status === 'live', st.s);
    for (const t of TAGS) {
      const r = plan[t];
      const pl = await POST(`/api/admin/match/${mid}/team/${byTag[t]}/placement`,
        { placement: r.place }, H);
      if (pl.s !== 200) check(prefix + ': place ' + t, false, pl.s + ' ' + ((pl.d || {}).error || ''));
      if (r.kills) {
        const k = await POST(`/api/admin/match/${mid}/team/${byTag[t]}/kills`,
          { delta: r.kills }, H);
        if (k.s !== 200) check(prefix + ': kills ' + t, false, k.s + ' ' + ((k.d || {}).error || ''));
      }
      if (r.adj) {
        const a = await POST(`/api/admin/match/${mid}/team/${byTag[t]}/adjust`,
          { delta: r.adj, reason: r.reason }, H);
        check(prefix + ': penalty logged on ' + t,
          a.s === 200 && /penalty/i.test(JSON.stringify(a.d.state.events || [])),
          a.s + ' ' + ((a.d || {}).error || ''));
      }
    }
    await POST(`/api/admin/matches/${mid}/status`, { status: 'awaiting_verification' }, H);
    const pub = await POST(`/api/admin/matches/${mid}/publish`, {}, H);
    check(prefix + ': published', pub.s === 200 && pub.d.state.match.status === 'published', pub.s);
    published.push({ mno, mid, plan, pointsByTag: matchPoints(plan, KILL, PLACE) });
    return mid;
  }

  /* ---------- phase A: defaults ---------- */
  console.log('\n[A: three matches under the default rules]');
  await runMatch(M1, 'Erangel');
  await verifySurfaces('A1');
  await runMatch(M2, 'Miramar');
  await verifySurfaces('A2');
  await runMatch(M3, 'Sanhok');
  await verifySurfaces('A3');
  await verifyRecent('A');
  const expA = expectedRows();
  check('tie at 21 points broken by wins (SCRC over SCRB)',
    expA.find((r) => r.tag === 'SCRC').rank === 1 &&
    expA.find((r) => r.tag === 'SCRB').rank === 2,
    JSON.stringify(expA.map((r) => [r.tag, r.points, r.wins, r.rank])));

  /* ---------- phase B: tie-breaker reorder ---------- */
  console.log('\n[B: tie-breakers reordered]');
  TB = ['finish_points', 'wins', 'placement_points', 'last_placement'];
  const saveRules = (kill, place, tb) => POST('/api/admin/scoring-rules', {
    kill_points: kill,
    placement: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8]
      .map((p) => [String(p), { points: place[p] || 0 }])),
    tiebreakers: tb,
  }, H);
  const bRes = await saveRules(KILL, PLACE, TB);
  check('tie-breaker save returns the new order', bRes.s === 200 &&
    bRes.d.rules.tiebreakers.join(',') === TB.join(','),
    JSON.stringify(bRes.d));
  await verifySurfaces('B');
  const expB = expectedRows();
  check('finish-points tie-breaker flipped the 21-point tie (SCRB first)',
    expB.find((r) => r.tag === 'SCRB').rank === 1 &&
    expB.find((r) => r.tag === 'SCRC').rank === 2,
    JSON.stringify(expB.map((r) => [r.tag, r.points, r.finishPoints, r.rank])));

  /* ---------- phase C: scoring values changed ---------- */
  console.log('\n[C: kill points and placement points changed]');
  KILL = 2; PLACE = { 1: 10, 2: 6, 3: 5, 4: 3 };
  const cRes = await saveRules(KILL, PLACE, TB);
  check('scoring save returns the new values', cRes.s === 200 &&
    cRes.d.rules.kill_points === 2 && cRes.d.rules.placement['4'] === 3,
    JSON.stringify(cRes.d));
  await verifySurfaces('C');
  await verifyRecent('C (published points stay as scored)');
  const expC = expectedRows();
  check('published totals are unchanged, components follow the new rules',
    expC.find((r) => r.tag === 'SCRB').points === 21 &&
    expC.find((r) => r.tag === 'SCRB').finishPoints === 12 &&
    expC.find((r) => r.tag === 'SCRB').placementPoints === 14,
    JSON.stringify(expC.map((r) => [r.tag, r.points, r.finishPoints, r.placementPoints])));

  /* new match scored under the new rules, checked on the live-inclusive table */
  const m4 = await runMatch({
    SCRA: { place: 1, kills: 1 }, SCRB: { place: 2, kills: 0 },
    SCRC: { place: 3, kills: 0 }, SCRD: { place: 4, kills: 0 },
  }, 'Vikendi');
  const m4state = (await GET('/api/admin/matches/' + m4)).d.state;
  const m4pts = m4state.teams.map((t) => [t.teamTag, t.points]);
  check('live match scores under the new rules (12/6/5/3)', JSON.stringify(m4pts.sort()) ===
    JSON.stringify([['SCRA', 12], ['SCRB', 6], ['SCRC', 5], ['SCRD', 3]].sort()),
    JSON.stringify(m4pts));
  const overall = (await GET('/api/live/state')).d.overall || [];
  const liveTotals = {};
  overall.forEach((r) => { liveTotals[r.teamTag] = r.points; });
  check('live-inclusive overall adds the new match (31/27/26/18)',
    liveTotals.SCRA === 31 && liveTotals.SCRB === 27 &&
    liveTotals.SCRC === 26 && liveTotals.SCRD === 18,
    JSON.stringify(liveTotals));
  await POST(`/api/admin/matches/${m4}/unpublish`, {}, H);
  await POST(`/api/admin/matches/${m4}/reset`, {}, H);
  const del = await POST(`/api/admin/matches/${m4}`, { delete: true }, H);
  check('extra match cleaned up', del.s === 200, del.s);
  published.pop();                            // the extra match is gone again
  await verifySurfaces('C after cleanup');

  /* ---------- rules form reflects the change ---------- */
  console.log('\n[rules editor]');
  await page.goto(BASE + '/admin/matches', { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const el = document.getElementById('killPoints');
    return el && el.value !== '';
  }, null, { timeout: 8000 }).catch(() => {});
  const formVals = await page.evaluate(() => {
    const p4 = document.querySelector('#placementRow input[data-pos="4"]');
    return { kill: document.getElementById('killPoints').value, p4: p4 && p4.value };
  });
  check('rules form shows the new scoring', formVals.kill === '2' && formVals.p4 === '3',
    JSON.stringify(formVals));
  await page.screenshot({ path: path.join(SHOTS, 'admin-rules-1440.png'), fullPage: true });
  await page.goto(BASE + '/results', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, 'results-standings-1440.png'), fullPage: true });
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`\n== scoring: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
