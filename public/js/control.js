/* Match Control Desk — live scoring workspace.
   Talks to /api/admin/match* (session + CSRF via admin-shell). Updates stream
   in through the admin SSE channel with a 2s polling fallback. */
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
        $('deskTop') && 0;
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
  function act(path, body) {
    pending.push(function () {
      return BC.post(path, body).then(function (x) {
        if (x.s === 200 && x.d.ok) {
          state = x.d.state;
          render();
        } else {
          BC.toast(x.d.error || 'Action failed', true);
          loadState();
        }
      });
    });
    push();
  }

  /* ---- render ----------------------------------------------------------- */

  var STATUS_BTNS = [
    ['alive', 'ALV', 'bc-st--alive'],
    ['knocked', 'KNK', 'bc-st--knocked'],
    ['out', 'OUT', 'bc-st--out']
  ];

  function squadCard(t) {
    var logo = t.logo && String(t.logo).indexOf('/uploads/') === 0
      ? '<img class="bc-squad-logo" src="' + esc(t.logo) + '" alt="">'
      : '<span class="bc-squad-logo bc-squad-logo--ph">' + esc(t.teamTag) + '</span>';
    var dead = (t.alive === 0 && t.knocked === 0 && t.out > 0);
    var players = t.players.map(function (p) {
      var cls = p.status === 'out' ? ' bc-player--out'
        : (p.status === 'knocked' ? ' bc-player--knocked' : '');
      var btns = STATUS_BTNS.map(function (b) {
        return '<button class="bc-st ' + b[2] + '" data-ps="' + p.id +
          '" data-field="status" data-value="' + b[0] + '" aria-pressed="' +
          (p.status === b[0]) + '">' + b[1] + '</button>';
      }).join('');
      return '<div class="bc-player' + cls + '">' +
        '<span class="bc-player-name">' + esc(p.name) + '</span>' +
        '<span class="bc-kills">' +
        '<button class="bc-kbtn" data-ps="' + p.id + '" data-field="kill" data-value="-1">&minus;</button>' +
        '<span class="bc-kcount">' + p.kills + '</span>' +
        '<button class="bc-kbtn" data-ps="' + p.id + '" data-field="kill" data-value="1">+</button>' +
        '</span>' +
        '<input class="bc-dmg" type="number" min="0" max="50000" value="' + p.damage +
        '" data-ps="' + p.id + '" data-field="damage" aria-label="Damage for ' + esc(p.name) + '">' +
        '<span class="bc-status-btns">' + btns + '</span>' +
        '</div>';
    }).join('');
    return '<article class="bc-squad' + (dead ? ' bc-squad--dead' : '') +
      '" data-team="' + esc(t.teamId) + '">' +
      '<div class="bc-squad-head">' + logo +
      '<div><div class="bc-squad-name">' + esc(t.teamName) + '</div>' +
      '<div class="bc-squad-tag">[' + esc(t.teamTag) + ']</div></div>' +
      '<div class="bc-squad-pts"><b>' + t.points + '</b><span>PTS · ' +
      t.kills + ' FR</span></div></div>' +
      players +
      '<div class="bc-squad-foot">' +
      '<label class="bc-auto-badge' + (t.placementAuto ? '' : ' bc-auto-badge--manual') + '">' +
      (t.placementAuto ? 'auto' : 'pinned') + '</label>' +
      '<input class="bc-place-input" type="number" min="0" max="16" value="' +
      (t.placement || 0) + '" data-team="' + esc(t.teamId) +
      '" aria-label="Placement for ' + esc(t.teamName) + '">' +
      (dead ? '' : '<button class="bc-btn bc-btn--no" data-wipe="' + esc(t.teamId) +
        '" style="font-size:.62rem;padding:4px 8px;">Eliminate squad</button>') +
      '</div></article>';
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

    /* squad grid */
    $('squadGrid').innerHTML = state.teams.map(squadCard).join('');
    $('squadGrid').querySelectorAll('[data-field]').forEach(function (el) {
      var handler = function () {
        var pid = el.dataset.ps;
        var field = el.dataset.field;
        var value = field === 'damage' ? parseInt(el.value, 10) || 0
          : parseInt(el.dataset.value, 10);
        var team = state.teams.filter(function (t) {
          return t.players.some(function (p) { return String(p.id) === String(pid); });
        })[0];
        if (!team) return;
        act('/api/admin/match/' + matchId + '/player', {
          teamId: team.teamId, playerId: pid, field: field, value: value
        });
      };
      if (el.dataset.field === 'damage') {
        el.addEventListener('change', handler);
      } else {
        el.addEventListener('click', handler);
      }
    });
    $('squadGrid').querySelectorAll('.bc-place-input').forEach(function (inp) {
      inp.addEventListener('change', function () {
        act('/api/admin/match/' + matchId + '/team/' + inp.dataset.team +
            '/placement', { placement: parseInt(inp.value, 10) || 0, manual: true });
      });
    });
    $('squadGrid').querySelectorAll('[data-wipe]').forEach(function (b) {
      b.addEventListener('click', function () {
        act('/api/admin/match/' + matchId + '/team/' + b.dataset.wipe +
            '/eliminate', {});
      });
    });

    /* sidebar standings */
    $('sideStandings').innerHTML = state.teams.map(function (t, i) {
      return '<tr' + (i === 0 ? ' class="bc-lead"' : '') + '><td>' +
        (t.placement || '—') + '</td><td>' + esc(t.teamTag) +
        '</td><td>' + t.kills + '</td><td>' + t.points + '</td></tr>';
    }).join('');

    /* event log */
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

  /* ---- actions ----------------------------------------------------------- */

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
    if (k === 'u') { $('undoBtn').click(); }
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
