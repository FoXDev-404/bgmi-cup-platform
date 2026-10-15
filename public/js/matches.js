/* Matches page — create matches, check in lineups, edit scoring rules. */
(function () {
  'use strict';
  var esc = BC.esc;
  var matches = [];
  var groups = [];
  var checkinMatch = null;   // match currently open in the check-in drawer

  var $ = function (id) { return document.getElementById(id); };

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
    return '<article class="bc-match">' +
      '<div class="bc-match-n">Match ' + m.match_number + '</div>' +
      '<div class="bc-match-meta">Group ' + esc(m.group_name) + ' &middot; ' +
      esc(m.map) + ' &middot; ' + m.team_count + ' squads &middot; ' +
      m.placed_count + '/' + m.team_count + ' placed</div>' +
      statusStamp(m.status) +
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
  }

  /* ---- check-in --------------------------------------------------------- */

  function openCheckin(id) {
    checkinMatch = matches.filter(function (m) { return m.id === id; })[0];
    if (!checkinMatch) return;
    $('checkinTitle').textContent = 'Check-in — Match ' +
      checkinMatch.match_number + ' (Group ' + checkinMatch.group_name + ')';
    BC.api('/api/admin/matches/' + id).then(function (x) {
      if (x.s !== 200 || !x.d.ok) { BC.toast('Could not load match', true); return; }
      var checked = {};
      x.d.state.teams.forEach(function (t) { checked[t.teamId] = true; });
      var eligible = x.d.eligible || [];
      if (!eligible.length) {
        $('checkinList').innerHTML = '<div class="bc-empty">No approved teams in group ' +
          esc(checkinMatch.group_name) + ' yet &mdash; approve some in the Control Room first.</div>';
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
      notes: $('newNotes').value
    }).then(function (x) {
      if (x.s === 200 && x.d.ok) {
        var n = x.d.state.match.match_number;
        BC.toast('Match ' + n + ' created');
        $('newNotes').value = '';
        load();
        openCheckin(x.d.state.match.id);
      } else {
        BC.toast(x.d.error || 'Create failed', true);
      }
    });
  });

  /* ---- scoring rules ---------------------------------------------------- */

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
    });
  }

  $('rulesForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var placement = {};
    $('placementRow').querySelectorAll('input').forEach(function (inp) {
      placement[inp.dataset.pos] = { points: parseInt(inp.value, 10) || 0 };
    });
    BC.post('/api/admin/scoring-rules', {
      kill_points: parseInt($('killPoints').value, 10) || 0,
      placement: placement
    }).then(function (x) {
      if (x.s === 200 && x.d.ok) {
        BC.toast('Scoring rules saved');
        var note = $('rulesNotice');
        note.textContent = 'Saved — live matches re-score instantly.';
        note.className = 'bc-notice bc-notice--ok';
      } else {
        BC.toast(x.d.error || 'Save failed', true);
      }
    });
  });

  /* ---- boot -------------------------------------------------------------- */

  function load() {
    BC.api('/api/admin/matches').then(function (x) {
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
