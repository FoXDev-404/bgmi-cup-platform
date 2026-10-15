/* Public results: overall standings, group tables, match results, top fraggers. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function rowCells(r, withGroup) {
    return '<td class="mono muted">' + (r.rank || '') + '</td>' +
      '<td><b>' + esc(r.teamName) + '</b></td>' +
      (withGroup ? '<td class="muted">' + esc(r.group || '—') + '</td>' : '') +
      '<td class="mono">' + r.matches + '</td>' +
      (withGroup ? '<td class="mono">' + r.wins + '</td>' : '') +
      '<td class="mono">' + r.kills + '</td>' +
      '<td class="mono">' + r.placementPoints + '</td>' +
      '<td class="mono" style="color:var(--acid)"><b>' + r.points + '</b></td>';
  }

  function render(state) {
    var standings = document.getElementById('standings');
    var empty = document.getElementById('empty');
    var groupsEl = document.getElementById('groups');
    var matchesEl = document.getElementById('matches');
    var fragEl = document.getElementById('fraggers');

    var rows = state.overallPublished || [];
    empty.hidden = rows.length > 0;
    standings.innerHTML = rows.map(function (r) { return '<tr>' + rowCells(r, true) + '</tr>'; }).join('');

    groupsEl.innerHTML = (state.groups || []).map(function (g) {
      var body = (g.rows || []).map(function (r) { return '<tr>' + rowCells(r, false) + '</tr>'; }).join('') ||
        '<tr><td colspan="6" class="muted">No results in this group yet.</td></tr>';
      return '<section class="admcard"><h3>Group ' + esc(g.group) + '</h3>' +
        '<div style="overflow-x:auto"><table class="tbl">' +
        '<thead><tr><th>#</th><th>Team</th><th>P</th><th>K</th><th>Pos</th><th>Total</th></tr></thead>' +
        '<tbody>' + body + '</tbody></table></div></section>';
    }).join('');

    var ms = state.recentMatches || [];
    matchesEl.innerHTML = ms.length ? ms.map(function (m) {
      var winner = (m.results || [])[0];
      return '<section class="admcard matchcard">' +
        '<div class="head"><div>' +
        '<p class="muted mono">Match #' + m.matchNumber + ' · ' + esc(m.map) +
        (m.group ? ' · Group ' + esc(m.group) : '') + '</p>' +
        '<h3>' + (winner ? '🏆 ' + esc(winner.teamName) : 'Match #' + m.matchNumber) + '</h3></div>' +
        '<span class="stamp" style="color:var(--acid)">published</span></div>' +
        '<ol class="pl">' + (m.results || []).slice(0, 8).map(function (r) {
          return '<li><b>' + esc(r.teamName) + '</b> <span class="muted mono">' +
            r.placement + 'º · ' + r.kills + 'K · ' + r.points + 'pts</span></li>';
        }).join('') + '</ol></section>';
    }).join('') : '<p class="muted">No match results published yet.</p>';

    fragEl.innerHTML = (state.leaders || []).slice(0, 10).map(function (p, i) {
      return '<tr><td class="mono muted">' + (i + 1) + '</td>' +
        '<td><b>' + esc(p.player) + '</b></td>' +
        '<td class="muted">' + esc(p.teamName) + '</td>' +
        '<td class="mono" style="color:var(--acid)">' + p.kills + '</td>' +
        '<td class="mono">' + p.damage + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">No stats yet.</td></tr>';
  }

  function tick() {
    return fetch('/api/live/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {});
  }

  if ('EventSource' in window) {
    var es = new EventSource('/api/live/stream');
    es.onmessage = tick;
  }
  tick();
  setInterval(tick, 15000);
})();
