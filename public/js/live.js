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
    if (!m) {
      matchEl.innerHTML = '<p class="bc-p bc-dim">No match on the board yet.</p>';
      return;
    }
    var live = m.status === 'live';
    var h = '<span class="bc-stamp ' + (live ? 'bc-stamp--live' : 'bc-stamp--done') +
      '">' + esc((m.status || '').replace(/_/g, ' ')) + '</span>';
    h += '<p class="bc-title" style="font-size:1.6rem;margin:8px 0 2px">' +
      esc(m.map || '') + '</p>';
    h += '<p class="bc-p">Match #' + esc(m.match_number) + ' &middot; ' +
      esc(m.group_name || '&mdash;') + '</p>';
    if (m.status === 'published') {
      h += '<p class="bc-p">Finished &mdash; see <a href="/results" ' +
        'style="color:var(--acid)">results</a>.</p>';
    } else {
      h += '<p class="bc-p">' + (teams || []).length + ' squads in this lobby.</p>';
    }
    matchEl.innerHTML = h;
  }

  function renderAlive(state) {
    var total = (state.teams || []).length;
    if (!total) { aliveEl.innerHTML = '<p class="bc-p bc-dim">&mdash;</p>'; return; }
    aliveEl.innerHTML = '<p class="bc-big">' + state.teamsAlive +
      '<span>/' + total + '</span></p>' +
      '<p class="bc-p bc-dim">squads still standing</p>';
  }

  function renderPoints(rows) {
    if (!rows.length) {
      ptsEl.innerHTML = '<tr><td colspan="6" class="bc-dim">Nothing yet.</td></tr>';
      return;
    }
    ptsEl.innerHTML = rows.slice(0, 12).map(function (r) {
      return '<tr><td>' + (r.rank || '') + '</td>' +
        '<td class="bc-team">' + esc(r.teamName) + '</td>' +
        '<td>' + r.matches + '</td>' +
        '<td>' + r.kills + '</td>' +
        '<td>' + r.placementPoints + '</td>' +
        '<td class="bc-pts">' + r.points + '</td></tr>';
    }).join('');
  }

  function renderMatches(ms) {
    if (!ms.length) {
      matchesEl.innerHTML = '<li class="bc-p bc-dim">No matches yet.</li>';
      return;
    }
    matchesEl.innerHTML = ms.map(function (m) {
      var winner = (m.results || [])[0];
      return '<li><span class="bc-stamp bc-stamp--done">done</span>' +
        '<b style="font-family:var(--font-display)">' + esc(m.map) + '</b>' +
        '<span class="bc-dim">#' + m.matchNumber +
        (winner ? ' &middot; ' + esc(winner.teamName) : '') + '</span></li>';
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
