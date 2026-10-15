/* Public results: overall standings, group tables, match results, top fraggers. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function rowCells(r, withGroup) {
    return '<td>' + (r.rank || '') + '</td>' +
      '<td class="bc-team">' + esc(r.teamName) + '</td>' +
      (withGroup ? '<td>' + esc(r.group || '&mdash;') + '</td>' : '') +
      '<td>' + r.matches + '</td>' +
      (withGroup ? '<td>' + r.wins + '</td>' : '') +
      '<td>' + r.kills + '</td>' +
      '<td>' + r.placementPoints + '</td>' +
      '<td class="bc-pts">' + r.points + '</td>';
  }

  function render(state) {
    var standings = document.getElementById('standings');
    var empty = document.getElementById('empty');
    var groupsEl = document.getElementById('groups');
    var matchesEl = document.getElementById('matches');
    var noMatches = document.getElementById('noMatches');
    var fragEl = document.getElementById('fraggers');

    var rows = state.overallPublished || [];
    empty.hidden = rows.length > 0;
    standings.innerHTML = rows.map(function (r) {
      return '<tr>' + rowCells(r, true) + '</tr>';
    }).join('');

    groupsEl.innerHTML = (state.groups || []).map(function (g) {
      var body = (g.rows || []).map(function (r) {
        return '<tr>' + rowCells(r, false) + '</tr>';
      }).join('') ||
        '<tr><td colspan="6" class="bc-dim">No results in this group yet.</td></tr>';
      return '<section class="bc-card" style="margin:0">' +
        '<h3 class="bc-h2">' + esc(g.group) + '</h3>' +
        '<table class="bc-table">' +
        '<thead><tr><th>#</th><th>Team</th><th>P</th><th>K</th><th>Pos</th><th>Total</th></tr></thead>' +
        '<tbody>' + body + '</tbody></table></section>';
    }).join('');

    var ms = state.recentMatches || [];
    noMatches.hidden = ms.length > 0;
    matchesEl.innerHTML = ms.map(function (m) {
      var winner = (m.results || [])[0];
      return '<section class="bc-card" style="margin:0">' +
        '<span class="bc-stamp bc-stamp--done">published</span>' +
        '<p class="bc-p">Match #' + m.matchNumber + ' &middot; ' + esc(m.map) +
        (m.group ? ' &middot; ' + esc(m.group) : '') + '</p>' +
        '<h3 class="bc-h2">' + (winner ? '&#127942; ' + esc(winner.teamName)
          : 'Match #' + m.matchNumber) + '</h3>' +
        '<ol class="bc-pl">' + (m.results || []).map(function (r) {
          return '<li><b>' + esc(r.teamName) + '</b> ' + r.placement +
            '&ordm; &middot; ' + r.kills + 'K &middot; ' + r.points + 'pts</li>';
        }).join('') + '</ol></section>';
    }).join('');

    fragEl.innerHTML = (state.leaders || []).slice(0, 10).map(function (p, i) {
      return '<tr><td>' + (i + 1) + '</td>' +
        '<td class="bc-team">' + esc(p.player) + '</td>' +
        '<td>' + esc(p.teamName) + '</td>' +
        '<td class="bc-pts">' + p.kills + '</td>' +
        '<td>' + p.damage + '</td></tr>';
    }).join('') ||
      '<tr><td colspan="5" class="bc-dim">No stats yet.</td></tr>';
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
