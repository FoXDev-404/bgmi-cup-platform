/* Matches page — create matches, check in lineups, edit scoring rules. */
(function () {
  'use strict';
  var esc = BC.esc;
  var matches = [];
  var groups = [];
  var checkinMatch = null;   // match currently open in the check-in drawer

  var $ = function (id) { return document.getElementById(id); };

  /* Data already stores "Group A"; only add the word when it's missing. */
  function grp(n) {
    n = String(n == null ? '' : n).trim();
    return !n ? '' : (/^group\b/i.test(n) ? n : 'Group ' + n);
  }

  /* 'YYYY-MM-DDTHH:MM' (local) -> '14 Nov, 04:00 pm' for the match cards. */
  function fmtStarts(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  }

  /* ---- render ---------------------------------------------------------- */

  function statusStamp(status) {
    var map = {
      'upcoming': ['', 'Upcoming'],
      'live': ['bc-stamp--live', 'Live'],
      'awaiting_verification': ['', 'Await review'],
      'published': ['bc-stamp--done', 'Published']
    };
    var m = map[status] || ['', status];
    return '<span class="bc-stamp ' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  function matchCard(m) {
    var acts = [];
    acts.push('<button class="bc-btn" data-checkin="' + m.id + '">' +
      (m.team_count ? 'Check-in (' + m.team_count + ')' : 'Check-in') + '</button>');
    if (m.status !== 'published') {
      acts.push('<button class="bc-btn bc-btn--no" data-del="' + m.id + '">Delete</button>');
    }
    acts.push('<a class="bc-btn" href="/api/admin/export/match/' + m.id +
      '.csv" title="Download this match\'s results CSV">CSV</a>');
    return '<article class="bc-match">' +
      '<div class="bc-match-n">Match ' + m.match_number + '</div>' +
      '<div class="bc-match-meta">' + esc(grp(m.group_name)) + ' &middot; ' +
      esc(m.map) + ' &middot; ' + m.team_count + ' squads &middot; ' +
      m.placed_count + '/' + m.team_count + ' placed</div>' +
      statusStamp(m.status) +
      '<div class="bc-match-when">' +
      (m.starts_at ? '<b>Starts</b> ' + esc(fmtStarts(m.starts_at))
                   : 'No time set') +
      ' <button class="bc-link" data-schededit="' + m.id + '">' +
      (m.starts_at ? 'edit' : 'set time') + '</button></div>' +
      '<div class="bc-match-sched hidden" data-sched="' + m.id + '">' +
      '<input class="bc-input" type="datetime-local" data-schedin="' + m.id +
      '" value="' + esc(m.starts_at || '') + '" aria-label="Starts at">' +
      '<button class="bc-btn bc-btn--go" data-schedsave="' + m.id +
      '">Save</button>' +
      '<button class="bc-btn" data-schedcancel="' + m.id + '">Cancel</button>' +
      '</div>' +
      '<div class="bc-match-acts">' + acts.join('') +
      '<a class="bc-btn" href="/admin/control?match=' + m.id + '">Desk &rarr;</a>' +
      '</div></article>';
  }

  function render() {
    var list = $('matchList');
    list.innerHTML = matches.map(matchCard).join('');
    $('matchEmpty').classList.toggle('hidden', matches.length > 0);
    list.querySelectorAll('[data-checkin]').forEach(function (b) {
      b.addEventListener('click', function () {
        openCheckin(parseInt(b.dataset.checkin, 10));
      });
    });
    list.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = parseInt(b.dataset.del, 10);
        var m = matches.filter(function (x) { return x.id === id; })[0];
        if (!window.confirm('Delete match ' + (m ? m.match_number : id) +
            '? This cannot be undone.')) return;
        BC.post('/api/admin/matches/' + id, { delete: true }).then(function (x) {
          if (x.s === 200 && x.d.ok) { BC.toast('Match deleted'); load(); }
          else BC.toast(x.d.error || 'Delete failed', true);
        });
      });
    });
    list.querySelectorAll('[data-schededit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var row = list.querySelector('[data-sched="' + b.dataset.schededit + '"]');
        row.classList.remove('hidden');
        row.querySelector('input').focus();
      });
    });
    list.querySelectorAll('[data-schedcancel]').forEach(function (b) {
      b.addEventListener('click', function () {
        list.querySelector('[data-sched="' + b.dataset.schedcancel + '"]')
          .classList.add('hidden');
      });
    });
    list.querySelectorAll('[data-schedsave]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.schedsave;
        var val = list.querySelector('[data-schedin="' + id + '"]').value;
        BC.post('/api/admin/matches/' + id + '/schedule',
                { startsAt: val }).then(function (x) {
          if (x.s === 200 && x.d.ok) {
            BC.toast(val ? 'Match time saved' : 'Match time cleared');
            load();
          } else {
            BC.toast(x.d.error || 'Save failed', true);
          }
        });
      });
    });
  }

  /* ---- check-in --------------------------------------------------------- */

  function openCheckin(id) {
    checkinMatch = matches.filter(function (m) { return m.id === id; })[0];
    if (!checkinMatch) return;
    $('checkinTitle').textContent = 'Check-in — Match ' +
      checkinMatch.match_number + ' (' + grp(checkinMatch.group_name) + ')';
    BC.api('/api/admin/matches/' + id).then(function (x) {
      if (x.s !== 200 || !x.d.ok) { BC.toast('Could not load match', true); return; }
      var checked = {};
      x.d.state.teams.forEach(function (t) { checked[t.teamId] = true; });
      var eligible = x.d.eligible || [];
      if (!eligible.length) {
        $('checkinList').innerHTML = '<div class="bc-empty">No approved teams in ' +
          esc(grp(checkinMatch.group_name)) + ' yet &mdash; approve some in the Control Room first.</div>';
      } else {
        $('checkinList').innerHTML = eligible.map(function (t) {
          return '<label class="bc-checkin"><input type="checkbox" value="' +
            esc(t.team_id) + '"' + (checked[t.team_id] ? ' checked' : '') + '>' +
            '<span>' + esc(t.team_name) + ' <b>[' + esc(t.team_tag) + ']</b></span></label>';
        }).join('');
      }
      $('checkinCard').classList.remove('hidden');
      $('checkinCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  $('checkinSave').addEventListener('click', function () {
    if (!checkinMatch) return;
    var ids = [];
    $('checkinList').querySelectorAll('input:checked').forEach(function (c) {
      ids.push(c.value);
    });
    BC.post('/api/admin/matches/' + checkinMatch.id + '/checkin',
            { teamIds: ids }).then(function (x) {
      if (x.s === 200 && x.d.ok) {
        BC.toast(ids.length + ' squads checked in');
        $('checkinCard').classList.add('hidden');
        load();
      } else {
        BC.toast(x.d.error || 'Check-in failed', true);
      }
    });
  });
  $('checkinCancel').addEventListener('click', function () {
    $('checkinCard').classList.add('hidden');
  });

  /* ---- create ----------------------------------------------------------- */

  $('createForm').addEventListener('submit', function (e) {
    e.preventDefault();
    BC.post('/api/admin/matches', {
      group: $('newGroup').value,
      map: $('newMap').value,
      notes: $('newNotes').value,
      startsAt: $('newStarts').value
    }).then(function (x) {
      if (x.s === 200 && x.d.ok) {
        var n = x.d.state.match.match_number;
        BC.toast('Match ' + n + ' created');
        $('newNotes').value = '';
        $('newStarts').value = '';
        var newId = x.d.state.match.id;
        load().then(function () { openCheckin(newId); });
      } else {
        BC.toast(x.d.error || 'Create failed', true);
      }
    });
  });

  /* ---- scoring rules ---------------------------------------------------- */

  var TIE_LABELS = {
    'wins': '1st places',
    'placement_points': 'placement points',
    'finish_points': 'finish points',
    'last_placement': 'last-match placement'
  };
  var tiebreakers = [];

  function renderTiebreakers() {
    var row = $('tbRow');
    row.innerHTML = tiebreakers.map(function (k, i) {
      var label = esc(TIE_LABELS[k] || k);
      return '<span class="bc-tb">' + (i + 1) + '. ' + label +
        '<button type="button" class="bc-tb-x" data-tb="' + k +
        '" data-move="up" title="Move up" aria-label="Move ' + label +
        ' up">&uarr;</button>' +
        '<button type="button" class="bc-tb-x" data-tb="' + k +
        '" data-move="down" title="Move down" aria-label="Move ' + label +
        ' down">&darr;</button>' +
        '<button type="button" class="bc-tb-x" data-tb="' + k +
        '" data-move="remove" title="Remove" aria-label="Remove ' + label +
        '">&times;</button></span>';
    }).join('') ||
      '<span class="bc-dim">No tie-breakers yet &mdash; add at least one.</span>';
  }

  $('tbRow').addEventListener('click', function (e) {
    var b = e.target.closest('[data-move]');
    if (!b) return;
    var k = b.dataset.tb;
    var i = tiebreakers.indexOf(k);
    if (i < 0) return;
    if (b.dataset.move === 'up' && i > 0) {
      tiebreakers.splice(i, 1);
      tiebreakers.splice(i - 1, 0, k);
    } else if (b.dataset.move === 'down' && i < tiebreakers.length - 1) {
      tiebreakers.splice(i, 1);
      tiebreakers.splice(i + 1, 0, k);
    } else if (b.dataset.move === 'remove') {
      tiebreakers.splice(i, 1);
    }
    renderTiebreakers();
  });

  $('tbAddBtn').addEventListener('click', function () {
    var k = $('tbAdd').value;
    if (tiebreakers.indexOf(k) >= 0) {
      BC.toast('That tie-breaker is already in the list.', true);
      return;
    }
    tiebreakers.push(k);
    renderTiebreakers();
  });

  function loadRules() {
    BC.api('/api/admin/scoring-rules').then(function (x) {
      if (x.s !== 200 || !x.d.ok) return;
      $('killPoints').value = x.d.rules.kill_points;
      var row = $('placementRow');
      row.innerHTML = '';
      for (var p = 1; p <= 8; p++) {
        var div = document.createElement('div');
        div.innerHTML = '<label class="bc-label">P' + p + '</label>' +
          '<input class="bc-input bc-input--mini" type="number" min="0" max="100" ' +
          'data-pos="' + p + '" value="' + x.d.rules.placement[p] + '">';
        row.appendChild(div);
      }
      tiebreakers = (x.d.rules.tiebreakers || []).slice();
      renderTiebreakers();
    });
  }

  $('rulesForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!tiebreakers.length) {
      BC.toast('Keep at least one tie-breaker.', true);
      return;
    }
    var placement = {};
    $('placementRow').querySelectorAll('input').forEach(function (inp) {
      placement[inp.dataset.pos] = { points: parseInt(inp.value, 10) || 0 };
    });
    BC.post('/api/admin/scoring-rules', {
      kill_points: parseInt($('killPoints').value, 10) || 0,
      placement: placement,
      tiebreakers: tiebreakers
    }).then(function (x) {
      if (x.s === 200 && x.d.ok) {
        BC.toast('Scoring rules saved');
        var note = $('rulesNotice');
        note.textContent = 'Saved — live matches re-score and every table ' +
          '(desk, /live, /results, overlays, CSV) follows the new rules.';
        note.className = 'bc-notice bc-notice--ok';
      } else {
        BC.toast(x.d.error || 'Save failed', true);
      }
    });
  });

  /* ---- boot -------------------------------------------------------------- */

  function load() {
    return BC.api('/api/admin/matches').then(function (x) {
      if (x.s !== 200 || !x.d.ok) return;
      matches = x.d.matches;
      groups = x.d.groups;
      var sel = $('newGroup');
      if (sel.options.length !== groups.length) {
        sel.innerHTML = groups.map(function (g) {
          return '<option value="' + esc(g.name) + '">' + esc(g.name) + '</option>';
        }).join('');
      }
      render();
    });
  }

  BC.boot(function () {
    load();
    loadRules();
    BC.live('/api/admin/stream', load);
  });
})();
