#!/usr/bin/env node
/* Admin FLOW sidebar — e2e stage.
   Drives a controlled tournament state on the stage server (temp DB only,
   never the real registrations DB) built with real admin API calls, then
   verifies on every admin page at 1920 / 1440 / 1024 / 390:
     - presence on admin pages only (public pages + admin-login stay clean)
     - NEXT card text/href follows real actions (review -> groups -> matches
       -> room -> start -> live -> verify)
     - step states: current / done / attention / blocked (+hover reason),
       blocked links still open and raise the warning banner on the target
     - #queue / #groups landings activate the matching tab and flash
     - LIVE chip + match-day-only phase expansion + tab dot while live
     - drawer / pin / icon rail / reload restore, desk STANDINGS tab never
       overlaps, one drawer at a time, publish bar never covered
     - AUTO grid columns refuse pinning with a toast (fixed columns pin fine)
     - keyboard: Alt+W, Escape, focus traps; a11y labels + ordered lists
     - phone: floating button + bottom sheet
   Screenshots: live chip, pinned, rail, drawer, bottom sheet.
   Usage: node tests/e2e/flow-sidebar.js [baseUrl]   (default :8090)
   Env:   VERIFY_ADMIN_USER / VERIFY_ADMIN_PASSWORD */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:8090';
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
  const shot = (n) => path.join(SHOTS, n);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const api = ctx.request;
  const errors = [];
  // /teams asks for the public list; 404 is the documented "listing off"
  // answer when the public_teams setting is 0 (pre-existing behavior)
  const KNOWN_OFF = '/api/public/approved';
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location();
    const url = loc && loc.url ? loc.url : '';
    if (url.indexOf(KNOWN_OFF) !== -1) return;
    errors.push('console: ' + m.text() + (url ? ' @ ' + url : ''));
  });
  page.on('response', (r) => {
    if (r.status() === 404 && r.url().indexOf(KNOWN_OFF) === -1) {
      errors.push('http404: ' + r.url());
    }
  });

  const js = (r) => r.json().catch(() => null);
  const GET = async (p) => { const r = await api.get(BASE + p); return { s: r.status(), d: await js(r) }; };
  const POST = async (p, body, headers) => {
    const r = await api.post(BASE + p, { data: body || {},
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
    return { s: r.status(), d: await js(r) };
  };
  const flowData = () => page.evaluate(() => (window.AF ? window.AF._state().data : null));
  const nextText = () => page.evaluate(() => {
    const t = document.querySelector('#afNext .af-next-t'); return t ? t.textContent : '';
  });
  const waitNext = async (sub, label) => {
    try {
      await page.waitForFunction((s) => {
        const t = document.querySelector('#afNext .af-next-t');
        return t && t.textContent.indexOf(s) !== -1;
      }, sub, { timeout: 9000 });
      check(label, true);
    } catch (e) { check(label, false, await nextText()); }
  };
  const ensureOpen = async () => {
    const st = await page.evaluate(() => window.AF._state());
    if (st.open || st.mode === 'pinned') return;   // pinned nav is visible
    await page.click('#afTab');
    await page.waitForTimeout(380);
  };
  const clearFlowKeys = () => page.evaluate(() => {
    Object.keys(localStorage).forEach((k) => {
      if (k.indexOf('bgmi.flow') === 0) localStorage.removeItem(k);
    });
  });
  const activeIn = (sel) => page.evaluate((s) => {
    const host = document.querySelector(s);
    return !!(host && host.contains(document.activeElement));
  }, sel);

  /* ---------- login + csrf ---------- */
  console.log('\n[setup]');
  const tok = await api.get(BASE + '/api/csrf').then(js);
  const login = await api.post(BASE + '/api/admin/login', {
    data: { username: ADMIN_USER, password: ADMIN_PASS },
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok.token || '' },
  });
  check('admin login', login.status() === 200, login.status());
  const me = await GET('/api/admin/me');
  const csrf = me.d && me.d.csrf;
  const H = { 'X-Admin-CSRF': csrf };
  check('session + csrf available', me.s === 200 && !!csrf);

  /* ---------- badge + payload shape (state as seeded) ---------- */
  console.log('\n[payload]');
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  await page.waitForTimeout(1300);
  const d0 = await flowData();
  check('flow payload arrives', !!(d0 && d0.ok));
  const pre = await page.evaluate(() => ({
    demo: window.AF._state().data.demo,
    badge: !!document.querySelector('.af-demo'),
    badgeText: (document.querySelector('.af-demo') || {}).textContent || null,
  }));
  check('DEMO DATA badge matches the demo flag', pre.demo === pre.badge,
    JSON.stringify(pre));
  if (pre.badge) check('badge reads DEMO DATA', pre.badgeText === 'DEMO DATA', pre.badgeText);
  const raw = JSON.stringify(d0);
  check('payload carries no contact fields or UIDs',
    raw.indexOf('@') === -1 && !/"(phone|email|uid|password)"/i.test(raw),
    raw.slice(0, 80));
  check('16 steps, announcements hidden',
    Object.keys(d0.steps).length === 16 && !d0.steps.announce &&
    d0.hidden.indexOf('announce') !== -1,
    Object.keys(d0.steps).join(','));

  /* ---------- presence on every admin page at 4 viewports ---------- */
  console.log('\n[presence matrix]');
  await clearFlowKeys();
  const ADMIN_PAGES = ['/admin', '/admin/matches', '/admin/control',
    '/admin/overlays', '/admin/caster'];
  for (const vw of [1920, 1440, 1024, 390]) {
    await page.setViewportSize({ width: vw, height: 900 });
    for (const p of ADMIN_PAGES) {
      await page.goto(BASE + p, { waitUntil: 'load' });
      await page.waitForTimeout(700);
      const r = await page.evaluate(() => ({
        af: !!window.AF,
        tab: !!document.getElementById('afTab') && !document.getElementById('afTab').hidden,
        fab: !!document.getElementById('afFab') && !document.getElementById('afFab').hidden,
        cur: !!document.querySelector(
          'nav[aria-label="Tournament workflow"] a[aria-current="page"]'),
        next: (document.querySelector('#afNext .af-next-t') || {}).textContent || '',
      }));
      const wantTab = vw >= 1024;
      check('FLOW present on ' + p + ' @' + vw, r.af && (wantTab ? r.tab : r.fab) &&
        r.next.length > 5, JSON.stringify(r));
      check('page marker on ' + p + ' @' + vw, r.cur, JSON.stringify(r));
    }
  }

  /* ---------- absence on public pages ---------- */
  console.log('\n[public pages]');
  for (const p of ['/', '/teams', '/live', '/status']) {
    const resp = await page.goto(BASE + p, { waitUntil: 'load' });
    await page.waitForTimeout(350);
    const r = await page.evaluate(() => ({
      af: !!window.AF, tab: !!document.getElementById('afTab'),
      root: !!document.getElementById('afRoot'),
    }));
    const st = resp ? resp.status() : 0;
    check('no FLOW on ' + p + (st === 200 ? '' : ' (skipped ' + st + ')'),
      st === 200 ? (!r.af && !r.tab && !r.root) : true, JSON.stringify(r));
  }
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const lgResp = await anonPage.goto(BASE + '/admin-login.html', { waitUntil: 'load' });
  await anonPage.waitForTimeout(500);
  const lgState = await anonPage.evaluate(() => ({
    af: !!window.AF, tab: !!document.getElementById('afTab'),
    path: location.pathname,
  }));
  check('admin-login.html ships no FLOW component (logged out)',
    lgResp.status() === 200 && lgState.path === '/admin-login.html' &&
    !lgState.af && !lgState.tab, JSON.stringify(lgState));
  await anon.close();

  /* ---------- purge -> empty state; blocked handoff; landings ---------- */
  console.log('\n[empty state]');
  const pr = await POST('/api/admin/purge', { confirm: 'PURGE' }, H);
  check('purge accepted', pr.s === 200 && pr.d && pr.d.ok, JSON.stringify(pr).slice(0, 90));
  // the room note is event content: purge keeps settings, so reset it to get
  // back to the pre-release state this stage needs
  await POST('/api/admin/settings', { schedule_note: '' }, H);
  await page.setViewportSize({ width: 1440, height: 900 });
  await clearFlowKeys();
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  await page.waitForTimeout(1300);
  const de = await flowData();
  check('empty: current = decide', de && de.current === 'decide', de && de.current);
  check('empty: badge gone after purge',
    await page.evaluate(() => !document.querySelector('.af-demo')));
  await ensureOpen();
  const dom0 = await page.evaluate(() => {
    const q = (k) => document.querySelector('#afDrawer a[data-step="' + k + '"]');
    const dec = q('decide'); const chk = q('checkin');
    return {
      decCls: dec.className, decAria: dec.getAttribute('aria-current'),
      decTag: (dec.querySelector('.af-tag') || {}).textContent,
      chkCls: chk.className, chkTitle: chk.title,
      next: document.querySelector('#afNext .af-next-t').textContent,
      nextHref: document.querySelector('#afNext .af-next-a').getAttribute('href'),
    };
  });
  check('decide is the current step', /af-step--current/.test(dom0.decCls) &&
    dom0.decAria === 'page', dom0.decCls + ' aria=' + dom0.decAria);
  check('current step tagged "now"', dom0.decTag === 'now', dom0.decTag);
  check('checkin blocked, hover reason present',
    /af-step--blocked/.test(dom0.chkCls) &&
    /Blocked . Create matches first/.test(dom0.chkTitle), dom0.chkTitle);
  check('NEXT explains the empty state', /Waiting for registrations/.test(dom0.next), dom0.next);
  check('NEXT link points at the queue', dom0.nextHref === '/admin#queue', dom0.nextHref);

  await page.click('#afDrawer a[data-step="checkin"]');
  await page.waitForTimeout(1100);
  check('blocked link still lands on its target',
    new URL(page.url()).pathname === '/admin/matches', page.url());
  const ban = await page.evaluate(() => {
    const b = document.querySelector('.af-banner'); return b ? b.textContent : null;
  });
  check('warning banner explains the block', !!ban && ban.indexOf('Create matches first') !== -1, ban);
  await page.keyboard.press('Escape');     // close the auto-opened drawer first
  await page.waitForTimeout(350);
  await page.screenshot({ path: shot('flow-sidebar-banner.png') });
  await page.click('.af-banner button');
  await page.waitForTimeout(150);
  check('banner dismisses',
    await page.evaluate(() => !document.querySelector('.af-banner')));

  console.log('\n[hash landings]');
  await page.goto(BASE + '/admin#queue', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const landQ = await page.evaluate(() => ({
    tab: !document.getElementById('tabQueue').classList.contains('hidden'),
    flash: !!document.querySelector('.af-flash'),
  }));
  check('#queue activates the queue tab', landQ.tab, JSON.stringify(landQ));
  check('#queue flashes its target', landQ.flash, JSON.stringify(landQ));
  await page.goto(BASE + '/admin#groups', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const landG = await page.evaluate(() => ({
    tab: !document.getElementById('tabGroups').classList.contains('hidden'),
    anchor: !!document.getElementById('groups'),
  }));
  check('#groups activates the groups tab', landG.tab && landG.anchor, JSON.stringify(landG));

  /* ---------- registrations -> NEXT movements ---------- */
  console.log('\n[registrations drive NEXT]');
  const pad = (n, w) => String(n).padStart(w, '0');
  const teamForm = (i, phone) => {
    const tag = 'FLW' + pad(i, 2);
    const uid = '808' + pad(i, 3) + '0';
    const roster = [1, 2, 3, 4].map((p) => ({
      slot: 'P' + p, role: p === 1 ? 'IGL / Captain' : 'Starter',
      ign: tag + '_P' + p, uid: uid + p,
    }));
    return { teamName: 'Flow Test ' + tag, teamTag: tag, guildName: 'Flow Guild',
      capIgn: tag + '_P1', capUid: uid + '1',
      capEmail: tag.toLowerCase() + '@example.com', capPhone: phone,
      capDiscord: tag.toLowerCase(), roster: JSON.stringify(roster) };
  };
  const register = async (form) => {
    const t = await api.get(BASE + '/api/csrf').then(js);
    const r = await api.post(BASE + '/api/register', {
      form, headers: { 'X-CSRF-Token': t.token || '' } });
    const d = await js(r);
    return { s: r.status(), id: d && (d.teamId || d.team_id) };
  };
  const r1 = await register(teamForm(1, '9822200001'));
  const r2 = await register(teamForm(2, '9822200002'));
  const r3 = await register(teamForm(3, '9822200001'));   // duplicate phone
  check('three registrations accepted',
    [r1, r2, r3].every((r) => r.s === 201 && r.id),
    [r1.s, r2.s, r3.s].join(','));
  await page.evaluate(() => window.AF.refresh());
  await waitNext('3 registrations awaiting review', 'NEXT: review pending count');
  const dR = await flowData();
  check('review is the current step', dR.current === 'review', dR.current);
  check('decide flagged for the duplicate',
    await page.evaluate(() => !!document.querySelector(
      '#afDrawer a[data-step="decide"].af-step--attention')));

  const setStatus = (tid, status, note) => POST(
    `/api/admin/registrations/${tid}/status`, { status: status, note: note || '' }, H);
  await setStatus(r1.id, 'approved');
  await setStatus(r2.id, 'approved');
  await setStatus(r3.id, 'rejected', 'duplicate phone');
  await page.evaluate(() => window.AF.refresh());
  await waitNext('Create groups for the approved teams', 'NEXT: groups after approvals');
  const dA = await flowData();
  check('decide complete and clean after the sweep',
    dA.steps.decide.done === true && dA.steps.decide.attention === false,
    JSON.stringify({ done: dA.steps.decide.done, att: dA.steps.decide.attention }));

  /* ---------- groups + match -> NEXT movements ---------- */
  console.log('\n[setup drives NEXT]');
  const g = await POST('/api/admin/groups', { name: 'Flow A', size: 16 }, H);
  const gid = g.d && (g.d.groupId || g.d.id);
  check('group created', g.s === 200 && !!gid, JSON.stringify(g).slice(0, 90));
  await POST(`/api/admin/groups/${gid}/assign`, { teamId: r1.id }, H);
  await POST(`/api/admin/groups/${gid}/assign`, { teamId: r2.id }, H);
  await page.evaluate(() => window.AF.refresh());
  await waitNext('Create the match schedule', 'NEXT: matches after the draw');

  const created = await POST('/api/admin/matches', {
    group: 'Flow A', map: 'Erangel', notes: 'flow e2e',
    teamIds: [r1.id, r2.id] }, H);
  const mid = created.d && created.d.state && created.d.state.match &&
    created.d.state.match.id;
  check('match created with both squads', created.s === 200 && !!mid, created.s);
  await page.evaluate(() => window.AF.refresh());
  await waitNext('Release the room details', 'NEXT: room release after scheduling');

  await POST('/api/admin/settings',
    { schedule_note: 'Room 88 / pass flow' }, H);
  await page.evaluate(() => window.AF.refresh());
  await waitNext('Start Match 1', 'NEXT: start prompt after room release');
  const nxHref = await page.evaluate(() =>
    document.querySelector('#afNext .af-next-a').getAttribute('href'));
  check('NEXT opens the desk with the match',
    nxHref === '/admin/control?match=' + mid, nxHref);
  await ensureOpen();                      // the NEXT card lives in the nav
  await page.click('#afNext .af-next-a');
  try {
    await page.waitForFunction((m) => {
      const sel = document.getElementById('matchPick');
      return sel && sel.value === String(m);
    }, mid, { timeout: 9000 });
    check('desk opens with Match 1 selected',
      new URL(page.url()).pathname === '/admin/control', page.url());
  } catch (e) { check('desk opens with Match 1 selected', false, page.url()); }

  /* ---------- live -> verify/publish ---------- */
  console.log('\n[live flow]');
  const st1 = await POST(`/api/admin/matches/${mid}/status`, { status: 'live' }, H);
  check('match started', st1.s === 200, st1.s);
  await page.evaluate(() => window.AF.refresh());
  try {
    await page.waitForFunction(() => {
      const c = document.getElementById('afLive');
      return c && !c.hidden;
    }, null, { timeout: 9000 });
    check('LIVE chip appears', true);
  } catch (e) { check('LIVE chip appears', false); }
  const liveDom = await page.evaluate(() => ({
    chip: document.getElementById('afLive').textContent,
    dot: !document.getElementById('afTabDot').hidden,
    phases: [...document.querySelectorAll('#afPhases section.af-phase')].map((s) => ({
      live: s.classList.contains('af-phase--live'),
      open: !s.querySelector('ol').hidden,
    })),
    next: document.querySelector('#afNext .af-next-t').textContent,
  }));
  check('chip names the live match', /LIVE . Match 1/.test(liveDom.chip), liveDom.chip);
  check('tab dot shown while live', liveDom.dot);
  check('only match-day stays expanded while live',
    liveDom.phases.filter((p) => p.live).length === 1 &&
    liveDom.phases.every((p) => p.live ? p.open : !p.open),
    JSON.stringify(liveDom.phases));
  check('NEXT points at scoring', /Match 1 is live/.test(liveDom.next), liveDom.next);
  const dL = await flowData();
  check('current moves to score while live', dL.current === 'score', dL.current);
  await ensureOpen();
  await page.screenshot({ path: shot('flow-sidebar-live-1440.png') });

  const st2 = await POST(`/api/admin/matches/${mid}/status`,
    { status: 'awaiting_verification' }, H);
  check('match ended to verify', st2.s === 200, st2.s);
  await page.evaluate(() => window.AF.refresh());
  // wait for the refreshed payload, not just the shared "Match 1" wording
  let pubReady = true;
  try {
    await page.waitForFunction(() => {
      const d = window.AF._state().data;
      return d && d.current === 'publish';
    }, null, { timeout: 9000 });
  } catch (e) { pubReady = false; }
  check('current = publish', pubReady, pubReady ? undefined : await nextText());
  await waitNext('Match 1', 'NEXT: verify & publish after the match');
  const pub = await page.evaluate(() => {
    const a = document.querySelector('#afDrawer a[data-step="publish"]');
    return { cls: a.className, aria: a.getAttribute('aria-current'),
      chip: document.getElementById('afLive').hidden };
  });
  check('publish is the current step', /af-step--current/.test(pub.cls) &&
    (pub.aria === 'page' || pub.aria === 'step'), pub.cls + ' aria=' + pub.aria);
  check('LIVE chip gone after the match', pub.chip);

  /* ---------- control desk layouts ---------- */
  console.log('\n[desk layouts]');
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(BASE + '/admin/control', { waitUntil: 'load' });
  await page.waitForTimeout(1700);
  if (await page.evaluate(() => window.AF._state().open)) {   // tabs only exist closed
    await page.keyboard.press('Escape');
    await page.waitForTimeout(320);
  }
  const colsBefore = await page.evaluate(() =>
    getComputedStyle(document.getElementById('squadGrid'))
      .gridTemplateColumns.split(' ').filter(Boolean).length);
  const tabs = await page.evaluate(() => {
    const t = document.getElementById('afTab').getBoundingClientRect();
    const d = document.getElementById('drawerTab');
    return { tabTop: Math.round(t.top),
      deskBottom: d.hidden ? null : Math.round(d.getBoundingClientRect().bottom),
      deskHidden: d.hidden };
  });
  check('FLOW tab stacks under the STANDINGS tab',
    tabs.deskHidden || tabs.tabTop >= tabs.deskBottom - 1, JSON.stringify(tabs));
  await ensureOpen();
  await page.click('#afPinBtn');
  await page.waitForTimeout(900);
  const pin = await page.evaluate(() => ({
    pinned: document.body.classList.contains('af-pinned'),
    cols: getComputedStyle(document.getElementById('squadGrid'))
      .gridTemplateColumns.split(' ').filter(Boolean).length,
    hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check('pin docks the sidebar at 1920', pin.pinned);
  check('pinning keeps the chosen grid columns', pin.cols === colsBefore,
    pin.cols + ' vs ' + colsBefore);
  check('pinned mode adds no horizontal scroll', !pin.hscroll);
  await page.screenshot({ path: shot('flow-sidebar-pinned-1920.png') });
  await page.click('#afCollapse');
  await page.waitForTimeout(400);
  check('collapse switches to the icon rail',
    await page.evaluate(() => document.body.classList.contains('af-rail')));
  await page.screenshot({ path: shot('flow-sidebar-rail-1920.png') });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1800);
  const restored = await page.evaluate(() => ({
    pinned: document.body.classList.contains('af-pinned'),
    rail: document.body.classList.contains('af-rail'),
  }));
  check('pinned + collapsed restored after reload',
    restored.pinned && restored.rail, JSON.stringify(restored));
  await page.click('#afPinBtn');
  await page.waitForTimeout(450);
  const unpin = await page.evaluate(() => ({
    mode: window.AF._state().mode, open: window.AF._state().open }));
  check('unpin returns to an open drawer',
    unpin.mode === 'drawer' && unpin.open, JSON.stringify(unpin));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  const barZ = await page.evaluate(() => {
    const bar = document.querySelector('.bc-publish-bar');
    if (!bar || bar.hidden) return 'no bar';
    const r = bar.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(r.left + 40),
      Math.round(r.top + r.height / 2));
    return bar.contains(el) ? true : (el ? String(el.className) : 'null');
  });
  check('FLOW drawer never covers the verify/publish bar', barZ === true,
    JSON.stringify(barZ));

  // AUTO columns: a pin that would drop the count is refused with a toast
  // (clear flow keys first: a stored rail only shifts the grid 76px and
  //  would legitimately allow the pin)
  await clearFlowKeys();
  await page.evaluate(() => localStorage.setItem('bgmi.desk.cols', 'auto'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2400);
  await ensureOpen();
  await page.click('#afPinBtn');
  await page.waitForTimeout(700);
  const auto = await page.evaluate(() => ({
    mode: window.AF._state().mode,
    pinned: document.body.classList.contains('af-pinned'),
    toast: document.getElementById('afToast').hidden
      ? null : document.getElementById('afToast').textContent,
  }));
  check('AUTO columns: a shrinking pin is refused with a toast',
    auto.mode === 'drawer' && !auto.pinned && /would drop/.test(auto.toast || ''),
    JSON.stringify(auto));
  check('refusal leaves the desk in its drawer layout', auto.mode === 'drawer');

  await page.evaluate(() => localStorage.setItem('bgmi.desk.cols', '4'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2200);
  await ensureOpen();
  await page.click('#afPinBtn');
  await page.waitForTimeout(700);
  const pin1440 = await page.evaluate(() => ({
    pinned: document.body.classList.contains('af-pinned'),
    mode: window.AF._state().mode,
  }));
  check('fixed columns pin fine at 1440',
    pin1440.pinned && pin1440.mode === 'pinned', JSON.stringify(pin1440));
  await page.click('#afPinBtn');     // unpin -> drawer opens
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // one drawer at a time (desk STANDINGS vs FLOW)
  await page.evaluate(() => document.getElementById('drawerTab').click());
  await page.waitForTimeout(400);
  check('desk STANDINGS drawer opens',
    await page.evaluate(() => document.getElementById('sideDrawer')
      .classList.contains('bc-drawer--open')));
  await page.evaluate(() => document.getElementById('afTab').click());
  await page.waitForTimeout(400);
  const od1 = await page.evaluate(() => ({
    flow: window.AF._state().open,
    desk: document.getElementById('sideDrawer').classList.contains('bc-drawer--open'),
  }));
  check('opening FLOW closes the desk drawer', od1.flow && !od1.desk, JSON.stringify(od1));
  await page.evaluate(() => document.getElementById('drawerTab').click());
  await page.waitForTimeout(400);
  const od2 = await page.evaluate(() => ({
    flow: window.AF._state().open,
    desk: document.getElementById('sideDrawer').classList.contains('bc-drawer--open'),
  }));
  check('opening STANDINGS closes FLOW', !od2.flow && od2.desk, JSON.stringify(od2));
  await page.evaluate(() => { const c = document.getElementById('drawerClose'); if (c) c.click(); });

  /* ---------- keyboard + a11y on /admin ---------- */
  console.log('\n[keyboard & a11y]');
  await page.setViewportSize({ width: 1440, height: 900 });
  await clearFlowKeys();
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const a11y = await page.evaluate(() => ({
    nav: !!document.querySelector('nav[aria-label="Tournament workflow"]'),
    ol: document.querySelectorAll('#afDrawer nav ol.af-steps').length,
    lis: document.querySelectorAll('#afDrawer nav ol.af-steps li').length,
  }));
  check('nav is labelled for screen readers', a11y.nav);
  check('steps render as ordered lists', a11y.ol === 4 && a11y.lis >= 16,
    JSON.stringify(a11y));

  await page.keyboard.press('Alt+w');
  await page.waitForTimeout(380);
  check('Alt+W opens the sidebar',
    await page.evaluate(() => window.AF._state().open));
  check('tab aria-expanded follows',
    await page.evaluate(() => document.getElementById('afTab')
      .getAttribute('aria-expanded') === 'true'));
  await page.screenshot({ path: shot('flow-sidebar-drawer-1440.png') });

  let trapped = true;
  for (let i = 0; i < 25 && trapped; i += 1) {
    await page.keyboard.press('Tab');
    trapped = await activeIn('#afDrawer');
  }
  check('Tab stays inside the open drawer', trapped);
  let trappedBack = true;
  for (let i = 0; i < 4 && trappedBack; i += 1) {
    await page.keyboard.press('Shift+Tab');
    trappedBack = await activeIn('#afDrawer');
  }
  check('Shift+Tab stays inside the drawer', trappedBack);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes the drawer',
    await page.evaluate(() => !window.AF._state().open));

  await page.keyboard.press('Alt+w');
  await page.waitForTimeout(380);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  check('open state restored after reload',
    await page.evaluate(() => window.AF._state().open));
  await page.keyboard.press('Escape');

  /* ---------- 1024 + phone ---------- */
  console.log('\n[1024 & phone]');
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const t1024 = await page.evaluate(() => ({
    tab: !document.getElementById('afTab').hidden,
    fab: !document.getElementById('afFab').hidden,
  }));
  check('1024px: drawer mode with the tab', t1024.tab && !t1024.fab,
    JSON.stringify(t1024));
  await ensureOpen();
  await page.click('#afPinBtn');
  await page.waitForTimeout(500);
  const pin1024 = await page.evaluate(() => ({
    mode: window.AF._state().mode,
    toast: document.getElementById('afToast').hidden
      ? null : document.getElementById('afToast').textContent,
  }));
  check('1024px: pin explains it needs 1280px+',
    pin1024.mode === 'drawer' && /1280/.test(pin1024.toast || ''),
    JSON.stringify(pin1024));
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const t390 = await page.evaluate(() => ({
    fab: !document.getElementById('afFab').hidden,
    tab: document.getElementById('afTab').hidden,
  }));
  check('390px: floating button instead of the tab', t390.fab && t390.tab,
    JSON.stringify(t390));
  await page.click('#afFab');
  await page.waitForTimeout(450);
  const sheet = await page.evaluate(() => ({
    open: document.getElementById('afSheet').classList.contains('af-open'),
    back: !document.getElementById('afSheetBack').hidden,
  }));
  check('390px: bottom sheet opens with a backdrop', sheet.open && sheet.back,
    JSON.stringify(sheet));
  let sheetTrapped = true;
  for (let i = 0; i < 15 && sheetTrapped; i += 1) {
    await page.keyboard.press('Tab');
    sheetTrapped = await activeIn('#afSheet');
  }
  check('390px: focus stays inside the sheet', sheetTrapped);
  await page.screenshot({ path: shot('flow-sidebar-sheet-390.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('390px: Escape closes the sheet',
    await page.evaluate(() => !document.getElementById('afSheet')
      .classList.contains('af-open')));

  /* ---------- console errors ---------- */
  check('no console/page errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  console.log(`\n== flow-sidebar: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
