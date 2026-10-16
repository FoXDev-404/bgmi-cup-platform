/* ===========================================================================
   FLOW — tournament workflow sidebar for the admin pages.

   One shared component injected by admin-flow.css + this file on every admin
   page: /admin, /admin/matches, /admin/control, /admin/overlays, /admin/caster.
   It never loads on public pages or the login gate.

   - Data: GET /api/admin/flow-status (admin-only, counts + states, no PII).
     Polled every 10s, refreshed right after any successful admin write
     (fetch hook), on tab focus, and on the custom 'af:refresh' event.
   - Modes: right-edge FLOW tab stacked under the desk's STANDINGS tab (drawer
     opens from the right); pinnable fixed left column on ≥1280px with an
     icon-rail collapse; floating FLOW button + bottom sheet below 1024px.
   - Every choice (open / pinned / collapsed / collapsed phases) persists in
     localStorage with try/catch; failures degrade to safe defaults.
   - Alt+W toggles the sidebar; Esc closes the drawer/sheet (not pinned).
   =========================================================================== */
(function (global) {
  'use strict';

  var POLL_MS = 10000;
  var PIN_MIN = 1280;
  var MOBILE_MQ = '(max-width: 1023px)';

  var KEY = {
    mode: 'bgmi.flow.mode',          // drawer | pinned
    open: 'bgmi.flow.open',          // 0 | 1
    rail: 'bgmi.flow.rail',          // 0 | 1 (pinned collapsed)
    phases: 'bgmi.flow.phases',      // JSON: collapsed phase names
    blocked: 'bgmi.flow.blocked'     // one-shot handoff for the warning banner
  };

  /* ---- steps + phases (labels only; states come from the server) --------- */
  var PHASES = [
    { name: 'registration', label: 'Registrations',
      steps: [
        { k: 'review', n: 1, label: 'Review registrations' },
        { k: 'decide', n: 2, label: 'Approve, reject or waitlist' }
      ] },
    { name: 'setup', label: 'Setup',
      steps: [
        { k: 'groups', n: 3, label: 'Create groups' },
        { k: 'assign', n: 4, label: 'Assign teams, lock groups' },
        { k: 'matches', n: 5, label: 'Create matches and schedule' },
        { k: 'overlays', n: 6, label: 'Overlay setup — tokens, OBS' },
        { k: 'caster', n: 7, label: 'Caster dashboard' }
      ] },
    { name: 'match-day', label: 'Match day',
      steps: [
        { k: 'checkin', n: 8, label: 'Open check-in' },
        { k: 'room', n: 9, label: 'Release room details' },
        { k: 'start', n: 10, label: 'Start match' },
        { k: 'score', n: 11, label: 'Score live' },
        { k: 'end', n: 12, label: 'End and review' },
        { k: 'publish', n: 13, label: 'Verify and publish' },
        { k: 'results', n: 14, label: 'Standings and results' }
      ] },
    { name: 'after-event', label: 'After the event',
      steps: [
        { k: 'export', n: 15, label: 'Export CSVs & group sheets' },
        { k: 'purge', n: 17, label: 'Purge all team data', danger: true }
      ] }
  ];
  var STEP_INDEX = {};
  PHASES.forEach(function (p) {
    p.steps.forEach(function (s) { s.phase = p.name; STEP_INDEX[s.k] = s; });
  });

  /* ---- which steps live on which page (for aria-current) ------------------ */
  var PAGE_STEPS = {
    '/admin': ['review', 'decide', 'groups', 'assign', 'room', 'export', 'purge'],
    '/admin/matches': ['matches', 'checkin'],
    '/admin/control': ['start', 'score', 'end', 'publish'],
    '/admin/overlays': ['overlays'],
    '/admin/caster': ['caster']
  };
  var HASH_PREF = {
    '#queue': ['review', 'decide'], '#groups': ['groups', 'assign'],
    '#settings': ['room', 'purge'], '#exports': ['export']
  };
  var PAGE_TABS = {          // /admin tab panels triggered from a hash link
    '#queue': 'tabBtnQueue', '#groups': 'tabBtnGroups',
    '#audit': 'tabBtnAudit', '#settings': 'tabBtnSettings'
  };

  /* ---- tiny helpers ------------------------------------------------------- */
  function lsGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try {
      if (value == null) global.localStorage.removeItem(key);
      else global.localStorage.setItem(key, value);
    } catch (e) { /* storage blocked — defaults apply */ }
  }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isMobile() { return global.matchMedia(MOBILE_MQ).matches; }

  /* ---- one-shot toast ----------------------------------------------------- */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('afToast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () { t.hidden = true; }, 4200);
  }

  /* =========================================================================
     DOM skeleton (built once, moved between shells per mode)
     ========================================================================= */
  var root, tabBtn, fab, back, drawer, sheet, sheetBack, pinWrap, nav,
      liveChip, nextBox, phasesBox, toastNode, bannerNode;

  function buildDom() {
    root = el('div', 'af-root');
    root.id = 'afRoot';

    tabBtn = el('button', 'af-tab');
    tabBtn.type = 'button';
    tabBtn.id = 'afTab';
    tabBtn.setAttribute('aria-expanded', 'false');
    tabBtn.setAttribute('aria-controls', 'afDrawer');
    tabBtn.innerHTML = '<span class="af-tab-live" id="afTabDot" hidden></span>FLOW';

    fab = el('button', 'af-fab');
    fab.type = 'button';
    fab.id = 'afFab';
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 'afSheet');
    fab.setAttribute('aria-label', 'Open the tournament workflow');
    fab.innerHTML = '<span class="af-tab-live" id="afFabDot" hidden></span>FLOW';

    back = el('div', 'af-back');
    back.id = 'afBack';
    back.hidden = true;

    drawer = el('div', 'af-drawer');
    drawer.id = 'afDrawer';
    drawer.hidden = true;
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Tournament workflow');

    sheetBack = el('div', 'af-sheet-back');
    sheetBack.id = 'afSheetBack';
    sheetBack.hidden = true;

    sheet = el('div', 'af-sheet');
    sheet.id = 'afSheet';
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Tournament workflow');

    pinWrap = el('aside', 'af-pin');
    pinWrap.id = 'afPinWrap';
    pinWrap.hidden = true;

    toastNode = el('div', 'af-toast');
    toastNode.id = 'afToast';
    toastNode.hidden = true;
    toastNode.setAttribute('role', 'status');

    nav = el('nav', 'af-panel');
    nav.setAttribute('aria-label', 'Tournament workflow');
    nav.innerHTML =
      '<header class="af-phead">' +
        '<span class="af-title">FLOW</span>' +
        '<span class="af-live" id="afLive" hidden></span>' +
        '<span class="af-phead-sp"></span>' +
        '<button type="button" class="af-iconbtn" id="afCollapse" hidden ' +
          'title="Collapse to the icon rail">&#171;</button>' +
        '<button type="button" class="af-iconbtn" id="afPinBtn" ' +
          'title="Pin as a fixed column">Pin</button>' +
        '<button type="button" class="af-iconbtn" id="afCloseBtn" ' +
          'aria-label="Close the tournament workflow" title="Close">&#215;</button>' +
      '</header>' +
      '<div class="af-next" id="afNext"></div>' +
      '<div class="af-phases" id="afPhases"></div>' +
      '<div class="af-utils">' +
        '<a class="af-util" href="/admin#audit">Audit log</a>' +
        '<a class="af-util" href="/admin#settings">Settings</a>' +
        '<a class="af-util" href="/live">Public live</a>' +
        '<button type="button" class="af-util" id="afLogout">Log out</button>' +
      '</div>';

    [tabBtn, fab, back, drawer, sheetBack, sheet, pinWrap, toastNode].forEach(
      function (n) { root.appendChild(n); });
    document.body.appendChild(root);

    liveChip = nav.querySelector('#afLive');
    nextBox = nav.querySelector('#afNext');
    phasesBox = nav.querySelector('#afPhases');

    bannerNode = null;   // created lazily from sessionStorage

    nav.querySelector('#afCloseBtn').addEventListener('click', closeFlow);
    nav.querySelector('#afPinBtn').addEventListener('click', togglePin);
    nav.querySelector('#afCollapse').addEventListener('click', toggleRail);
    nav.querySelector('#afLogout').addEventListener('click', logout);

    tabBtn.addEventListener('click', openFlow);
    fab.addEventListener('click', openFlow);
    back.addEventListener('click', closeFlow);
    sheetBack.addEventListener('click', closeFlow);
  }

  /* =========================================================================
     Modes: drawer | pinned | sheet
     ========================================================================= */
  var mode = 'drawer';
  var pinnedRequested = lsGet(KEY.mode) === 'pinned';
  var isOpen = false;

  /* the open flag also drives the desk-side demotion of the publish bar /
     undo float (body.af-flow-open, styled in admin-flow.css) */
  function setOpen(open) {
    isOpen = open;
    document.body.classList.toggle('af-flow-open', open);
  }
  var lastFocus = null;

  function mountNav(host) {
    if (nav.parentNode !== host) host.appendChild(nav);
  }

  function applyMode(force) {
    var wantPin = pinnedRequested && !isMobile() &&
      global.innerWidth >= PIN_MIN;
    var next = wantPin ? 'pinned'
      : (isMobile() ? 'sheet' : 'drawer');
    if (!force && next === mode) { syncModeChrome(); return; }
    if (next === 'pinned' && mode !== 'pinned') {
      var drop = pinWouldDrop();
      if (drop) {
        pinnedRequested = false;
        lsSet(KEY.mode, 'drawer');
        toast('Not enough room to pin — the card grid would drop from ' +
              drop.from + ' to ' + drop.to + ' columns. Kept the drawer ' +
              'instead.');
        next = 'drawer';
      } else {
        enterPinned();
      }
    }
    if (mode === 'pinned' && next !== 'pinned') {
      document.body.classList.remove('af-pinned', 'af-rail');
      pinWrap.hidden = true;
    }
    mode = next;
    syncModeChrome();
  }

  function syncModeChrome() {
    var pinned = mode === 'pinned';
    var rail = pinned && lsGet(KEY.rail) === '1';
    document.body.classList.toggle('af-pinned', pinned);
    document.body.classList.toggle('af-rail', rail);

    tabBtn.hidden = pinned || isMobile();
    fab.hidden = pinned || !isMobile();
    pinWrap.hidden = !pinned;
    nav.querySelector('#afCollapse').hidden = !pinned;
    nav.querySelector('#afPinBtn').hidden = false;
    nav.querySelector('#afPinBtn').textContent = pinned ? 'Unpin' : 'Pin';
    nav.querySelector('#afPinBtn').title = pinned
      ? 'Unpin — go back to the drawer' : 'Pin as a fixed column';

    if (pinned) {
      mountNav(pinWrap);
      drawer.hidden = true;
      sheet.hidden = true;
      back.hidden = true;
      sheetBack.hidden = true;
      setOpen(false);
      lsSet(KEY.open, '0');        // the drawer closed, so is no longer "open"
    } else if (mode === 'sheet') {
      mountNav(sheet);
      drawer.hidden = true;
    } else {
      mountNav(drawer);
      sheet.hidden = true;
    }
    layoutTab();
  }

  function openFlow() {
    if (mode === 'pinned') return;
    closeDeskDrawer();               // one drawer at a time
    lastFocus = document.activeElement;
    setOpen(true);
    lsSet(KEY.open, '1');
    if (mode === 'sheet') {
      sheet.hidden = false;
      sheetBack.hidden = false;
      requestAnimationFrame(function () { sheet.classList.add('af-open'); });
      fab.setAttribute('aria-expanded', 'true');
      focusFirst(sheet);
    } else {
      drawer.hidden = false;
      back.hidden = false;
      requestAnimationFrame(function () { drawer.classList.add('af-open'); });
      tabBtn.setAttribute('aria-expanded', 'true');
      tabBtn.hidden = true;
      focusFirst(drawer);
    }
  }

  function closeFlow() {
    if (!isOpen) return;
    setOpen(false);
    lsSet(KEY.open, '0');
    if (mode === 'sheet') {
      sheet.classList.remove('af-open');
      sheet.hidden = true;
      sheetBack.hidden = true;
      fab.setAttribute('aria-expanded', 'false');
    } else {
      drawer.classList.remove('af-open');
      drawer.hidden = true;
      back.hidden = true;
      tabBtn.setAttribute('aria-expanded', 'false');
      tabBtn.hidden = false;
    }
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (e) { /* detached */ }
    }
  }

  function focusFirst(host) {
    var list = host.querySelectorAll(
      'button, a[href], [tabindex]:not([tabindex="-1"])');
    for (var i = 0; i < list.length; i += 1) {
      if (!list[i].getClientRects().length) continue;   // display:none
      try { list[i].focus(); } catch (e) { /* ignore */ }
      return;
    }
  }

  function closeDeskDrawer() {
    var desk = document.getElementById('sideDrawer');
    if (desk && desk.classList.contains('bc-drawer--open')) {
      var x = document.getElementById('drawerClose');
      if (x) x.click();
    }
  }

  function togglePin() {
    pinnedRequested = !pinnedRequested;
    lsSet(KEY.mode, pinnedRequested ? 'pinned' : 'drawer');
    if (!pinnedRequested) {
      applyMode(true);
      openFlow();
      return;
    }
    if (isMobile() || global.innerWidth < PIN_MIN) {
      pinnedRequested = false;
      lsSet(KEY.mode, 'drawer');
      toast('Pinning needs a wider window — 1280px and up.');
      return;
    }
    applyMode(true);          // pre-checks the fit, then captures the grid
    layoutTab();
    global.setTimeout(deskPinGuard, 280);
  }

  /* On the control desk, pinning must never silently drop the card grid to
     fewer columns than the operator is looking at.  Explicit column picks
     keep their track count (cards just narrow), so only the "auto" setting —
     where the desk derives the count from width (floor(width/320)) and
     re-runs on any grid width change (its ResizeObserver) — can lose one.
     The fit is checked BEFORE applying the pin (pinWouldDrop, so a refusal
     leaves the desk untouched); the post-guard catches later shrinks. */
  function pinWouldDrop() {
    var g = document.getElementById('squadGrid');
    if (!g) return null;                                      // non-desk page
    if ((lsGet('bgmi.desk.cols') || '4') !== 'auto') return null;  // fixed
    var pan = g.closest ? g.closest('.pan') : null;
    if (!pan) return null;
    var shift = lsGet(KEY.rail) === '1' ? 76 : 312;   // pinned column width
    var cap = parseFloat(getComputedStyle(pan).maxWidth);     // pan cap, px
    if (isNaN(cap)) cap = Infinity;
    var panBefore = Math.min(cap, global.innerWidth);
    var panAfter = Math.min(cap, Math.max(0, global.innerWidth - shift));
    var after = g.clientWidth - (panBefore - panAfter);
    var from = deskActualCols();
    var to = Math.max(1, Math.floor(after / 320));
    return (from && to < from) ? { from: from, to: to } : null;
  }

  var deskPin = null;         // { grid, visible }

  function enterPinned() {
    var g = document.getElementById('squadGrid');
    if (!g) { deskPin = null; return; }
    deskPin = { grid: g, visible: deskActualCols() };
  }

  function deskPinGuard() {
    if (mode !== 'pinned' || !deskPin) return;
    if ((lsGet('bgmi.desk.cols') || '4') !== 'auto') return;  // fixed count
    var now = deskActualCols();
    if (deskPin.visible && now && now < deskPin.visible) {
      pinnedRequested = false;
      lsSet(KEY.mode, 'drawer');
      toast('Not enough room to pin — the card grid would drop from ' +
            deskPin.visible + ' to ' + now + ' columns. Kept the drawer ' +
            'instead.');
      deskPin = null;
      applyMode(true);
      layoutTab();
    }
  }

  function toggleRail() {
    var rail = lsGet(KEY.rail) === '1' ? '0' : '1';
    lsSet(KEY.rail, rail);
    syncModeChrome();
    nav.querySelector('#afCollapse').textContent = rail === '1' ? '\u00bb' : '\u00ab';
    nav.querySelector('#afCollapse').title = rail === '1'
      ? 'Expand the sidebar' : 'Collapse to the icon rail';
  }

  function deskActualCols() {
    var g = document.getElementById('squadGrid');
    if (!g) return null;
    var t = global.getComputedStyle(g).gridTemplateColumns;
    if (!t || t === 'none') return null;
    var cols = t.split(' ').filter(function (x) { return x; }).length;
    return cols || null;
  }

  /* =========================================================================
     Desktop tab stacking: FLOW never overlaps the desk STANDINGS tab
     ========================================================================= */
  function layoutTab() {
    if (!tabBtn) return;
    var top = 118;
    var deskTab = document.getElementById('drawerTab');
    if (deskTab && !deskTab.hidden) {
      var r = deskTab.getBoundingClientRect();
      if (r && r.height) top = Math.round(r.bottom + 10);
    }
    tabBtn.style.top = top + 'px';
  }

  /* =========================================================================
     Data + render
     ========================================================================= */
  var lastData = null;
  var dead = false;

  function fetchFlow() {
    if (dead || document.hidden) return;
    global.fetch('/api/admin/flow-status', { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { dead = true; root.hidden = true; throw new Error('signed out'); }
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok) throw new Error('bad payload');
        lastData = d;
        render(d);
      })
      .catch(function () { /* keep last-known values / skeleton */ });
  }

  var refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) global.clearTimeout(refreshTimer);
    refreshTimer = global.setTimeout(fetchFlow, 250);
  }

  function stepBadge(k, c) {
    switch (k) {
      case 'review':
        return c.pending + ' pending' +
          (c.open_requests ? ' \u00b7 ' + c.open_requests + ' corrections' : '');
      case 'decide': {
        var parts = [c.approved + '/' + c.slot_limit + ' approved'];
        if (c.needs_changes) parts.push(c.needs_changes + ' needs changes');
        if (c.waitlisted) parts.push(c.waitlisted + ' waitlisted');
        if (c.dupe_warnings) parts.push(c.dupe_warnings + ' dup warning' +
          (c.dupe_warnings === 1 ? '' : 's'));
        return parts.join(' \u00b7 ');
      }
      case 'groups': return c.groups + (c.groups === 1 ? ' group' : ' groups');
      case 'assign':
        return c.assigned + '/' + c.approved + ' assigned \u00b7 ' +
          (c.locked ? 'locked' : 'unlocked');
      case 'matches': return c.scheduled + ' scheduled';
      case 'overlays': return c.enabled + ' enabled';
      case 'checkin':
        return c.match != null ? c.checked + '/' + c.size + ' checked in' : '';
      case 'room': return c.released ? 'released' : 'not released';
      case 'start':
      case 'score': return c.match ? 'Match ' + c.match : '';
      case 'publish':
        return c.awaiting && c.awaiting.length
          ? 'Match ' + c.awaiting.map(function (a) { return a.n; }).join(', ')
          : (c.published ? c.published + ' published' : '');
      case 'results': return c.published ? c.published + ' published' : '';
      default: return '';
    }
  }

  function stepHref(k, d) {
    var nm = d.next_match, live = d.live;
    var awaiting = (d.steps.publish && d.steps.publish.counts.awaiting) || [];
    switch (k) {
      case 'review': case 'decide': return '/admin#queue';
      case 'groups': case 'assign': return '/admin#groups';
      case 'matches': case 'checkin': return '/admin/matches';
      case 'overlays': return '/admin/overlays';
      case 'caster': return '/admin/caster';
      case 'room': return '/admin#settings';
      case 'start': return '/admin/control' + (nm ? '?match=' + nm.id : '');
      case 'score': return '/admin/control' + (live ? '?match=' + live.id : '');
      case 'end':
        return '/admin/control' + (live ? '?match=' + live.id
          : awaiting.length ? '?match=' + awaiting[0].id : '');
      case 'publish':
        return '/admin/control' + (awaiting.length ? '?match=' + awaiting[0].id : '');
      case 'export': return '/admin#exports';
      case 'purge': return '/admin#settings';
      default: return '/admin';
    }
  }

  function nextCard(d) {
    var st = d.steps;
    var c = d.current;
    var out = { k: 'NEXT', t: '', a: '', href: '/admin', rail: 'FLOW' };
    if (!c) {
      out.t = 'All steps are complete — export the data or purge for the ' +
        'next event.';
      out.a = 'Open exports';
      out.href = '/admin#exports';
      out.rail = 'done';
      return out;
    }
    var nm = d.next_match, live = d.live;
    var awaiting = (st.publish.counts.awaiting) || [];
    switch (c) {
      case 'review':
        out.t = st.review.counts.pending + ' registration' +
          (st.review.counts.pending === 1 ? '' : 's') + ' awaiting review.';
        if (st.review.counts.open_requests) {
          out.t += ' ' + st.review.counts.open_requests + ' correction request' +
            (st.review.counts.open_requests === 1 ? '' : 's') + ' open.';
        }
        out.a = 'Open the queue'; out.href = '/admin#queue';
        out.rail = String(st.review.counts.pending);
        break;
      case 'decide':
        if (st.decide.counts.needs_changes) {
          out.t = st.decide.counts.needs_changes + ' registration' +
            (st.decide.counts.needs_changes === 1 ? '' : 's') +
            ' need team-info fixes before approval.';
        } else if (st.decide.counts.dupe_warnings) {
          out.t = st.decide.counts.dupe_warnings + ' teams are flagged for ' +
            'duplicate UIDs, phones or names.';
        } else if (st.decide.counts.approved > st.decide.counts.slot_limit) {
          out.t = 'More teams are approved than the ' +
            st.decide.counts.slot_limit + '-slot cap.';
        } else {
          out.t = 'Waiting for registrations — approve teams as they arrive.';
        }
        out.a = 'Open the queue'; out.href = '/admin#queue';
        out.rail = '!';
        break;
      case 'groups':
        out.t = 'Create groups for the approved teams.';
        out.a = 'Create groups'; out.href = '/admin#groups';
        out.rail = '3';
        break;
      case 'assign':
        out.t = st.assign.counts.assigned < st.assign.counts.approved
          ? 'Assign every approved team to a group.'
          : 'Lock the groups once the draw is final.';
        out.a = 'Open groups'; out.href = '/admin#groups';
        out.rail = '4';
        break;
      case 'matches':
        out.t = 'Create the match schedule for each group.';
        out.a = 'Create matches'; out.href = '/admin/matches';
        out.rail = '5';
        break;
      case 'overlays':
        out.t = 'Enable at least one overlay scene and check the OBS URLs.';
        out.a = 'Open overlays'; out.href = '/admin/overlays';
        out.rail = '6';
        break;
      case 'checkin':
        out.t = nm ? 'Check in squads for Match ' + nm.n +
          ' (' + nm.checked + '/' + nm.size + ').' : 'Open check-in.';
        out.a = 'Open check-in'; out.href = '/admin/matches';
        out.rail = nm ? nm.checked + '/' + nm.size : '8';
        break;
      case 'room':
        out.t = 'Release the room details so teams know where to drop.';
        out.a = 'Open settings'; out.href = '/admin#settings';
        out.rail = '9';
        break;
      case 'start':
        out.t = nm ? 'Start Match ' + nm.n + ' — the desk opens with it ' +
          'selected.' : 'Start the next match.';
        out.a = 'Open the match desk';
        out.href = '/admin/control' + (nm ? '?match=' + nm.id : '');
        out.rail = nm ? 'M' + nm.n : '10';
        break;
      case 'score':
        out.t = live ? 'Match ' + live.n + ' is live — keep scoring on the ' +
          'desk.' : 'A match is live.';
        out.a = 'Open the desk';
        out.href = '/admin/control' + (live ? '?match=' + live.id : '');
        out.rail = live ? 'M' + live.n : '11';
        break;
      case 'publish':
        out.t = st.publish.counts.problem
          ? 'Match ' + awaiting[0].n + ': ' + st.publish.counts.problem
          : 'Match ' + (awaiting.length ? awaiting[0].n : '') +
            ' is ready to verify and publish.';
        out.a = 'Verify & publish';
        out.href = '/admin/control' +
          (awaiting.length ? '?match=' + awaiting[0].id : '');
        out.rail = '13';
        break;
      case 'results':
        out.t = 'Standings are live — check the public pages.';
        out.a = 'Open /live'; out.href = '/live';
        out.rail = '14';
        break;
      default:
        out.t = 'Keep going — the workflow is in progress.';
        out.a = 'Open'; out.href = '/admin';
    }
    return out;
  }

  function renderNavbarDemo(demo) {
    var inner = document.querySelector('.nav-inner');
    if (!inner) return;
    var badge = inner.querySelector('.af-demo');
    if (demo && !badge) {
      badge = el('span', 'af-demo', 'DEMO DATA');
      badge.title = 'This database holds seeded demo data — not real teams.';
      var logo = inner.querySelector('.nav-logo');
      if (logo && logo.nextSibling) inner.insertBefore(badge, logo.nextSibling);
      else inner.appendChild(badge);
    } else if (!demo && badge) {
      badge.remove();
    }
  }

  function pageCurrentStep(d) {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var pool = PAGE_STEPS[path];
    if (!pool) return null;
    var pref = HASH_PREF[location.hash];
    if (pref) {
      var hit = pref.filter(function (k) { return pool.indexOf(k) !== -1; });
      if (hit.length) pool = hit;
    }
    var cur = pool.filter(function (k) {
      return d.steps[k] && d.steps[k].current;
    });
    return cur.length ? cur[0] : pool[0];
  }

  function phaseCollapsedSet(d) {
    var stored = null;
    try {
      var raw = lsGet(KEY.phases);
      stored = raw ? JSON.parse(raw) : null;
    } catch (e) { stored = null; }
    if (Array.isArray(stored)) return stored;
    // default while nothing is customized: when a match is live, keep
    // match-day open and collapse the rest
    if (d.live) {
      return PHASES.filter(function (p) { return p.name !== 'match-day'; })
        .map(function (p) { return p.name; });
    }
    return [];
  }

  var collapsedPhases = [];

  function render(d) {
    renderNavbarDemo(!!d.demo);

    if (d.live) {
      liveChip.hidden = false;
      liveChip.textContent = 'LIVE \u00b7 Match ' + d.live.n;
    } else {
      liveChip.hidden = true;
    }
    var dot = document.getElementById('afTabDot');
    var dot2 = document.getElementById('afFabDot');
    if (dot) dot.hidden = !d.live;
    if (dot2) dot2.hidden = !d.live;

    // NEXT card
    var nx = nextCard(d);
    nextBox.setAttribute('data-rail', nx.rail);
    nextBox.innerHTML = '';
    nextBox.appendChild(el('span', 'af-next-k', nx.k));
    nextBox.appendChild(el('span', 'af-next-t', esc(nx.t)));
    var a = el('a', 'af-next-a', esc(nx.a));
    a.href = nx.href;
    nextBox.appendChild(a);

    // phases + steps
    collapsedPhases = phaseCollapsedSet(d);
    var pageStep = pageCurrentStep(d);
    phasesBox.innerHTML = '';
    PHASES.forEach(function (p) {
      var sec = el('section', 'af-phase');
      if (d.live && p.name === 'match-day') sec.classList.add('af-phase--live');
      var opened = collapsedPhases.indexOf(p.name) === -1;
      var head = el('button', 'af-phase-h');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(opened));
      head.innerHTML = '<span class="af-chev">' + (opened ? '\u25be' : '\u25b8') +
        '</span>' + esc(p.label) +
        '<span class="af-phase-count">' + p.steps.length + '</span>';
      head.addEventListener('click', function () {
        var idx = collapsedPhases.indexOf(p.name);
        if (idx === -1) collapsedPhases.push(p.name);
        else collapsedPhases.splice(idx, 1);
        lsSet(KEY.phases, JSON.stringify(collapsedPhases));
        render(lastData);
      });
      sec.appendChild(head);

      var ol = el('ol', 'af-steps');
      ol.hidden = !opened;
      p.steps.forEach(function (s) {
        var st = d.steps[s.k] || {};
        var cls = 'af-step';
        if (st.info) cls += ' af-step--info';
        else if (st.blocked) cls += ' af-step--blocked';
        else if (st.current) cls += ' af-step--current';
        else if (st.done) cls += ' af-step--done';
        if (st.attention) cls += ' af-step--attention';
        if (s.danger) cls += ' af-step--danger';

        var icon = st.info ? '\u2013'
          : st.blocked ? '\u00d7'
            : st.attention ? '!'
              : st.done ? '\u2713'
                : st.current ? '\u25b8' : '\u00b7';
        var badge = stepBadge(s.k, st.counts || {});
        var tag = st.current ? '<span class="af-tag">now</span>'
          : st.attention ? '<span class="af-tag">check</span>'
            : st.blocked ? '<span class="af-tag">blocked</span>' : '';

        var li = el('li');
        var link = el('a', cls, '');
        link.href = stepHref(s.k, d);
        link.dataset.step = s.k;
        if (pageStep === s.k) link.setAttribute('aria-current', 'page');
        else if (st.current) link.setAttribute('aria-current', 'step');
        var stateWord = st.blocked ? 'Blocked — ' + st.blocked
          : st.current ? 'Current step'
            : st.attention ? 'Needs attention'
              : st.done ? 'Done'
                : st.info ? 'Open' : 'To do';
        link.title = s.label + ' — ' + stateWord +
          (badge ? ' (' + badge + ')' : '');
        link.innerHTML =
          '<span class="af-ic" aria-hidden="true">' + icon + '</span>' +
          '<span class="af-n">' + s.n + '</span>' +
          '<span class="af-lab">' + esc(s.label) + '</span>' +
          tag +
          (badge ? '<span class="af-badge">' + esc(badge) + '</span>' : '');
        if (st.blocked) {
          link.addEventListener('click', function () {
            try {
              global.sessionStorage.setItem(KEY.blocked, JSON.stringify({
                label: s.label, reason: st.blocked
              }));
            } catch (e) { /* banner is best-effort */ }
          });
        }
        li.appendChild(link);
        ol.appendChild(li);
      });
      sec.appendChild(ol);
      phasesBox.appendChild(sec);
    });

    layoutTab();
    global.setTimeout(deskPinGuard, 80);
  }

  /* =========================================================================
     Landing behavior: activate the right tab, scroll + flash the target
     ========================================================================= */
  function landFlash() {
    var hash = location.hash;
    if (!hash || hash.length < 2) return;
    var target0 = document.getElementById(hash.slice(1));
    var panel = target0 && target0.closest('[role="tabpanel"]');
    var needTab = !target0 || (panel && panel.classList.contains('hidden'));
    var tabId = PAGE_TABS[hash];
    if (tabId && needTab) {
      var btn = document.getElementById(tabId);
      if (btn) btn.click();
    }
    var target = document.getElementById(hash.slice(1));
    if (!target && tabId) {
      // /admin tab shortcuts land on the tab panel when no anchor exists
      var b2 = document.getElementById(tabId);
      if (b2) target = b2.closest('section') || b2;
    }
    if (!target) return;
    global.setTimeout(function () {
      try {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (e) { target.scrollIntoView(); }
      var y = global.scrollY;
      global.scrollTo(0, Math.max(0, y - 64));
      var flash = target.closest('section') || target;
      flash.classList.remove('af-flash');
      void flash.offsetWidth;              // restart the animation
      flash.classList.add('af-flash');
      global.setTimeout(function () { flash.classList.remove('af-flash'); }, 1800);
    }, 60);
  }

  var bannerShown = false;
  function showBlockedBanner() {
    if (bannerShown) return;
    var raw = null;
    try { raw = global.sessionStorage.getItem(KEY.blocked); } catch (e) { return; }
    if (!raw) return;
    try { global.sessionStorage.removeItem(KEY.blocked); } catch (e) { /* ignore */ }
    var info;
    try { info = JSON.parse(raw); } catch (e) { return; }
    if (!info || !info.reason) return;
    var main = document.querySelector('main.pan') || document.querySelector('main');
    if (!main) return;
    bannerShown = true;
    var b = el('div', 'af-banner', '');
    b.setAttribute('role', 'alert');
    b.innerHTML = '<b>Flow:</b> <span>' + esc(info.label) + ' is blocked — ' +
      esc(info.reason) + '.</span>';
    var x = el('button', '', 'Dismiss');
    x.type = 'button';
    x.addEventListener('click', function () { b.remove(); });
    b.appendChild(x);
    main.insertBefore(b, main.firstChild);
  }

  /* =========================================================================
     Shortcuts: Alt+W toggles, Esc closes
     ========================================================================= */
  function onKey(e) {
    if (e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      if (mode === 'pinned') { toggleRail(); return; }
      if (isOpen) closeFlow(); else openFlow();
      return;
    }
    if (e.key === 'Escape' && isOpen && mode !== 'pinned') {
      e.stopPropagation();
      closeFlow();
    }
  }

  /* focus trap for the modal modes */
  function onTrapKey(e) {
    if (!isOpen || mode === 'pinned' || e.key !== 'Tab') return;
    var host = mode === 'sheet' ? sheet : drawer;
    var nodes = host.querySelectorAll(
      'button:not([hidden]), a[href], [tabindex]:not([tabindex="-1"])');
    if (!nodes.length) return;
    var list = Array.prototype.filter.call(nodes, function (n) {
      return n.offsetParent !== null;
    });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }

  /* While the publish bar is on screen the phone FAB fades out, so the pill
     never sits chopped under the verify/publish actions while the user
     scrolls past them. */
  function watchFabZones() {
    if (!global.IntersectionObserver) return;
    var bar = document.querySelector('.bc-publish-bar');
    if (!bar) return;
    var io = new global.IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        fab.classList.toggle('af-fab-quiet', en.isIntersecting);
      });
    }, { threshold: 0 });
    io.observe(bar);
  }

  /* =========================================================================
     Boot
     ========================================================================= */
  function logout() {
    global.fetch('/api/admin/me').then(function (r) { return r.json(); })
      .then(function (d) {
        return global.fetch('/api/admin/logout', {
          method: 'POST',
          headers: d && d.csrf ? { 'X-Admin-CSRF': d.csrf } : {}
        });
      })
      .then(function () { location.href = '/admin'; })
      .catch(function () { location.href = '/admin'; });
  }

  function boot() {
    buildDom();
    watchFabZones();
    applyMode(false);

    // restore the remembered open state
    if (lsGet(KEY.open) === '1' && mode !== 'pinned') {
      global.setTimeout(openFlow, 120);
    }

    // any successful admin write refreshes the sidebar right away
    var origFetch = global.fetch;
    global.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var method = ((init && init.method) || 'GET').toUpperCase();
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (method !== 'GET' && url.indexOf('/api/admin/') === 0 &&
            url.indexOf('/stream') === -1) {
          p.then(function (r) { if (r && r.ok) scheduleRefresh(); },
                 function () { });
        }
      } catch (e) { /* never break the caller */ }
      return p;
    };

    // one drawer at a time: opening STANDINGS dismisses FLOW; resizing re-modes
    var deskTab = document.getElementById('drawerTab');
    if (deskTab) {
      deskTab.addEventListener('click', function () { closeFlow(); });
      if (global.MutationObserver) {
        new global.MutationObserver(layoutTab)
          .observe(deskTab, { attributes: true, attributeFilter: ['hidden'] });
      }
    }
    var deskDrawer = document.getElementById('sideDrawer');
    if (deskDrawer && global.MutationObserver) {
      new global.MutationObserver(function () {
        if (deskDrawer.classList.contains('bc-drawer--open') && isOpen) closeFlow();
      }).observe(deskDrawer, { attributes: true, attributeFilter: ['class'] });
    }

    global.addEventListener('resize', function () {
      applyMode(false);
      layoutTab();
      global.setTimeout(deskPinGuard, 300);
    });
    global.addEventListener('hashchange', function () {
      // a blocked step that targets the same page only changes the hash —
      // no reload, so re-check the one-shot handoff here too
      showBlockedBanner();
      landFlash();
    });
    document.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onTrapKey);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) fetchFlow();
    });
    document.addEventListener('af:refresh', scheduleRefresh);

    showBlockedBanner();
    fetchFlow();
    landFlash();
    global.setInterval(fetchFlow, POLL_MS);
    global.setInterval(layoutTab, 4000);   // desk modes can move its tab
    // the desk applies its layout right after boot — re-measure a few times
    [300, 900, 1800, 3200].forEach(function (t) {
      global.setTimeout(layoutTab, t);
    });
    global.addEventListener('load', layoutTab);
    [700, 2200].forEach(function (t) {
      global.setTimeout(deskPinGuard, t);
    });

    // exposed for tests / other components
    global.AF = {
      refresh: function () { scheduleRefresh(); },
      _state: function () {
        return { mode: mode, open: isOpen, pinned: pinnedRequested,
                 data: lastData };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
