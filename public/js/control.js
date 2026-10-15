/* Match Control Desk — live scoring workspace.
   Talks to /api/admin/match* (session + CSRF via admin-shell). Updates stream
   in through the admin SSE channel with a 2s polling fallback.
   Card layout: slot badge / tag / name+group / FIN · PLACE · PTS / chevron,
   a control row (+FINISH, −, PLACE stepper, AUTO, gear) and exactly four
   player rows (index, IGN + UID, DMG stepper, finish counter, status icons). */
(function () {
  'use strict';
  var esc = BC.esc;
  var $ = function (id) { return document.getElementById(id); };

  var matchId = null;         // currently open match
  var matches = [];           // list for the picker
  var state = null;           // match_state payload
  var busy = false;           // one action at a time (avoid out-of-order)
  var pending = [];           // queued actions while busy
  var timerT = null;
  var folded = {};            // teamId -> true when the card is collapsed
  var conflicts = {};         // teamId -> epoch ms until the badge shows

  var STATUS_BTNS = [
    ['alive', 'Alive', 'bc-st--alive',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20S5 15.4 3.4 11.7C2.1 8.6 3.9 5.9 6.8 5.9c1.8 0 3.3 1 4.2 2.2.9-1.2 2.4-2.2 4.2-2.2 2.9 0 4.7 2.7 3.4 5.8C17 15.4 12 20 12 20Z" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>'],
    ['knocked', 'Knocked', 'bc-st--knocked',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>'],
    ['out', 'Out', 'bc-st--out',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>']
  ];

  /* ---- picker ----------------------------------------------------------- */

  function loadMatches(keep) {
    BC.api('/api/admin/matches').then(function (x) {
      if (x.s !== 200 || !x.d.ok) return;
      matches = x.d.matches;
      var sel = $('matchPick');
      var wanted = keep || matchId ||
        (matches.filter(function (m) { return m.status === 'live'; })[0] || {}).id ||
        (matches[matches.length - 1] || {}).id || null;
      sel.innerHTML = matches.map(function (m) {
        return '<option value="' + m.id + '">' +
          (m.status === 'live' ? '● LIVE · ' : '') +
          'Match ' + m.match_number + ' — Group ' + esc(m.group_name) +
          ' (' + esc(m.map) + ')</option>';
      }).join('');
      if (!matches.length) {
        $('deskEmpty').classList.remove('hidden');
        $('deskBody').classList.add('hidden');
        return;
      }
      $('deskEmpty').classList.add('hidden');
      if (wanted && String(wanted) !== sel.value) sel.value = String(wanted);
      matchId = parseInt(sel.value, 10);
      loadState();
    });
  }

  $('matchPick').addEventListener('change', function () {
    matchId = parseInt($('matchPick').value, 10);
    loadState();
  });

  /* ---- state ------------------------------------------------------------ */

  function loadState() {
    if (!matchId) return;
    BC.api('/api/admin/matches/' + matchId).then(function (x) {
      if (x.s !== 200 || !x.d.ok) {
        $('deskNotice').textContent = x.d.error || 'Could not load the match.';
        $('deskNotice').classList.remove('hidden');
        return;
      }
      $('deskNotice').classList.add('hidden');
      state = x.d.state;
      render();
    });
  }

  function push() {                    /* queue an action, run serially */
    if (busy) return;
    busy = true;
    var run = function () {
      var job = pending.shift();
      if (!job) { busy = false; return; }
      job().then(function () { run(); });
    };
    run();
  }

  /* act(path, body, teamId): queues a desk action. On rejection the server
     message is toasted; a placement clash also flags the card. */
  function act(path, body, teamId) {
    pending.push(function () {
      return BC.post(path, body).then(function (x) {
        if (x.s === 200 && x.d.ok) {
          state = x.d.state;
          render();
        } else {
          var msg = x.d.error || 'Action failed';
          BC.toast(msg, true);
          if (teamId && /already belongs to/i.test(msg)) {
            conflicts[teamId] = Date.now() + 6000;
            loadState();
            setTimeout(function () {
              delete conflicts[teamId];
              render();
            }, 6200);
          } else {
            loadState();
          }
        }
      });
    });
    push();
  }

  /* ---- render ----------------------------------------------------------- */

  function cardTeam(el) {
    var card = el.closest ? el.closest('.bc-squad') : null;
    if (!card || !state) return null;
    return state.teams.filter(function (t) {
      return String(t.teamId) === card.dataset.team;
    })[0] || null;
  }

  function squadCard(t, total) {
    var dead = t.players.length > 0 && t.alive === 0 && t.knocked === 0;
    var isFolded = !!folded[t.teamId];
    var flagged = Date.now() < (conflicts[t.teamId] || 0);
    var logo = t.logo && String(t.logo).indexOf('/uploads/') === 0
      ? '<img class="bc-tag bc-tag--img" src="' + esc(t.logo) + '" alt="">'
      : '<span class="bc-tag">' + esc(t.teamTag) + '</span>';
    var rank = dead ? (t.placement
      ? '<span class="bc-rank" title="Final place">#' + t.placement + '</span>'
      : '<span class="bc-rank bc-rank--auto" title="Squad is out — set AUTO">SET AUTO</span>') : '';
    var adj = t.adjustment
      ? '<span class="bc-adj" title="' + esc(t.adjustmentReason || 'manual adjustment') +
        '">' + (t.adjustment > 0 ? '+' : '') + t.adjustment + '</span>' : '';

    var players = t.players.map(function (p, i) {
      var btns = STATUS_BTNS.map(function (b) {
        return '<button type="button" class="bc-st ' + b[2] +
          '" data-ps="' + p.id + '" data-field="status" data-value="' + b[0] +
          '" title="' + b[1] + '" aria-label="' + b[1] + ' for ' +
          esc(p.name) + '" aria-pressed="' + (p.status === b[0]) + '">' +
          b[3] + '</button>';
      }).join('');
      return '<div class="bc-player bc-player--' + esc(p.status) + '">' +
        '<span class="bc-pidx">' + (i + 1) + '</span>' +
        '<span class="bc-pid"><b>' + esc(p.name) + '</b>' +
        '<small>UID ' + esc(p.uid) + '</small></span>' +
        '<span class="bc-stepper" role="group" aria-label="Damage for ' +
        esc(p.name) + '">' +
        '<button type="button" data-ps="' + p.id + '" data-field="damage" ' +
        'data-step="-100" aria-label="Damage minus 100">&minus;</button>' +
        '<input class="bc-dmg" type="number" min="0" max="50000" value="' +
        p.damage + '" data-ps="' + p.id + '" data-field="damage" ' +
        'aria-label="Damage for ' + esc(p.name) + '">' +
        '<button type="button" data-ps="' + p.id + '" data-field="damage" ' +
        'data-step="100" aria-label="Damage plus 100">+</button></span>' +
        '<span class="bc-stepper bc-stepper--kill" role="group" ' +
        'aria-label="Finishes for ' + esc(p.name) + '">' +
        '<button type="button" data-ps="' + p.id + '" data-field="kill" ' +
        'data-value="-1" aria-label="Finish minus one">&minus;</button>' +
        '<b class="bc-kcount">' + p.kills + '</b>' +
        '<button type="button" data-ps="' + p.id + '" data-field="kill" ' +
        'data-value="1" aria-label="Finish plus one">+</button></span>' +
        '<span class="bc-status-btns" role="group" aria-label="Status for ' +
        esc(p.name) + '">' + btns + '</span>' +
        '</div>';
    }).join('');

    return '<article class="bc-squad' + (dead ? ' bc-squad--dead' : '') +
      (isFolded ? ' bc-squad--folded' : '') +
      (flagged ? ' bc-squad--conflict' : '') +
      '" data-team="' + esc(t.teamId) + '">' +
      '<div class="bc-squad-head">' +
      '<span class="bc-slot" title="Squad slot in this match">P' + t.slot + '</span>' +
      logo +
      '<div class="bc-names"><b class="bc-squad-tag">' + esc(t.teamTag) + '</b>' +
      '<span class="bc-squad-name" title="' + esc(t.teamName) + '">' +
      esc(t.teamName) + '</span>' +
      '<small class="bc-squad-group">' + esc(t.group || 'No group') + '</small></div>' +
      '<div class="bc-squad-stats">' +
      '<span class="bc-stat"><small>FIN</small><b>' + t.kills + '</b></span>' +
      '<span class="bc-stat"><small>PLACE</small><b>' +
      (t.placement || '&mdash;') + '</b></span>' +
      '<span class="bc-stat bc-stat--pts"><small>PTS</small><b>' + t.points +
      '</b>' + adj + '</span>' +
      rank +
      '</div>' +
      (flagged ? '<span class="bc-conflict">PLACE TAKEN</span>' : '') +
      '<button type="button" class="bc-chev" data-act="fold" title="' +
      (isFolded ? 'Expand' : 'Collapse') + ' card" aria-expanded="' +
      (!isFolded) + '" aria-label="' + (isFolded ? 'Expand' : 'Collapse') +
      ' ' + esc(t.teamName) + '">&#9662;</button>' +
      '<div class="bc-menu hidden" role="menu">' +
      '<button type="button" role="menuitem" data-act="swap">&#8646; Swap player</button>' +
      '<button type="button" role="menuitem" data-act="adjust">&#177; Manual adjustment</button>' +
      '<button type="button" role="menuitem" data-act="reset">&#8634; Reset team</button>' +
      '</div></div>' +
      '<div class="bc-ctl">' +
      '<button type="button" class="bc-fin" data-act="fin" data-delta="1" ' +
      'title="Unassigned finish — no player credited">+ FINISH</button>' +
      '<button type="button" class="bc-fin bc-fin--minus" data-act="fin" ' +
      'data-delta="-1" title="Remove an unassigned finish" ' +
      'aria-label="Remove unassigned finish">&minus;</button>' +
      '<span class="bc-stepper bc-stepper--place" role="group" ' +
      'aria-label="Placement for ' + esc(t.teamName) + '">' +
      '<button type="button" data-act="place" data-step="-1" ' +
      'aria-label="Placement minus one">&minus;</button>' +
      '<input class="bc-place-input" type="number" min="0" max="' + total +
      '" value="' + (t.placement || '') + '" placeholder="—" data-team="' +
      esc(t.teamId) + '" aria-label="Placement for ' + esc(t.teamName) + '">' +
      '<button type="button" data-act="place" data-step="1" ' +
      'aria-label="Placement plus one">+</button></span>' +
      '<button type="button" class="bc-auto' +
      (t.placementAuto ? ' bc-auto--on' : '') + '" data-act="auto" ' +
      'title="Placement follows the engine again (next free position)">AUTO</button>' +
      '<button type="button" class="bc-gear" data-act="gear" ' +
      'title="Team options" aria-label="Team options for ' +
      esc(t.teamName) + '" aria-haspopup="menu">&#9881;</button>' +
      '</div>' +
      players +
      '</article>';
  }

  function render() {
    if (!state) return;
    var m = state.match;
    $('deskMatchNo').textContent = 'Match ' + m.match_number;
    $('deskMeta').textContent = 'Group ' + m.group_name + ' · ' + m.map;
    var stampCls = m.status === 'live' ? 'bc-stamp bc-stamp--live'
      : (m.status === 'published' ? 'bc-stamp bc-stamp--done' : 'bc-stamp');
    var stampTxt = { 'upcoming': 'Upcoming', 'live': 'LIVE',
      'awaiting_verification': 'Await review', 'published': 'Published' }[m.status] || m.status;
    $('deskStatus').innerHTML = '<span class="' + stampCls + '">' + stampTxt + '</span>';
    $('deskBody').classList.remove('hidden');

    var total = state.teams.length;
    $('deskAlive').textContent = state.teamsAlive + '/' + total;
    tickTimer(m);

    $('startBtn').disabled = m.status !== 'upcoming';
    $('endBtn').disabled = m.status !== 'live';
    $('unpublishBtn').hidden = m.status !== 'published';

    /* squad grid — stable slot order so cards never jump mid-match */
    var bySlot = state.teams.slice().sort(function (a, b) {
      return (a.slot || 0) - (b.slot || 0);
    });
    var grid = $('squadGrid');
    grid.innerHTML = bySlot.map(function (t) {
      return squadCard(t, total);
    }).join('');
    grid.onclick = onGridClick;
    grid.querySelectorAll('.bc-dmg').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var t = cardTeam(inp);
        if (!t) return;
        act('/api/admin/match/' + matchId + '/player', {
          teamId: t.teamId, playerId: inp.dataset.ps, field: 'damage',
          value: Math.max(0, Math.min(50000, parseInt(inp.value, 10) || 0))
        }, t.teamId);
      });
    });
    grid.querySelectorAll('.bc-place-input').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var t = cardTeam(inp);
        if (!t) return;
        var v = Math.max(0, Math.min(total, parseInt(inp.value, 10) || 0));
        act('/api/admin/match/' + matchId + '/team/' + t.teamId + '/placement',
            { placement: v, manual: true }, t.teamId);
      });
    });

    /* sidebar standings */
    $('sideStandings').innerHTML = state.teams.map(function (t, i) {
      return '<tr' + (i === 0 ? ' class="bc-lead"' : '') + '><td>' +
        (t.placement || '—') + '</td><td>' + esc(t.teamTag) +
        '</td><td>' + t.kills + '</td><td>' + t.points + '</td></tr>';
    }).join('');

    /* event log — every action carries its timestamp */
    $('sideEvents').innerHTML = state.events.map(function (e) {
      return '<li class="' + (e.undone ? 'bc-ev-undone' : '') + '"><time>' +
        esc(e.at.slice(-8)) + '</time><span>' + esc(e.description) + '</span></li>';
    }).join('') || '<li><span>No actions yet.</span></li>';

    /* publish bar */
    var canPublish = m.status === 'awaiting_verification' && !state.publishProblem;
    $('publishBtn').disabled = !canPublish;
    var prob = $('publishProblem');
    if (m.status === 'awaiting_verification' && state.publishProblem) {
      prob.textContent = state.publishProblem;
      prob.classList.remove('hidden');
    } else {
      prob.classList.add('hidden');
    }
    $('publishHint').textContent = {
      'upcoming': 'Check squads in, then start the match.',
      'live': 'Score the match, then end it for verification.',
      'awaiting_verification': canPublish ? 'All placements verified — ready to publish.' : '',
      'published': 'Results are live on /live and /results.'
    }[m.status] || '';
  }

  /* ---- grid clicks -------------------------------------------------------- */

  function onGridClick(e) {
    var el = e.target.closest('[data-act],[data-field]');
    if (!el || !state) return;
    var t = cardTeam(el);
    if (!t) return;
    var actName = el.dataset.act;

    if (actName === 'fold') {
      folded[t.teamId] = !folded[t.teamId];
      render();
      return;
    }
    if (actName === 'gear') {
      var menu = el.closest('.bc-squad').querySelector('.bc-menu');
      var open = !menu.classList.contains('hidden');
      closeMenus();
      if (!open) menu.classList.remove('hidden');
      return;
    }
    if (actName === 'fin') {
      act('/api/admin/match/' + matchId + '/team/' + t.teamId + '/kills',
          { delta: parseInt(el.dataset.delta, 10) }, t.teamId);
      return;
    }
    if (actName === 'auto') {
      act('/api/admin/match/' + matchId + '/team/' + t.teamId + '/auto',
          {}, t.teamId);
      return;
    }
    if (actName === 'place') {
      var total = state.teams.length;
      var next = (parseInt(t.placement, 10) || 0) +
        parseInt(el.dataset.step, 10);
      next = Math.max(0, Math.min(total, next));
      act('/api/admin/match/' + matchId + '/team/' + t.teamId + '/placement',
          { placement: next, manual: true }, t.teamId);
      return;
    }
    if (actName === 'swap') {
      closeMenus();
      openSwap(t);
      return;
    }
    if (actName === 'adjust') {
      closeMenus();
      openAdjust(t);
      return;
    }
    if (actName === 'reset') {
      closeMenus();
      if (!window.confirm('Reset ' + t.teamName +
          '? Finishes, placement and adjustments go back to zero.')) return;
      act('/api/admin/match/' + matchId + '/team/' + t.teamId + '/reset',
          {}, t.teamId);
      return;
    }

    /* player rows: buttons only — the DMG input commits on change */
    if (el.tagName !== 'BUTTON') return;
    var field = el.dataset.field;
    if (!field) return;
    var pid = el.dataset.ps;
    if (field === 'damage') {
      var input = el.closest('.bc-stepper').querySelector('.bc-dmg');
      var cur = parseInt(input.value, 10) || 0;
      var nv = Math.max(0, Math.min(50000,
        cur + parseInt(el.dataset.step, 10)));
      act('/api/admin/match/' + matchId + '/player', {
        teamId: t.teamId, playerId: pid, field: 'damage', value: nv
      }, t.teamId);
    } else if (field === 'kill') {
      act('/api/admin/match/' + matchId + '/player', {
        teamId: t.teamId, playerId: pid, field: 'kill',
        value: parseInt(el.dataset.value, 10)
      }, t.teamId);
    } else if (field === 'status') {
      act('/api/admin/match/' + matchId + '/player', {
        teamId: t.teamId, playerId: pid, field: 'status',
        value: el.dataset.value
      }, t.teamId);
    }
  }

  function closeMenus() {
    document.querySelectorAll('.bc-menu').forEach(function (m) {
      m.classList.add('hidden');
    });
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.bc-menu,[data-act="gear"]')) {
      closeMenus();
    }
  });

  /* ---- dialogs ------------------------------------------------------------ */

  function dialog(html) {
    var d = document.createElement('dialog');
    d.className = 'bc-dlg';
    d.innerHTML = '<form method="dialog">' + html + '</form>';
    d.addEventListener('close', function () {
      if (d.parentNode) d.parentNode.removeChild(d);
    });
    document.body.appendChild(d);
    d.showModal();
    return d;
  }

  function openSwap(t) {
    if (!t.bench || !t.bench.length) {
      BC.toast("No substitutes on this team's roster.", true);
      return;
    }
    var outs = t.players.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.name) + '</option>';
    }).join('');
    var ins = t.bench.map(function (b) {
      return '<option value="' + esc(b.kind) + ':' + b.id + '">' +
        esc(b.name) + ' (' + esc(b.slot) + ')</option>';
    }).join('');
    var d = dialog(
      '<h3>Swap player — ' + esc(t.teamName) + '</h3>' +
      '<p class="bc-p">Bench one of the four playing and bring in a substitute. ' +
      'The replaced player keeps their stats.</p>' +
      '<label class="bc-label" for="swOut">Player to replace</label>' +
      '<select class="bc-select" id="swOut">' + outs + '</select>' +
      '<label class="bc-label" for="swIn" style="margin-top:10px;">Bring in</label>' +
      '<select class="bc-select" id="swIn">' + ins + '</select>' +
      '<div class="bc-dlg-acts">' +
      '<button type="submit" class="bc-btn" value="cancel">Cancel</button>' +
      '<button type="button" class="bc-btn bc-btn--go" id="swGo">Swap</button>' +
      '</div>');
    d.querySelector('#swGo').addEventListener('click', function () {
      var parts = d.querySelector('#swIn').value.split(':');
      act('/api/admin/match/' + matchId + '/team/' + t.teamId + '/swap', {
        benchId: parseInt(d.querySelector('#swOut').value, 10),
        inKind: parts[0], inId: parseInt(parts[1], 10)
      }, t.teamId);
      d.close();
    });
  }

  function openAdjust(t) {
    var d = dialog(
      '<h3>Manual adjustment — ' + esc(t.teamName) + '</h3>' +
      '<p class="bc-p">Points = placement + finishes + adjustment. ' +
      'The reason is required and goes into the event and audit logs.</p>' +
      '<label class="bc-label" for="adjPts">Points to add or remove</label>' +
      '<input class="bc-input" id="adjPts" type="number" step="1" ' +
      'min="-100" max="100" value="0">' +
      '<label class="bc-label" for="adjReason" style="margin-top:10px;">Reason</label>' +
      '<input class="bc-input" id="adjReason" maxlength="120" ' +
      'placeholder="e.g. rule 4.2 — late drop penalty">' +
      '<div class="bc-dlg-acts">' +
      '<button type="submit" class="bc-btn" value="cancel">Cancel</button>' +
      '<button type="button" class="bc-btn bc-btn--go" id="adjGo">Apply</button>' +
      '</div>');
    d.querySelector('#adjGo').addEventListener('click', function () {
      var delta = parseInt(d.querySelector('#adjPts').value, 10) || 0;
      var reason = d.querySelector('#adjReason').value.trim();
      if (!delta || !reason) {
        BC.toast('Enter a non-zero points change and a reason.', true);
        return;
      }
      act('/api/admin/match/' + matchId + '/team/' + t.teamId + '/adjust',
          { delta: delta, reason: reason }, t.teamId);
      d.close();
    });
  }

  function tickTimer(m) {
    clearInterval(timerT);
    function set() {
      if (m.status === 'live' && m.started_at) {
        var s = Math.max(0, Math.floor((Date.now() - Date.parse(m.started_at)) / 1000));
        $('deskTimer').textContent =
          String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      } else if (m.status === 'published') {
        $('deskTimer').textContent = BC.fmtTime(m.published_at);
      } else {
        $('deskTimer').textContent = '--:--';
      }
    }
    set();
    if (m.status === 'live') timerT = setInterval(set, 1000);
  }

  /* ---- top bar actions ---------------------------------------------------- */

  $('startBtn').addEventListener('click', function () {
    act('/api/admin/matches/' + matchId + '/status', { status: 'live' });
  });
  $('endBtn').addEventListener('click', function () {
    act('/api/admin/matches/' + matchId + '/status',
        { status: 'awaiting_verification' });
  });
  $('undoBtn').addEventListener('click', function () {
    act('/api/admin/match/' + matchId + '/undo', {});
  });
  $('publishBtn').addEventListener('click', function () {
    if ($('publishBtn').disabled) return;
    var placed = state.teams.length;
    if (!window.confirm('Publish match ' + state.match.match_number +
        '? All ' + placed + ' placements go live on /live and /results.')) return;
    act('/api/admin/matches/' + matchId + '/publish', {});
  });
  $('unpublishBtn').addEventListener('click', function () {
    if (!window.confirm('Unpublish and return this match to review?')) return;
    act('/api/admin/matches/' + matchId + '/unpublish', {});
  });

  /* ---- keyboard shortcuts ------------------------------------------------- */

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'escape') { closeMenus(); }
    else if (k === 'u') { $('undoBtn').click(); }
    else if (k === 'r') { loadState(); }
    else if (k === 's' && state) {
      if (state.match.status === 'upcoming') $('startBtn').click();
      else if (state.match.status === 'live') $('endBtn').click();
    }
  });

  /* ---- boot --------------------------------------------------------------- */

  BC.boot(function () {
    loadMatches();
    BC.live('/api/admin/stream', function () {
      loadMatches(matchId);
    });
  });
})();
