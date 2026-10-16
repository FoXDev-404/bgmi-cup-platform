#!/usr/bin/env node
/* Match Control Desk — operator layout stage.
   Builds a 16-squad live match on a freshly seeded demo server (temp DB only,
   never the real registrations DB) and drives /admin/control:
     - grid columns 1-6 + AUTO (4 is the default), restored across reloads
     - densities Comfortable / Compact / Tight — no overflow, no overlaps,
       one-line control rows, touch targets at 768px
     - standings modes Side / Bottom / Drawer / Hidden with undo always reachable
     - focus mode, zoom, collapse/expand all, reset, search, filters, sorting
     - every card button works at 4, 5 and 6 columns
     - live updates (timer + SSE/poll) keep working through layout changes
   Screenshots: 4-per-row at 1440 and 1920, 6-per-row at 1920.
   Usage: node tests/e2e/desk-layout.js [baseUrl]   (default http://127.0.0.1:8090)
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
  const browser = await chromium.launch();

  /* ---------- fixtures: login + 16 squads + live match (API) ---------- */
  console.log('\n[fixtures: 16 squads]');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const api = ctx.request;
  const js = (r) => r.json().catch(() => null);
  const GET = async (p) => { const r = await api.get(BASE + p); return { s: r.status(), d: await js(r) }; };
  const POST = async (p, body, headers) => {
    const r = await api.post(BASE + p, { data: body || {},
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
    return { s: r.status(), d: await js(r) };
  };

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
  const setLim = await POST('/api/admin/settings', { slot_limit: 48 }, H);
  check('slot limit raised for the fixture lobby', setLim.s === 200,
    setLim.s + ' ' + ((setLim.d || {}).error || ''));

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
  const pad = (n, w) => String(n).padStart(w, '0');
  const squad = (i) => {
    const tag = 'DL' + pad(i, 2);
    const uid = '707' + pad(i, 3) + '0';
    const roster = [1, 2, 3, 4].map((p) => ({
      slot: 'P' + p, role: p === 1 ? 'IGL / Captain' : 'Starter',
      ign: tag + '_P' + p, uid: uid + p,
    }));
    return {
      teamName: 'Desk Layout ' + tag, teamTag: tag, guildName: 'E2E Guild',
      capIgn: tag + '_P1', capUid: uid + '1', capEmail: tag.toLowerCase() + '@demo.invalid',
      capPhone: '98111' + pad(20000 + i * 11, 5), capDiscord: tag.toLowerCase(),
      roster: JSON.stringify(roster),
    };
  };

  const ids = [];
  for (let i = 1; i <= 16; i += 1) {
    const r = await registerTeam(squad(i));
    if (!r) { check('fixture squad ' + i + ' registered', false); break; }
    ids.push(r.id);
  }
  let approved = 0;
  for (const tid of ids) {
    if ((await setStatus(tid, 'approved')).s === 200) approved += 1;
  }
  check('16 fixture squads approved', approved === 16, approved);

  const gname = 'Desk16';
  const groupsAll = ((await GET('/api/admin/matches')).d.groups) || [];
  let gid = (groupsAll.find((x) => x.name === gname) || {}).id;
  if (gid) {
    check('fixture group available', true);
  } else {
    const g = await POST('/api/admin/groups', { name: gname, size: 20 }, H);
    gid = g.d && g.d.groupId;
    check('fixture group created', g.s === 200 && !!gid,
      g.s + ' ' + ((g.d || {}).error || ''));
  }
  let assigned = 0;
  for (const tid of ids) {
    if ((await POST(`/api/admin/groups/${gid}/assign`, { teamId: tid }, H)).s === 200) assigned += 1;
  }
  check('16 squads placed in the group', assigned === 16, assigned);

  const created = await POST('/api/admin/matches', {
    group: gname, map: 'Erangel', notes: 'desk layout stage', teamIds: ids,
  }, H);
  check('16-squad match created + checked in',
    created.s === 200 && ((created.d || {}).state || {}).teams
      && created.d.state.teams.length === 16, created.s);
  const mid = created.d.state.match.id;

  /* ---------- fresh desk at 1440 ---------- */
  console.log('\n[desk 1440: defaults]');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  await page.goto(BASE + '/admin/control', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.selectOption('#matchPick', String(mid));
  await page.waitForFunction(() =>
    document.querySelectorAll('#squadGrid .bc-squad').length === 16,
    null, { timeout: 8000 });
  await page.click('#startBtn');
  await page.waitForFunction(
    () => document.querySelector('#deskStatus').textContent.includes('LIVE'),
    null, { timeout: 8000 });
  await page.waitForTimeout(700);

  const gridCols = () => page.evaluate(() =>
    getComputedStyle(document.getElementById('squadGrid'))
      .gridTemplateColumns.split(' ').length);
  const pressed = (id, attr, value) => page.evaluate(([i, a, v]) => {
    const b = document.querySelector('#' + i + ' button[data-' + a + '="' + v + '"]');
    return b && b.getAttribute('aria-pressed') === 'true';
  }, [id, attr, value]);

  check('16 live squad cards on the desk',
    (await page.locator('#squadGrid .bc-squad').count()) === 16);
  check('fresh desk defaults to 4 columns (button + layout)',
    (await pressed('segGrid', 'cols', '4')) && (await gridCols()) === 4,
    await gridCols());
  const tops = await page.$$eval('#squadGrid .bc-squad',
    (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const row1 = tops.filter((t) => Math.abs(t - tops[0]) <= 2).length;
  check('default shows 4 cards on each row', row1 === 4, row1);
  check('default density is Compact at 4 columns',
    await pressed('segSize', 'size', 'compact'));
  check('default standings mode is Drawer at 4 columns',
    (await page.getAttribute('#deskBody', 'data-side')) === 'drawer' &&
    (await pressed('segSide', 'side', 'drawer')));
  check('drawer starts closed with the tab and floating undo visible',
    !(await page.evaluate(() =>
      document.getElementById('sideDrawer').classList.contains('bc-drawer--open'))) &&
    (await page.locator('#drawerTab').isVisible()) &&
    (await page.locator('#floatUndo').isVisible()));

  const meta = (await page.textContent('#deskMeta')).trim();
  check('desk info bar shows the group once', /^Group Desk16 · Erangel$/.test(meta), meta);
  const e2eOption = await page.$$eval('#matchPick option', (os) => {
    const o = os.find((x) => /Group [A-D]/.test(x.textContent) && !/Desk16/.test(x.textContent));
    return o ? o.textContent : '';
  });
  check('match picker shows the seeded group once',
    e2eOption === '' || !/Group Group/.test(e2eOption), e2eOption);
  await page.screenshot({ path: path.join(SHOTS, 'desk-grid-4col-1440.png'), fullPage: true });

  /* ---------- sort / filter / search ---------- */
  console.log('\n[desk: sort + filter]');
  await page.selectOption('#sortPick', 'points');
  await page.waitForTimeout(250);
  const pts = await page.$$eval('#squadGrid .bc-stat--pts b',
    (els) => els.map((e) => parseInt(e.textContent, 10) || 0));
  check('sort by points is descending', pts.every((v, i) => i === 0 || pts[i - 1] >= v),
    pts.join(','));

  const st0 = (await GET('/api/admin/matches/' + mid)).d.state;
  const odd = st0.teams[0].teamId;
  await POST(`/api/admin/match/${mid}/team/${odd}/placement`, { placement: 1 }, H);
  await page.waitForTimeout(400);
  await page.selectOption('#sortPick', 'placement');
  await page.waitForTimeout(250);
  const firstTeam = await page.getAttribute('#squadGrid .bc-squad', 'data-team');
  check('sort by placement floats the placed squad first',
    firstTeam === String(odd), firstTeam + ' vs ' + odd);
  await page.selectOption('#sortPick', 'slot');
  await page.waitForTimeout(250);

  await page.click('#segFilter button[data-filter="alive"]');
  await page.waitForTimeout(250);
  check('Alive-only keeps all 16 healthy squads',
    (await page.locator('#squadGrid .bc-squad').count()) === 16);
  await page.click('#segFilter button[data-filter="dead"]');
  await page.waitForTimeout(250);
  check('Eliminated hides every healthy squad, with a note',
    (await page.locator('#squadGrid .bc-squad').count()) === 0 &&
    (await page.locator('#squadGrid .bc-empty').isVisible()));
  await page.click('#segFilter button[data-filter="dead"]');
  await page.waitForTimeout(250);
  await page.fill('#cardSearch', 'DL0');
  await page.waitForTimeout(250);
  check('search by tag prefix narrows the grid',
    (await page.locator('#squadGrid .bc-squad').count()) === 9);
  await page.fill('#cardSearch', 'zzz-nothing');
  await page.waitForTimeout(250);
  check('search with no hits shows the empty note',
    (await page.locator('#squadGrid .bc-squad').count()) === 0 &&
    (await page.locator('#squadGrid .bc-empty').isVisible()));
  await page.fill('#cardSearch', '');
  await page.waitForTimeout(250);

  /* ---------- input values survive layout churn ---------- */
  await page.evaluate(() => {
    document.querySelector('#squadGrid .bc-dmg').value = '4242';
  });
  await page.click('#segFilter button[data-filter="alive"]');   // re-render
  await page.click('#segFilter button[data-filter="alive"]');   // clear -> re-render
  await page.waitForTimeout(200);
  const kept = await page.$eval('#squadGrid .bc-dmg', (e) => e.value);
  check('typed-but-uncommitted input value survives re-renders', kept === '4242', kept);
  await page.evaluate(() => { document.querySelector('#squadGrid .bc-dmg').value = '0'; });

  /* ---------- focus ---------- */
  console.log('\n[desk: focus, zoom, folding]');
  await page.click('#focusBtn');
  await page.waitForTimeout(150);
  check('focus hides the page header and shows the exit button',
    (await page.locator('body.bc-focus').count()) === 1 &&
    !(await page.locator('.bc-head').isVisible()) &&
    (await page.locator('#focusExit').isVisible()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Esc leaves focus', (await page.locator('body.bc-focus').count()) === 0);
  await page.click('#focusBtn');
  await page.waitForTimeout(150);
  await page.click('#focusExit');
  await page.waitForTimeout(150);
  check('exit button leaves focus', (await page.locator('body.bc-focus').count()) === 0);

  /* ---------- zoom ---------- */
  await page.click('#zoomIn');
  await page.click('#zoomOut');
  await page.click('#zoomOut');
  await page.waitForTimeout(150);
  const zoom = await page.evaluate(() => ({
    label: document.getElementById('zoomVal').textContent,
    card: getComputedStyle(document.querySelector('#squadGrid .bc-squad')).zoom,
  }));
  check('zoom A-/A+ steps and scales the cards (90%)',
    zoom.label === '90%' && String(zoom.card) === '0.9', JSON.stringify(zoom));
  await page.click('#zoomOut');
  await page.waitForTimeout(150);
  check('zoom clamps at 80% and disables the button',
    (await page.textContent('#zoomVal')) === '80%' &&
    (await page.locator('#zoomOut').isDisabled()));
  await page.click('#resetLayoutBtn');
  await page.waitForTimeout(200);
  check('reset layout restores the defaults (4 / Compact / Drawer / 100%)',
    (await pressed('segGrid', 'cols', '4')) && (await gridCols()) === 4 &&
    (await pressed('segSize', 'size', 'compact')) &&
    (await page.getAttribute('#deskBody', 'data-side')) === 'drawer' &&
    (await page.textContent('#zoomVal')) === '100%');

  /* ---------- collapse all / expand all ---------- */
  await page.click('#foldAllBtn');
  await page.waitForTimeout(200);
  check('collapse all folds every card and flips the label',
    (await page.locator('#squadGrid .bc-squad--folded').count()) === 16 &&
    (await page.textContent('#foldAllBtn')).trim() === 'Expand all');
  await page.click('#foldAllBtn');
  await page.waitForTimeout(200);
  check('expand all opens every card again',
    (await page.locator('#squadGrid .bc-squad--folded').count()) === 0 &&
    (await page.textContent('#foldAllBtn')).trim() === 'Collapse all');

  /* ---------- drawers + undo reachability ---------- */
  console.log('\n[desk: standings modes]');
  await page.click('#drawerTab');
  await page.waitForTimeout(250);
  check('standings tab slides the drawer open, undo inside',
    (await page.evaluate(() =>
      document.getElementById('sideDrawer').classList.contains('bc-drawer--open'))) &&
    (await page.locator('#drawerBack').isVisible()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Esc closes the drawer and the floating undo returns',
    !(await page.evaluate(() =>
      document.getElementById('sideDrawer').classList.contains('bc-drawer--open'))) &&
    (await page.locator('#floatUndo').isVisible()));
  await page.click('#segSide button[data-side="bottom"]');
  await page.waitForTimeout(250);
  check('bottom mode shows the strip with standings, log and undo',
    (await page.locator('#sideBottom').isVisible()) &&
    (await page.locator('#sideBottom #sideStandings').isVisible()) &&
    (await page.locator('#sideBottom #undoBtn').isVisible()) &&
    !(await page.locator('#floatUndo').isVisible()));
  await page.click('#segSide button[data-side="hidden"]');
  await page.waitForTimeout(250);
  check('hidden mode removes the panel but keeps the floating undo',
    !(await page.locator('#sideStandings').isVisible()) &&
    (await page.locator('#floatUndo').isVisible()));
  await page.click('#floatUndo');
  await page.waitForTimeout(700);
  check('floating undo applies the undo',
    (await page.locator('#sideEvents li.bc-ev-undone').count()) >= 1);
  await page.click('#segSide button[data-side="drawer"]');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  /* ---------- every button on a card, at 4 / 5 / 6 columns ---------- */
  console.log('\n[desk: card buttons at 4/5/6 columns]');
  const waitCard = (fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout: timeout || 8000 });
  /* the fixed navbar can sit over card controls during Playwright's scroll
     retries, and a render swap can detach a node between locator resolution
     and dispatch (the click would vanish) — dispatch on a verified-connected
     element, re-resolving when it slipped away */
  const clickEl = async (loc) => {
    for (let i = 0; i < 30; i++) {
      let sent = false;
      try {
        sent = await loc.evaluate((el) => {
          if (!el.isConnected) return false;
          el.click();
          return true;
        });
      } catch (e) { /* element replaced mid-resolve — retry */ }
      if (sent) return;
      await page.waitForTimeout(100);
    }
    throw new Error('clickEl: could not dispatch to a connected element');
  };

  /* click + wait; re-clicks once when the update never lands (rare lost
     request), then records pass/fail and lets the run continue */
  const tryStep = async (name, loc, verify, arg) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await clickEl(loc);
      try {
        await waitCard(verify, arg);
        check(name, true);
        return true;
      } catch (e) { await page.waitForTimeout(250); }
    }
    check(name, false, 'no update within 8s');
    return false;
  };
  for (const cols of [4, 5, 6]) {
    await page.click(`#segGrid button[data-cols="${cols}"]`);
    await page.waitForTimeout(150);
    check(`${cols} columns: grid shows ${cols} tracks`, (await gridCols()) === cols,
      await gridCols());
    const card = page.locator('#squadGrid .bc-squad').first();
    const tid = await card.getAttribute('data-team');
    /* park the card clear of the sticky nav / desk bars so clicks land */
    await card.evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -180);
    });
    await page.waitForTimeout(120);

    const killBefore = parseInt(await card.locator('.bc-kcount').first().textContent(), 10);
    await tryStep(`${cols} columns: kill + works`,
      card.locator('[data-field="kill"][data-value="1"]').first(),
      ([t, n]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        return c && parseInt(c.querySelector('.bc-kcount').textContent, 10) === n;
      }, [tid, killBefore + 1]);

    const dmgBefore = parseInt(await card.locator('.bc-dmg').first().inputValue(), 10);
    await tryStep(`${cols} columns: damage + works`,
      card.locator('[data-field="damage"][data-step="100"]').first(),
      ([t, n]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        return c && parseInt(c.querySelector('.bc-dmg').value, 10) === n;
      }, [tid, dmgBefore + 100]);

    await tryStep(`${cols} columns: status button works`,
      card.locator('[data-field="status"][data-value="knocked"]').first(),
      ([t]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        const b = c && c.querySelector('[data-field="status"][data-value="knocked"]');
        return b && b.getAttribute('aria-pressed') === 'true';
      }, [tid]);
    await clickEl(card.locator('[data-field="status"][data-value="alive"]').first());
    try {
      await waitCard(([t]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        const b = c && c.querySelector('[data-field="status"][data-value="alive"]');
        return b && b.getAttribute('aria-pressed') === 'true';
      }, [tid], 4000);
    } catch (e) { /* restoring the status is best-effort */ }

    const placeBefore = parseInt(await card.locator('.bc-place-input').inputValue() || '0', 10);
    await tryStep(`${cols} columns: PLACE stepper works`,
      card.locator('.bc-stepper--place button[data-step="1"]'),
      ([t, n]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        return c && (parseInt(c.querySelector('.bc-place-input').value, 10) || 0) === n;
      }, [tid, placeBefore + 1]);
    await tryStep(`${cols} columns: PLACE minus works`,
      card.locator('.bc-stepper--place button[data-step="-1"]'),
      ([t, n]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        return c && (parseInt(c.querySelector('.bc-place-input').value, 10) || 0) === n;
      }, [tid, placeBefore]);

    await tryStep(`${cols} columns: AUTO works`,
      card.locator('.bc-auto').first(),
      ([t]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        const b = c && c.querySelector('.bc-auto');
        return b && b.className.includes('bc-auto--on');
      }, [tid]);

    let menuOpen = false;
    const gear = card.locator('.bc-gear').first();
    for (let attempt = 0; attempt < 8 && !menuOpen; attempt++) {
      menuOpen = await gear.evaluate((el) => {
        if (!el.isConnected) return false;
        el.click();
        return !el.closest('.bc-squad').querySelector('.bc-menu')
          .classList.contains('hidden');
      }).catch(() => false);
      if (!menuOpen) await page.waitForTimeout(100);
    }
    check(`${cols} columns: gear menu opens`, menuOpen);
    await page.keyboard.press('Escape');
    const menuClosed = await card.locator('.bc-menu').first()
      .evaluate((m) => m.classList.contains('hidden'));
    check(`${cols} columns: Esc closes the gear menu`, menuClosed);

    await tryStep(`${cols} columns: chevron collapses the card`,
      card.locator('.bc-chev').first(),
      ([t]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        return c && c.classList.contains('bc-squad--folded');
      }, [tid]);
    await tryStep(`${cols} columns: chevron expands again`,
      card.locator('.bc-chev').first(),
      ([t]) => {
        const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
        return c && !c.classList.contains('bc-squad--folded');
      }, [tid]);
  }
  await page.click('#segGrid button[data-cols="6"]');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, 'desk-grid-6col-1440-check.png'),
    fullPage: true });

  /* ---------- persistence across reloads ---------- */
  console.log('\n[desk: persistence + live updates]');
  await page.click('#segSize button[data-size="tight"]');
  await page.waitForTimeout(150);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction((id) =>
    !!document.querySelector(`#matchPick option[value="${id}"]`),
    String(mid), { timeout: 8000 });
  await page.selectOption('#matchPick', String(mid));
  await page.waitForFunction(() =>
    document.querySelectorAll('#squadGrid .bc-squad').length === 16,
    null, { timeout: 8000 });
  check('grid choice (6) is restored after a reload',
    (await pressed('segGrid', 'cols', '6')) && (await gridCols()) === 6);
  check('density choice (Tight) is restored after a reload',
    await pressed('segSize', 'size', 'tight'));
  const stored = await page.evaluate(() => {
    try { return [localStorage.getItem('bgmi.desk.cols'),
      localStorage.getItem('bgmi.desk.size')]; } catch (e) { return null; }
  });
  check('choices are stored per operator in localStorage',
    !!stored && stored[0] === '6' && stored[1] === 'tight', JSON.stringify(stored));

  /* ---------- live updates keep working through layout changes ---------- */
  const t0 = await page.textContent('#deskTimer');
  await page.click('#segGrid button[data-cols="2"]');
  await page.click('#segSize button[data-size="comfortable"]');
  await page.click('#segSide button[data-side="bottom"]');
  await page.click('#segSide button[data-side="drawer"]');
  await page.keyboard.press('Escape');
  await page.click('#zoomIn');
  await page.click('#foldAllBtn');
  await page.click('#foldAllBtn');
  await page.click('#focusBtn');
  await page.click('#focusExit');
  const stl = (await GET('/api/admin/matches/' + mid)).d.state;
  const bumpTid = stl.teams[1].teamId;
  const bumpBefore = stl.teams[1].kills;
  const bump = await POST(`/api/admin/match/${mid}/team/${bumpTid}/kills`, { delta: 1 }, H);
  check('API finish bump accepted while controls churn', bump.s === 200, bump.s);
  await page.click('#segGrid button[data-cols="4"]');
  await page.waitForFunction(([t, n]) => {
    const c = document.querySelector(`.bc-squad[data-team="${t}"]`);
    return c && parseInt(c.querySelector('.bc-squad-stats .bc-stat b').textContent, 10) === n;
  }, [String(bumpTid), bumpBefore + 1], { timeout: 8000 });
  check('live update lands while layout controls are used', true);
  await page.waitForTimeout(2200);
  const t1 = await page.textContent('#deskTimer');
  check('match timer keeps ticking through layout changes',
    t0 !== t1 && /^\d\d:\d\d$/.test(t1.trim()), t0 + ' -> ' + t1);
  await page.click('#resetLayoutBtn');
  await page.waitForTimeout(250);

  /* ---------- 1920 screenshots ---------- */
  console.log('\n[desk 1920: screenshots]');
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.click('#segGrid button[data-cols="4"]');
  await page.waitForTimeout(250);
  check('1920: 4 per row', (await gridCols()) === 4);
  await page.screenshot({ path: path.join(SHOTS, 'desk-grid-4col-1920.png'), fullPage: true });
  await page.click('#segGrid button[data-cols="6"]');
  await page.waitForTimeout(250);
  check('1920: 6 per row', (await gridCols()) === 6);
  await page.screenshot({ path: path.join(SHOTS, 'desk-grid-6col-1920.png'), fullPage: true });

  /* ---------- viewport matrix: columns + density sanity ---------- */
  console.log('\n[matrix: 1920 / 1440 / 1024 / 768]');
  const sweep = async (label) => {
    const bad = await page.evaluate(() => {
      const out = [];
      const grid = document.getElementById('squadGrid');
      if (document.documentElement.scrollWidth > window.innerWidth + 1) {
        out.push('page overflows horizontally');
      }
      const cards = [...grid.querySelectorAll('.bc-squad')];
      cards.forEach((c, i) => {
        if (c.scrollWidth > c.clientWidth + 1) out.push('card ' + i + ' content overflows');
      });
      const rs = cards.map((c) => c.getBoundingClientRect());
      for (let i = 0; i < rs.length; i += 1) {
        for (let j = i + 1; j < rs.length; j += 1) {
          const w = Math.min(rs[i].right, rs[j].right) - Math.max(rs[i].left, rs[j].left);
          const h = Math.min(rs[i].bottom, rs[j].bottom) - Math.max(rs[i].top, rs[j].top);
          if (w > 1 && h > 1) out.push('cards ' + i + '/' + j + ' overlap');
        }
      }
      grid.querySelectorAll('.bc-ctl').forEach((ctl, i) => {
        const r = ctl.getBoundingClientRect();
        const kids = [...ctl.children].map((k) => k.getBoundingClientRect());
        const lines = new Set(kids.map(
          (k) => Math.round(k.top + k.height / 2))).size;
        if (lines > 1) out.push('control row ' + i + ' wraps');
        kids.forEach((k) => {
          if (k.width === 0 && k.height === 0) return; /* hidden child */
          if (k.right > r.right + 1 || k.left < r.left - 1) {
            out.push('control row ' + i + ' overflows');
          }
        });
      });
      grid.querySelectorAll('.bc-player').forEach((p, i) => {
        const r = p.getBoundingClientRect();
        [...p.children].forEach((k) => {
          const kr = k.getBoundingClientRect();
          if (kr.width === 0 && kr.height === 0) return; /* hidden child */
          if (kr.right > r.right + 1 || kr.left < r.left - 1) {
            out.push('player row ' + i + ' overflows');
          }
        });
      });
      return out;
    });
    check(label + ': no overflow, no overlaps, one-line control rows',
      bad.length === 0, bad.slice(0, 4).join('; '));
  };

  for (const vw of [1920, 1440, 1024, 768]) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.waitForTimeout(250);
    for (const sel of ['1', '2', '3', '4', '5', '6']) {
      await page.click(`#segGrid button[data-cols="${sel}"]`);
      await page.waitForTimeout(120);
      const want = Math.min(Number(sel), vw <= 768 ? 2 : 6);
      check(`${vw}px: grid ${sel} => ${want} column(s)`, (await gridCols()) === want,
        await gridCols());
    }
    await page.click('#segGrid button[data-cols="auto"]');
    await page.waitForTimeout(150);
    const autoWant = await page.evaluate(() =>
      Math.min(6, Math.max(1, Math.floor(
        document.getElementById('squadGrid').clientWidth / 320))));
    const autoCap = vw <= 768 ? Math.min(autoWant, 2) : autoWant;
    check(`${vw}px: AUTO fits ~1 column per 320px (${autoCap})`, (await gridCols()) === autoCap,
      await gridCols());
    for (const size of ['comfortable', 'compact', 'tight']) {
      await page.click(`#segSize button[data-size="${size}"]`);
      for (const cols of ['6', '4']) {
        await page.click(`#segGrid button[data-cols="${cols}"]`);
        await page.waitForTimeout(150);
        await sweep(`${vw}px ${size} @${cols} cols`);
      }
    }
    await page.click('#segGrid button[data-cols="4"]');
    await page.click('#segSize button[data-size="compact"]');
    await page.waitForTimeout(150);
  }

  /* ---------- touch targets at 768 ---------- */
  await page.setViewportSize({ width: 768, height: 900 });
  await page.click('#segGrid button[data-cols="6"]');
  await page.waitForTimeout(250);
  const targets = await page.$$eval('#squadGrid .bc-squad .bc-st',
    (els) => els.slice(0, 12).map((e) => {
      const r = e.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }));
  check('768px is capped at 2 columns even when 6 is chosen', (await gridCols()) === 2,
    await gridCols());
  check('768px: status targets are >= 42px (44px spec)',
    targets.every((t) => t[0] >= 42 && t[1] >= 42), JSON.stringify(targets));

  /* ---------- publish bar flows below the cards, never floats over them ---------- */
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  const flow = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#squadGrid .bc-squad')];
    const bar = document.querySelector('.bc-publish-bar');
    const docTop = (r) => r.top + window.scrollY;
    const docBottom = (r) => r.bottom + window.scrollY;
    const lowest = Math.max(...cards.map((c) => docBottom(c.getBoundingClientRect())));
    return { pos: getComputedStyle(bar).position,
      gap: Math.round(docTop(bar.getBoundingClientRect()) - lowest),
      pad: getComputedStyle(document.getElementById('deskBody')).paddingBottom };
  });
  check('publish bar sits in flow below every card (never floats over teams)',
    (flow.pos === 'static' || flow.pos === 'relative') && flow.gap >= 0,
    JSON.stringify(flow));
  check('no publish-bar clearance padding is reserved',
    parseFloat(flow.pad || '0') === 0, JSON.stringify(flow));

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`\n== desk-layout: ${passed} passed, ${failed} failed ==`);
  if (fails.length) fails.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
