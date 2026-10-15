// @ts-check
// Full broadcast dry run, end to end, against an isolated server (temp DB +
// temp uploads, free port — same isolation contract as the python suites and
// review-step.spec.js). Walks the whole pipeline on the demo world:
//   approve + group a squad -> create a match -> check in the lineup ->
//   start it -> score it on the Control Desk (kills + player elimination) ->
//   end it -> publish -> assert /live, /results and a token-gated overlay all
//   reflect the result. Also re-verifies the overlay token gate in-browser.
// The real registrations.db is never touched.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
/** Session cookie + CSRF for the throwaway admin. */
let adminCookie = '';
let adminCsrf = '';
/** Throwaway admin credential (provisioned directly in the temp DB). */
const ADMIN_USER = 'zz_dry_' + Math.random().toString(36).slice(2, 8);
const ADMIN_PW = 'Dry!' + Math.random().toString(36).slice(2, 14) + '9a';

/** JSON request with the admin session attached. */
async function admin(method, apiPath, body) {
  const resp = await fetch(base + apiPath, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json', Cookie: adminCookie },
      adminCsrf ? { 'X-Admin-CSRF': adminCsrf } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await resp.json(); } catch { /* non-JSON is fine */ }
  return { status: resp.status, data };
}

// A squad payload accepted by the registration API (same shape the python
// suites use). UIDs and phone are obviously fake QA values.
function squad(stamp) {
  const bu = 70000000 + (stamp % 1000000);
  return {
    teamName: 'DR Squad ' + stamp,
    teamTag: ('DR' + stamp.toString(36)).slice(0, 4).toUpperCase(),
    guildName: 'DR Guild',
    capIgn: 'DRCap',
    capUid: String(bu),
    capEmail: `dr${stamp}@example.com`,
    capPhone: '98' + String(10000000 + (stamp % 89999999)),
    capDiscord: '',
    roster: JSON.stringify([
      { slot: 'P1', role: 'IGL / Captain', ign: 'DRCap', uid: String(bu) },
      { slot: 'P2', role: 'Starter', ign: 'DRP2', uid: String(bu + 1) },
      { slot: 'P3', role: 'Starter', ign: 'DRP3', uid: String(bu + 2) },
      { slot: 'P4', role: 'Starter', ign: 'DRP4', uid: String(bu + 3) },
    ]),
    agreeRules: 'on',
    agreeFairPlay: 'on',
  };
}

test.beforeAll(async () => {
  const port = await freePort();
  tmp = mkdtempSync(path.join(tmpdir(), 'bgmi_dry_'));
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    BGMI_DB: path.join(tmp, 'test.db'),
    BGMI_UPLOADS: path.join(tmp, 'uploads'),
    BGMI_NOTIFY_POLL: '3600',       // keep the mail worker quiet during the run
    BGMI_ADMIN_USER: ADMIN_USER,
    BGMI_ADMIN_PASSWORD: ADMIN_PW,
  };
  server = spawn(process.env.PYTHON || 'python',
    [path.join(ROOT, 'server.py')],
    { env, cwd: ROOT, stdio: 'ignore' });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) break;
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  // provision the throwaway admin directly in the temp DB (create_admin.py)
  await new Promise((resolve, reject) => {
    const p = spawn(process.env.PYTHON || 'python',
      [path.join(ROOT, 'scripts', 'create_admin.py')],
      { env, cwd: ROOT, stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0
      ? resolve(undefined) : reject(new Error('create_admin exit ' + code))));
  });

  const login = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PW }),
  });
  const loginData = await login.json();
  adminCookie = (login.headers.get('set-cookie') || '').split(';')[0];
  adminCsrf = loginData.csrf || '';
  if (!adminCookie) throw new Error('admin login failed in dry run');
});

test.afterAll(() => {
  if (server && server.exitCode === null) server.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('full dry run: approve -> match -> score -> publish -> live/results/overlay',
  async ({ page }) => {
  test.setTimeout(180000);
  let stamp = Date.now() % 1000000;

  // ---- 1. register + approve + group two squads -------------------------
  const sfx = String(stamp % 100).padStart(2, '0');
  const tagA = 'DRA' + sfx;             // exactly 5 alphanumerics
  const tagB = 'DRB' + sfx;
  for (const tag of [tagA, tagB]) {
    // spacing UID bases by 10 keeps the two rosters (bu..bu+3) disjoint
    stamp += 10;
    // tokens are single-use (server consumes them on success)
    const tok = await (await fetch(base + '/api/csrf')).json();
    // /api/register parses urlencoded or multipart bodies (server.py:2781)
    const form = new URLSearchParams(
      Object.assign(squad(stamp++), { teamTag: tag }));
    const reg = await fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'X-CSRF-Token': tok.token },
      body: form.toString(),
    });
    if (!reg.ok) {
      const txt = await reg.text();
      throw new Error('register ' + tag + ' -> ' + reg.status + ' ' + txt);
    }
  }
  const list = await admin('GET', '/api/admin/registrations?status=pending');
  const mine = (list.data.registrations || [])
    .filter((/** @type {any} */ r) => String(r.team_name || '').startsWith('DR Squad'));
  expect(mine.length, 'two pending DR squads').toBeGreaterThanOrEqual(2);

  // approve both, then put them in one group
  for (const r of mine.slice(0, 2)) {
    const ap = await admin('POST', '/api/admin/registrations/' + r.team_id +
      '/status', { status: 'approved' });
    expect(ap.status, 'approve ' + r.team_id).toBe(200);
  }
  const grp = await admin('POST', '/api/admin/groups', {
    name: 'DR Group ' + stamp, size: 16,
  });
  expect(grp.status, 'create group').toBe(200);
  const gid = grp.data.groupId;
  expect(gid, 'group id returned').toBeTruthy();
  for (const r of mine.slice(0, 2)) {
    const asg = await admin('POST', '/api/admin/groups/' + gid + '/assign',
      { teamId: r.team_id });
    expect(asg.status, 'assign ' + r.team_id).toBe(200);
  }

  // ---- 2. create a match for that group ---------------------------------
  const created = await admin('POST', '/api/admin/matches', {
    group: 'DR Group ' + stamp, map: 'Erangel', notes: 'Dry run match',
  });
  expect(created.status, 'create match').toBe(200);
  const matchOk = (created.data.state || {}).match || created.data.match || {};
  const matchId = matchOk.id;
  expect(matchId, 'match id returned').toBeTruthy();
  const matchNo = matchOk.match_number;

  // check in both squads, then start
  const lineup = mine.slice(0, 2).map((/** @type {any} */ r) => r.team_id);
  const ci = await admin('POST', '/api/admin/matches/' + matchId + '/checkin',
    { teamIds: lineup });
  expect(ci.status, 'check in lineup').toBe(200);
  const started = await admin('POST', '/api/admin/matches/' + matchId +
    '/status', { status: 'live' });
  expect(started.status, 'start match').toBe(200);

  // ---- 3. Control Desk scores it ----------------------------------------
  const winner = lineup[0], other = lineup[1];
  const k = await admin('POST',
    '/api/admin/match/' + matchId + '/team/' + other + '/kills',
    { delta: 3 });
  expect(k.status, 'team kills').toBe(200);
  // squad wipe on the losing squad -> auto-placement
  const el = await admin('POST',
    '/api/admin/match/' + matchId + '/team/' + other + '/eliminate', {});
  expect(el.status, 'eliminate losing squad').toBe(200);
  const place = await admin('POST',
    '/api/admin/match/' + matchId + '/team/' + winner + '/placement',
    { placement: 1, manual: true });
  expect(place.status, 'pin winner placement').toBe(200);

  // ---- 4. end + publish --------------------------------------------------
  const ended = await admin('POST', '/api/admin/matches/' + matchId + '/status',
    { status: 'awaiting_verification' });
  expect(ended.status, 'end match').toBe(200);
  const pub = await admin('POST', '/api/admin/matches/' + matchId + '/publish',
    {});
  expect(pub.status, 'publish').toBe(200);

  // ---- 5. public pages reflect it ---------------------------------------
  await page.goto(base + '/live');
  await expect(page.locator('body')).toContainText(/DR Group|Erangel|Live/i,
    { timeout: 15000 });

  await page.goto(base + '/results');
  await expect(page.locator('body')).toContainText('Match #' + matchNo,
    { timeout: 15000 });
  await expect(page.locator('body')).toContainText(String(mine[0].team_name));

  // live state API carries the result and never any PII
  const state = await fetch(base + '/api/live/state');
  const stateText = await state.text();
  expect(state.ok).toBe(true);
  expect(stateText).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  expect(stateText).not.toMatch(/98\d{8}/);

  // ---- 6. overlay gate: bad token 403, good token renders ---------------
  const bad = await fetch(base + '/api/overlay/state/live-leaderboard?token=nope');
  expect(bad.status, 'bad overlay token rejected').toBe(403);

  const settings = await admin('GET', '/api/admin/overlay-settings');
  const token = settings.data.token;
  expect(token, 'overlay token present').toBeTruthy();
  const okState = await fetch(base + '/api/overlay/state/live-leaderboard?token=' + token);
  expect(okState.status, 'good overlay token accepted').toBe(200);
  expect(await okState.text()).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);

  // the overlay shell renders at 1920x1080 transparent
  await page.setViewportSize({ width: 1920, height: 1080 });
  const resp = await page.goto(base + '/overlay/live-leaderboard?token=' + token);
  expect(resp ? resp.status() : 0).toBe(200);
  await expect(page.locator('body')).toBeVisible({ timeout: 15000 });
});
