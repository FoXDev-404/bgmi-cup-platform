/* Stage 5 e2e — admin flows.
 *
 *   VERIFY_ADMIN_USER=... VERIFY_ADMIN_PASSWORD=... \
 *     node tests/e2e/admin-flows.js [base]          (default :8090)
 *
 * Logged-out gating (pages + every admin API), login (wrong password, the
 * per-account throttle on a throwaway name), session cookie flags, CSRF
 * rejection, queue counts/search/filter/sort/conflicts, status actions
 * (reject + note, needs_changes, waitlist, approve), team edit + audit
 * (PII never stored) + the team seeing it on /status, groups (create, dup,
 * only-approved, full, assign/unassign, auto preview = no writes, auto,
 * lock/unlock, printable sheet, CSV exports), slot limit block + override,
 * settings (slot limit validation, public teams toggle), typed-confirm purge
 * (with overlay token rotation) and logout (old cookie dies).
 *
 * ENDS WITH PURGE: every registration/match/overlay row is removed — reseed
 * before running later stages.
 */
'use strict';

const { chromium, request } = require('playwright');
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
  await page.addInitScript(() => {
    window.__printed = 0;
    window.print = function () { window.__printed += 1; };
  });
  const js = (r) => r.json().catch(() => null);
  const GET = async (p) => { const r = await api.get(BASE + p); return { s: r.status(), d: await js(r), h: r.headers() }; };
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

  /* ---------- 0. logged-out gating ---------- */
  console.log('\n[0. logged-out gating]');
  for (const p of ['/api/admin/me', '/api/admin/registrations', '/api/admin/audit',
    '/api/admin/groups', '/api/admin/notifications', '/api/admin/matches',
    '/api/admin/overlay-settings', '/api/admin/scoring-rules',
    '/api/admin/settings', '/api/admin/export/approved.csv']) {
    const r = await GET(p);
    check(`logged out GET ${p} -> 401`, r.s === 401, r.s);
  }
  const w0 = await POST('/api/admin/bulk-status', { teamIds: [], status: 'rejected' });
  check('logged out write -> 401', w0.s === 401, w0.s);
  for (const p of ['/admin', '/admin/control', '/admin/matches', '/admin/overlays',
    '/admin/caster']) {
    await page.goto(BASE + p, { waitUntil: 'load' });
    const form = await page.locator('#loginForm').isVisible().catch(() => false);
    check(`${p} signed out shows the login form`, form, page.url());
  }
  await page.screenshot({ path: path.join(SHOTS, 'admin-login-1440.png'),
    fullPage: true });

  /* ---------- 1. login / csrf ---------- */
  console.log('\n[1. login, throttle, csrf]');
  for (let i = 1; i <= 5; i++) {
    const r = await POST('/api/admin/login', { username: 'e2e-nobody', password: 'nope-' + i });
    if (i <= 5) check(`wrong login #${i} -> 401`, r.s === 401, r.s);
  }
  const throttled = await POST('/api/admin/login', { username: 'e2e-nobody', password: 'nope-6' });
  check('6th wrong attempt -> per-account throttle (429)',
    throttled.s === 429 && /Too many attempts/i.test((throttled.d || {}).error || ''),
    throttled.s + ' ' + ((throttled.d || {}).error || ''));
  const wrongReal = await POST('/api/admin/login', { username: ADMIN_USER, password: 'definitely-wrong' });
  check('wrong password for the real account -> 401', wrongReal.s === 401, wrongReal.s);
  const good = await POST('/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
  check('correct login -> 200', good.s === 200 && good.d && good.d.ok === true, good.s);
  const cookie = (good.h && good.h['set-cookie']) || '';
  check('session cookie is HttpOnly + SameSite=Lax',
    /httponly/i.test(cookie) && /samesite=lax/i.test(cookie),
    cookie.replace(/bgmi_admin=[^;]+/, 'bgmi_admin=…').slice(0, 90));
  const me = await GET('/api/admin/me');
  check('GET /me works with the session', me.s === 200, me.s);
  const csrf = me.d && me.d.csrf;
  const noCsrf = await POST('/api/admin/settings', { slot_limit: 16 });
  check('write without X-Admin-CSRF -> 403',
    noCsrf.s === 403 && /CSRF/i.test((noCsrf.d || {}).error || ''),
    noCsrf.s + ' ' + ((noCsrf.d || {}).error || ''));
  const badCsrf = await POST('/api/admin/settings', { slot_limit: 16 },
    { 'X-Admin-CSRF': 'not-the-token' });
  check('write with a wrong token -> 403',
    badCsrf.s === 403, badCsrf.s);
  const set14 = await POST('/api/admin/settings', { slot_limit: 14 }, { 'X-Admin-CSRF': csrf });
  check('write with the real token -> 200', set14.s === 200, set14.s);
  const raised = await POST('/api/admin/settings', { slot_limit: 40 }, { 'X-Admin-CSRF': csrf });
  check('slot limit raised for the fixture approvals', raised.s === 200, raised.s);

  /* ---------- 2. fixtures + duplicate warning + reject + /status ---------- */
  console.log('\n[2. fixtures, duplicate warning, reject with reason]');
  const queue = async (qs) => (await GET('/api/admin/registrations' + (qs || ''))).d;
  const setStatus = (tid, status, note, override) => POST(
    `/api/admin/registrations/${tid}/status`,
    { status, note: note || '', override: !!override }, { 'X-Admin-CSRF': csrf });
  const registerTeam = async (form) => {           // register CSRF is single-use
    const tok = await api.get(BASE + '/api/csrf').then(js);
    const r = await api.post(BASE + '/api/register', {
      form, headers: { 'X-CSRF-Token': tok.token || '' },
    });
    if (r.status() === 201) {
      const d = await js(r);
      return { id: d.teamId, code: d.regCode };
    }
    const q = await queue('?q=' + form.teamTag);   // stage-4 leftovers: reuse
    const t = (q.registrations || []).find((x) => x.team_tag === form.teamTag);
    return t ? { id: t.team_id, code: t.reg_code } : null;
  };
  const squad = (name, tag, capUid, phone, email, ign) => ({
    teamName: name, teamTag: tag, guildName: 'Status Guild',
    capIgn: ign, capUid: capUid, capEmail: email, capPhone: phone,
    capDiscord: tag.toLowerCase(),
    roster: JSON.stringify([
      { slot: 'P1', role: 'IGL / Captain', ign: ign, uid: capUid },
      { slot: 'P2', role: 'Starter', ign: tag + 'P2', uid: String(Number(capUid) + 1) },
      { slot: 'P3', role: 'Starter', ign: tag + 'P3', uid: String(Number(capUid) + 2) },
      { slot: 'P4', role: 'Starter', ign: tag + 'P4', uid: String(Number(capUid) + 3) }]),
  });
  const stta = await registerTeam(squad('Status Squad A', 'STTA', '606001001',
    '9811112222', 'stta@demo.invalid', 'STTACAP'));
  const sttb = await registerTeam(squad('Status Squad B', 'STTB', '606002001',
    '9833334444', 'sttb@demo.invalid', 'STTBCAP'));
  check('fixture teams STTA/STTB available', !!(stta && sttb),
    JSON.stringify([stta, sttb]));
  const sttaApprove = await setStatus(stta.id, 'approved', '');
  check('fixture STTA approved (idempotent)', sttaApprove.s === 200, sttaApprove.s);
  const cnfl = await registerTeam(squad('Status Squad A', 'CNFL', '606004001',
    '9811112222', 'cnfl@demo.invalid', 'CNFLCAP'));
  check('conflict squad registered (STTA name+phone on purpose)', !!cnfl,
    JSON.stringify(cnfl));
  let qd = await queue();
  check('queue reports counts + slot info',
    qd && qd.ok && qd.counts && qd.slot_limit === 40 && typeof qd.remaining === 'number',
    JSON.stringify(qd && qd.counts));
  const conflictKeys = Object.keys(qd.conflicts || {});
  check('duplicate phone/name flagged as a conflict',
    conflictKeys.includes(cnfl.id), JSON.stringify(conflictKeys));
  const rej = await POST(`/api/admin/registrations/${cnfl.id}/status`,
    { status: 'rejected', note: 'E2E reject reason: duplicate captain phone.' },
    { 'X-Admin-CSRF': csrf });
  check('reject with a reason -> ok', rej.s === 200 && rej.d.ok, rej.s);
  await page.goto(BASE + '/status', { waitUntil: 'load' });
  await page.fill('#regCode', cnfl.code);
  await page.fill('#hint', '9811112222');
  await page.click('#lookupBtn');
  await page.waitForTimeout(800);
  const badge = (await page.textContent('#resBadge')).trim();
  const note = (await page.textContent('#resNote')).trim();
  check('/status shows rejected + the admin reason',
    /rejected/i.test(badge) && note.includes('duplicate captain phone'),
    badge + ' | ' + note.slice(0, 50));

  /* ---------- 3. team edit + audit + /status ---------- */
  console.log('\n[3. team edit, audit, /status]');
  qd = await queue('?q=STTB');
  const sttbRow = (qd.registrations || [])[0];
  check('search finds STTB', !!sttbRow && sttbRow.team_tag === 'STTB',
    JSON.stringify((qd.registrations || []).length));
  const dupUid = await PUT(`/api/admin/registrations/${sttbRow.team_id}`,
    { capUid: '400000001' }, { 'X-Admin-CSRF': csrf });
  check('edit to an existing UID -> blocked',
    dupUid.s === 400 && /already on squad/.test((dupUid.d || {}).error || ''),
    dupUid.s + ' ' + ((dupUid.d || {}).error || ''));
  const dupTag = await PUT(`/api/admin/registrations/${sttbRow.team_id}`,
    { teamTag: 'HLEF' }, { 'X-Admin-CSRF': csrf });
  check('edit to an existing tag -> blocked',
    dupTag.s === 400 && /already belongs/.test((dupTag.d || {}).error || ''),
    dupTag.s + ' ' + ((dupTag.d || {}).error || ''));
  const edit = await PUT(`/api/admin/registrations/${sttbRow.team_id}`,
    { teamName: 'E2E Renamed Squad', capUid: '606003199' }, { 'X-Admin-CSRF': csrf });
  check('edit name + captain UID -> ok', edit.s === 200 && edit.d.ok,
    JSON.stringify(edit.d).slice(0, 80));
  const audit = (await GET('/api/admin/audit?teamId=' + sttbRow.team_id)).d;
  const rows = (audit && audit.audit) || [];
  const nameRow = rows.find((r) => r.field === 'team_name');
  const uidRow = rows.find((r) => r.field === 'cap_uid');
  check('audit log has old+new for the renamed team',
    nameRow && nameRow.old_value === 'Status Squad B' &&
    nameRow.new_value === 'E2E Renamed Squad',
    JSON.stringify(nameRow || {}).slice(0, 100));
  check('audit never stores the new UID (PII masked)',
    uidRow && uidRow.new_value === '(changed)' &&
    !JSON.stringify(rows).includes('606003199'),
    JSON.stringify(uidRow || {}).slice(0, 90));
  await page.goto(BASE + '/status', { waitUntil: 'load' });
  await page.fill('#regCode', sttbRow.reg_code);
  await page.fill('#hint', '9833334444');
  await page.click('#lookupBtn');
  await page.waitForTimeout(800);
  const newName = (await page.textContent('#resTeam')).trim();
  check('the team sees the rename on /status', newName === 'E2E Renamed Squad',
    newName);

  /* ---------- 4. groups ---------- */
  console.log('\n[4. groups]');
  const groups0 = (await GET('/api/admin/groups')).d;
  check('groups endpoint shape', groups0 && Array.isArray(groups0.groups) &&
    typeof groups0.locked === 'boolean' && Array.isArray(groups0.unassigned),
    JSON.stringify(groups0).slice(0, 70));
  const gz = await POST('/api/admin/groups', { name: 'Group Z', size: 2 },
    { 'X-Admin-CSRF': csrf });
  check('create Group Z', gz.s === 200 && gz.d.groupId > 0, gz.s);
  const gzDup = await POST('/api/admin/groups', { name: 'Group Z', size: 2 },
    { 'X-Admin-CSRF': csrf });
  check('duplicate group name -> 409', gzDup.s === 409, gzDup.s);
  const gzId = gz.d.groupId;
  const notApproved = await POST(`/api/admin/groups/${gzId}/assign`,
    { teamId: cnfl.id }, { 'X-Admin-CSRF': csrf });
  check('rejected team cannot be assigned -> 400',
    notApproved.s === 400 && /Only approved/.test((notApproved.d || {}).error || ''),
    notApproved.s + ' ' + ((notApproved.d || {}).error || ''));
  let qa = await queue('?q=STTA');
  const sttaRow = (qa.registrations || [])[0];
  const unassign = await POST('/api/admin/groups/0/assign',
    { teamId: sttaRow.team_id }, { 'X-Admin-CSRF': csrf });
  check('unassign (group 0) works', unassign.s === 200, unassign.s);
  const assign1 = await POST(`/api/admin/groups/${gzId}/assign`,
    { teamId: sttaRow.team_id }, { 'X-Admin-CSRF': csrf });
  check('assign STTA to Group Z', assign1.s === 200, assign1.s);
  const approvedList = (await queue('?status=approved')).registrations;
  const second = approvedList.find((r) => r.team_tag !== 'STTA');
  const third = approvedList.find((r) => r.team_tag !== 'STTA' &&
    r.team_id !== second.team_id);
  await POST('/api/admin/groups/0/assign', { teamId: second.team_id },
    { 'X-Admin-CSRF': csrf });
  const assign2 = await POST(`/api/admin/groups/${gzId}/assign`,
    { teamId: second.team_id }, { 'X-Admin-CSRF': csrf });
  check('assign a second approved team (Group Z now 2/2)', assign2.s === 200,
    assign2.s);
  await POST('/api/admin/groups/0/assign', { teamId: third.team_id },
    { 'X-Admin-CSRF': csrf });
  const full = await POST(`/api/admin/groups/${gzId}/assign`,
    { teamId: third.team_id }, { 'X-Admin-CSRF': csrf });
  check('assign to a full group -> 400', full.s === 400 &&
    /full/.test((full.d || {}).error || ''),
    full.s + ' ' + ((full.d || {}).error || ''));
  const gBefore = (await GET('/api/admin/groups')).d;
  const preview = await POST('/api/admin/groups/auto',
    { count: 4, size: 4, preview: true }, { 'X-Admin-CSRF': csrf });
  const gAfterPrev = (await GET('/api/admin/groups')).d;
  const stable = JSON.stringify(gBefore.groups.map((g) => g.teams)) ===
    JSON.stringify(gAfterPrev.groups.map((g) => g.teams));
  check('auto preview computes a plan and writes nothing',
    preview.s === 200 && preview.d.preview === true &&
    Array.isArray(preview.d.plan) && stable,
    'plan groups=' + ((preview.d && preview.d.plan) || []).length + ' stable=' + stable);
  const auto = await POST('/api/admin/groups/auto',
    { count: 4, size: 4 }, { 'X-Admin-CSRF': csrf });
  const gFinal = (await GET('/api/admin/groups')).d;
  const seated = gFinal.groups.reduce((n, g) => n + g.count, 0);
  check('auto-distribute seats every approved team',
    auto.s === 200 && seated === gFinal.approved,
    'seated=' + seated + ' approved=' + gFinal.approved);
  const lock = await POST('/api/admin/settings', { groups_locked: true },
    { 'X-Admin-CSRF': csrf });
  const lockedAssign = await POST(`/api/admin/groups/${gzId}/assign`,
    { teamId: third.team_id }, { 'X-Admin-CSRF': csrf });
  const lockedAuto = await POST('/api/admin/groups/auto',
    { count: 4, size: 4 }, { 'X-Admin-CSRF': csrf });
  check('locked groups reject assign + auto',
    lock.s === 200 && lockedAssign.s === 403 && lockedAuto.s === 403,
    lockedAssign.s + '/' + lockedAuto.s);
  await POST('/api/admin/settings', { groups_locked: false }, { 'X-Admin-CSRF': csrf });
  const unlockCheck = (await GET('/api/admin/settings')).d;
  check('groups unlocked again for later stages',
    unlockCheck.groups_locked === false);
  /* printable sheet (window.print stubbed) */
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('#tabBtnGroups');
  await page.waitForTimeout(400);
  await page.click('#printBtn');
  const printed = await page.evaluate(() => window.__printed);
  check('print sheet button calls window.print', printed === 1, printed);
  await page.click('#tabBtnQueue');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'admin-queue-1440.png'),
    fullPage: true });
  await page.fill('#searchInput', 'Status Squad A');
  await page.waitForTimeout(500);
  const filtered = await page.locator('body').innerText();
  check('queue search filters the table',
    filtered.includes('Status Squad A') && !filtered.includes('Hidden Leaf'),
    'screenshot next');
  await page.screenshot({ path: path.join(SHOTS, 'admin-queue-search-1440.png'),
    fullPage: true });
  /* CSV exports */
  for (const [csv, head] of [
    ['/api/admin/export/approved.csv', 'reg_code,team_id,team_name'],
    ['/api/admin/export/groups.csv', 'group,slot,reg_code'],
    ['/api/admin/export/standings.csv', 'rank,team_id,team_tag']]) {
    const r = await api.get(BASE + csv);
    const text = await r.text();
    const first = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
    check(`${csv} downloads as CSV with the expected header`,
      r.status() === 200 && /text\/csv/.test(r.headers()['content-type'] || '') &&
      first.startsWith(head), r.status() + ' | ' + first.slice(0, 60));
  }
  const approvedCsv = await (await api.get(
    BASE + '/api/admin/export/approved.csv')).text();
  check('approved export is the admin contact sheet (emails + approved team)',
    approvedCsv.includes('captain_email') && approvedCsv.includes('@') &&
    approvedCsv.includes('Status Squad A'));
  for (const csv of ['/api/admin/export/groups.csv',
    '/api/admin/export/standings.csv']) {
    const text = await (await api.get(BASE + csv)).text();
    check(`${csv} leaks no PII`,
      !text.includes('@') && !text.includes('9811112222') &&
      !text.includes('9833334444') && !text.includes('900013700'));
  }

  /* ---------- 5. queue filters + bulk ---------- */
  console.log('\n[5. queue filters + bulk]');
  qd = await queue('?status=pending');
  const pendCount = qd.registrations.length;
  check('status filter returns only pending',
    pendCount > 0 && qd.registrations.every((r) => r.status === 'pending'),
    pendCount);
  const qdName = await queue('?status=approved&sort=name');
  const names = qdName.registrations.map((r) => r.team_name.toLowerCase());
  const sorted = names.slice().sort();
  check('sort=name is alphabetical', JSON.stringify(names) === JSON.stringify(sorted));
  const qSearch = await queue('?q=606004001');
  check('search matches roster UIDs', qSearch.registrations.length === 1 &&
    qSearch.registrations[0].team_id === cnfl.id, qSearch.registrations.length);
  const sumCounts = Object.values(qd.counts).reduce((a, b) => a + b, 0);
  const allQueue = await queue();
  check('counts sum to the queue total',
    sumCounts === allQueue.registrations.length,
    sumCounts + ' vs ' + allQueue.registrations.length);
  /* the full seed carries no rejected rows, so build two for the bulk */
  const rjta = await registerTeam(squad('E2E Bulk Reject A', 'RJTA', '606005001',
    '9811155551', 'rjta@demo.invalid', 'RJTACAP'));
  const rjtb = await registerTeam(squad('E2E Bulk Reject B', 'RJTB', '606006001',
    '9811155552', 'rjtb@demo.invalid', 'RJTBCAP'));
  check('bulk fixture squads registered', !!(rjta && rjtb),
    JSON.stringify([rjta, rjtb]));
  await setStatus(rjta.id, 'rejected', 'E2E bulk target A.');
  await setStatus(rjtb.id, 'rejected', 'E2E bulk target B.');
  const bulk = await POST('/api/admin/bulk-status', {
    teamIds: [rjta.id, rjtb.id],
    status: 'waitlisted', note: 'E2E bulk waitlist.', override: false,
  }, { 'X-Admin-CSRF': csrf });
  check('bulk-status moves two teams to waitlisted',
    bulk.s === 200 && bulk.d.done.length === 2 && bulk.d.errors.length === 0,
    JSON.stringify(bulk.d).slice(0, 90));
  const bulkBad = await POST('/api/admin/bulk-status', {
    teamIds: ['CSM-BG-NOPE'], status: 'waitlisted',
  }, { 'X-Admin-CSRF': csrf });
  check('bulk-status reports per-team errors',
    bulkBad.s === 200 && bulkBad.d.errors.length === 1, JSON.stringify(bulkBad.d).slice(0, 90));

  /* ---------- 6. approval ladder + slot limit ---------- */
  console.log('\n[6. approvals + slot limit + override]');
  qd = await queue('?status=pending');
  const t = Object.fromEntries(qd.registrations.map((r) => [r.team_tag, r]));
  const nc = await setStatus(t['STTB'].team_id, 'needs_changes',
    'E2E: fix the captain UID and re-submit.');
  check('request changes (needs_changes) with a note', nc.s === 200, nc.s);
  const wl = await setStatus(t['STTB'].team_id, 'waitlisted', 'E2E waitlist.');
  check('waitlist action', wl.s === 200, wl.s);
  /* pin the limit to the current count so the next approval must trip it */
  const curApproved = (await queue()).counts.approved;
  await POST('/api/admin/settings', { slot_limit: curApproved },
    { 'X-Admin-CSRF': csrf });
  const blocked = await setStatus(t['STTB'].team_id, 'approved', '');
  check('approving beyond the limit -> slot-limit error',
    blocked.s === 400 && /Slot limit reached/.test((blocked.d || {}).error || ''),
    blocked.s + ' ' + ((blocked.d || {}).error || ''));
  const overridden = await setStatus(t['STTB'].team_id, 'approved', '', true);
  const counts17 = (await queue()).counts;
  check('override approves past the limit',
    overridden.s === 200 && counts17.approved === curApproved + 1,
    'approved=' + counts17.approved);
  const ncApprove = await setStatus(t['STTB'].team_id, 'rejected',
    'E2E closing check.');
  check('a further status change still applies (rejected again)',
    ncApprove.s === 200, ncApprove.s);
  /* headroom again for anything later */
  await POST('/api/admin/settings', { slot_limit: 40 },
    { 'X-Admin-CSRF': csrf });

  /* ---------- 7. settings ---------- */
  console.log('\n[7. settings]');
  const s0 = (await GET('/api/admin/settings')).d;
  const initialPublic = s0.public_teams;
  check('settings endpoint shape',
    s0 && s0.slot_limit >= 1 && typeof s0.public_teams === 'boolean' &&
    !!s0.notify, JSON.stringify(s0).slice(0, 90));
  const badLimit = await POST('/api/admin/settings', { slot_limit: 0 },
    { 'X-Admin-CSRF': csrf });
  check('slot_limit 0 -> 400', badLimit.s === 400, badLimit.s);
  const badTz = await POST('/api/admin/settings', { timezone: 'not a tz!' },
    { 'X-Admin-CSRF': csrf });
  check('weird timezone -> 400', badTz.s === 400, badTz.s);
  const on = await POST('/api/admin/settings', { public_teams: true },
    { 'X-Admin-CSRF': csrf });
  const feedOn = await GET('/api/public/approved');
  check('public teams toggle ON -> feed served',
    on.s === 200 && feedOn.s === 200 && Array.isArray(feedOn.d.teams),
    on.s + '/' + feedOn.s);
  const feedText = JSON.stringify(feedOn.d);
  check('public feed has no captain PII',
    !feedText.includes('@') && !feedText.includes('9811112222') &&
    !feedText.includes('900013700') && !/"uid"/.test(feedText));
  const off = await POST('/api/admin/settings', { public_teams: initialPublic },
    { 'X-Admin-CSRF': csrf });
  const feedOff = await GET('/api/public/approved');
  check('toggle restored to its initial state',
    off.s === 200 && feedOff.s === (initialPublic ? 200 : 404),
    'initial=' + initialPublic + ' status=' + feedOff.s);

  /* ---------- 8. purge ---------- */
  console.log('\n[8. typed-confirm purge]');
  const before = (await GET('/api/health')).d.count;
  const ov0 = (await GET('/api/admin/overlay-settings')).d;
  const matches0 = (await GET('/api/admin/matches')).d.matches.length;
  const live0 = (await GET('/api/live/state')).d;
  const liveMatches0 = (live0.matchHistory || live0.matches || []).length;
  const noConfirm = await POST('/api/admin/purge', { confirm: 'nope' },
    { 'X-Admin-CSRF': csrf });
  check('purge without the typed confirmation -> 400',
    noConfirm.s === 400 && /PURGE/.test((noConfirm.d || {}).error || ''),
    noConfirm.s);
  const purge = await POST('/api/admin/purge', { confirm: 'PURGE' },
    { 'X-Admin-CSRF': csrf });
  check('typed PURGE removes everything', purge.s === 200 &&
    purge.d.ok && purge.d.removed === before,
    purge.s + ' removed=' + (purge.d && purge.d.removed) + ' of ' + before);
  const after = (await GET('/api/health')).d.count;
  const qAfter = await queue();
  const matches1 = (await GET('/api/admin/matches')).d.matches.length;
  const live1 = (await GET('/api/live/state')).d;
  const ov1 = (await GET('/api/admin/overlay-settings')).d;
  check('registrations gone (health 0, counts 0)',
    after === 0 && qAfter.counts.approved === 0 &&
    qAfter.counts.pending === 0, after);
  check('matches + live state cleared',
    matches1 === 0 && (live1.matchHistory || live1.matches || []).length === 0 &&
    !live1.match && (live1.teams || []).length === 0,
    'matches ' + matches0 + '->' + matches1 + ', live ' + liveMatches0 +
    '->' + (live1.matchHistory || live1.matches || []).length);
  check('overlay token rotated by purge', ov1.token !== ov0.token);
  const oldTok = await api.get(`${BASE}/api/overlay/state/overall?token=${ov0.token}`);
  const newTok = await api.get(`${BASE}/api/overlay/state/overall?token=${ov1.token}`);
  check('old overlay token dead, new one works',
    oldTok.status() === 403 && newTok.status() === 200,
    oldTok.status() + '/' + newTok.status());
  const auditAll = (await GET('/api/admin/audit?limit=200')).d.audit;
  check('audit records the purge',
    auditAll.some((r) => r.action === 'purge_all'), auditAll.length);

  /* ---------- 9. logout ---------- */
  console.log('\n[9. logout]');
  const cookies = await ctx.cookies();
  const sessionCookie = cookies.find((c) => c.name === 'bgmi_admin');
  const logout = await POST('/api/admin/logout', {});
  check('logout -> 200', logout.s === 200, logout.s);
  const meAfter = await GET('/api/admin/me');
  check('session dies after logout', meAfter.s === 401, meAfter.s);
  if (sessionCookie) {
    const raw = await request.newContext({
      extraHTTPHeaders: { Cookie: `bgmi_admin=${sessionCookie.value}` },
    });
    const r = await raw.get(BASE + '/api/admin/me');
    check('the old cookie value alone stops working', r.status() === 401, r.status());
    await raw.dispose();
  } else {
    check('the old cookie value alone stops working', false, 'no cookie found');
  }
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  const formBack = await page.locator('#loginForm').isVisible().catch(() => false);
  check('/admin shows the login form again', formBack);

  console.log(`\n== admin: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
