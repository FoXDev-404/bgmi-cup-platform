/* Public live board: current match + points + alive. Read-only, no PII.
   Consumes /api/live/state (sanitized payload shared with overlays). */
(function () {
  var matchEl = document.getElementById('match');
  var aliveEl = document.getElementById('alive');
  var ptsEl = document.getElementById('pts');
  var matchesEl = document.getElementById('matches');
  var connEl = document.getElementById('conn');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderMatch(m, teams) {
    if (!m) { matchEl.innerHTML = '<p class="muted">No match on the board yet.</p>'; return; }
    var h = '<p class="stamp" style="color:var(--' +
      (m.status === 'live' ? 'red' : 'acid') + ')">' + esc((m.status || '').replace(/_/g, ' ')) + '</p>';
    h += '<h2 style="font-family:Anton,sans-serif;text-transform:uppercase;margin:4px 0">' + esc(m.map || '') + '</h2>';
    h += '<p class="muted mono">Match #' + esc(m.match_number) + ' · Group ' + esc(m.group_name || '—') + '</p>';
    if (m.status === 'published') {
      h += '<p>Finished at ' + esc((m.published_at || '').slice(11, 16) || '—') + ' · see <a href="/results" style="color:var(--acid)">results</a>.</p>';
    } else {
      h += '<p>' + (teams || []).length + ' squads in this lobby.</p>';
    }
    matchEl.innerHTML = h;
  }

  function renderAlive(state) {
    var total = (state.teams || []).length;
    if (!total) { aliveEl.innerHTML = '—'; return; }
    aliveEl.innerHTML = '<p style="font-family:Anton,sans-serif;font-size:42px;color:var(--acid);line-height:1">' +
      state.teamsAlive + '<span class="muted" style="font-size:20px">/' + total + '</span></p>' +
      '<p class="muted">squads still standing</p>';
  }

  function renderPoints(rows) {
    if (!rows.length) { ptsEl.innerHTML = '<tr><td colspan="6" class="muted">Nothing yet.</td></tr>'; return; }
    ptsEl.innerHTML = rows.slice(0, 12).map(function (r) {
      return '<tr><td class="mono muted">' + (r.rank || '') + '</td>' +
        '<td><b>' + esc(r.teamName) + '</b></td>' +
        '<td class="mono">' + r.matches + '</td>' +
        '<td class="mono">' + r.kills + '</td>' +
        '<td class="mono">' + r.placementPoints + '</td>' +
        '<td class="mono" style="color:var(--acid)"><b>' + r.points + '</b></td></tr>';
    }).join('');
  }

  function renderMatches(ms) {
    if (!ms.length) { matchesEl.innerHTML = '<li class="muted">No matches yet.</li>'; return; }
    matchesEl.innerHTML = ms.map(function (m) {
      var winner = (m.results || [])[0];
      return '<li><span class="stamp" style="color:var(--acid)">done</span> <b>' +
        esc(m.map) + '</b> #' + m.matchNumber +
        (winner ? ' · ' + esc(winner.teamName) : '') + '</li>';
    }).join('');
  }

  function tick() {
    return fetch('/api/live/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        renderMatch(s.match, s.teams);
        renderAlive(s);
        renderPoints(s.overall || []);
        renderMatches(s.recentMatches || []);
        connEl.textContent = 'Last updated ' + new Date().toLocaleTimeString();
      })
      .catch(function () { connEl.textContent = 'Connection lost, retrying…'; });
  }

  if ('EventSource' in window) {
    var es = new EventSource('/api/live/stream');
    es.onmessage = tick;
    es.onerror = function () { connEl.textContent = 'Reconnecting…'; };
  }
  tick();
  setInterval(tick, 8000); // polling fallback + freshness
})();
