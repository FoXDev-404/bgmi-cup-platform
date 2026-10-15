/* Overlay shell — one page, 11 scenes. The scene name comes from the URL
   path (/overlay/<name>), the token from the query string. Transparent
   1920x1080 stage for OBS; SSE with polling fallback; honours the producer's
   on/off switch and prefers-reduced-motion (see overlay.css). */
(function () {
  'use strict';

  var name = (location.pathname.split('/').pop() || '').toLowerCase();
  var token = (new URLSearchParams(location.search)).get('token') || '';
  var root = document.getElementById('scene');
  var lastElimId = null; // only re-trigger the popup animation on new events

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function logo(src, cls, w) {
    if (!src) return '';
    var h = w ? ' width="' + w + '" height="' + w + '"' : '';
    return '<img class="ov-logo ' + cls + '" src="' + esc(src) + '"' + h + ' alt="">';
  }

  /* ---------- scene renderers: each returns HTML for #scene ---------- */
  var scenes = {

    /* Left-rail points board for the current match. */
    'live-leaderboard': function (s) {
      var d = s.data, m = d.match;
      var rows = (d.teams || []).map(function (t, i) {
        var cls = 'olb-row' + (i === 0 ? ' is-top' : '') +
          (t.out > 0 && t.alive === 0 && t.knocked === 0 ? ' is-out' : '');
        return '<div class="' + cls + '">' +
          '<span class="olb-rank">' + (t.placement || i + 1) + '</span>' +
          '<span class="olb-name">' + esc(t.teamName) + '</span>' +
          '<span class="olb-k">' + t.kills + 'K</span>' +
          '<span class="olb-p">' + t.points + '</span></div>';
      }).join('');
      return '<div class="ov-live-leaderboard">' +
        '<div class="ov-head"><span class="ov-kicker">' +
        (d.live ? '● Live · ' : '') + esc(m ? 'Match ' + m.number : 'Standings') +
        '</span><div class="ov-title">Points</div></div>' +
        (rows || '<div class="ov-card" style="padding:20px">Waiting for the lobby…</div>') +
        '</div>';
    },

    /* Big counter of squads still standing + tag chips. */
    'teams-alive': function (s) {
      var d = s.data;
      var chips = (d.teams || []).map(function (t) {
        var cls = t.alive || t.knocked ? (t.knocked && !t.alive ? 'knocked' : 'alive') : 'out';
        return '<span class="ta-chip ' + cls + '">' + esc(t.teamTag) + '</span>';
      }).join('');
      return '<div class="ov-teams-alive">' +
        '<div class="ta-count">' + d.teamsAlive + '</div>' +
        '<div class="ta-sub">Squads alive</div>' +
        '<div class="ta-chips">' + chips + '</div></div>';
    },

    /* Bottom strip: one chip per squad, dots for players. */
    'team-status-strip': function (s) {
      var d = s.data;
      var rows = (d.teams || []).map(function (t) {
        var cls = 'tss-team ' + (t.alive ? '' : (t.knocked ? 'knocked' : 'out'));
        var dots = [];
        for (var i = 0; i < t.alive; i++) dots.push('●');
        for (var j = 0; j < t.knocked; j++) dots.push('◐');
        return '<div class="' + cls + '">' +
          logo(t.logo, 'tss-logo', 40) +
          '<span class="tss-tag">' + esc(t.teamTag) + '</span>' +
          '<span class="tss-dots">' + dots.join(' ') + '</span></div>';
      }).join('');
      return '<div class="ov-team-status-strip">' + rows + '</div>';
    },

    /* Slide-in popup for the latest elimination (re-arms on new event id). */
    'elimination-popup': function (s) {
      var e = s.data.lastElimination;
      if (!e || e.undone || String(e.id) === lastElimId) return '';
      lastElimId = String(e.id);
      return '<div class="ov-elimination-popup"><div class="ep-card">' +
        '<span class="ep-icon">☠</span><div>' +
        '<div class="ep-kicker">Squad eliminated</div>' +
        '<div class="ep-text">' + esc(e.description) + '</div>' +
        '</div></div></div>';
    },

    /* Full results board of the last published match. */
    'match-results': function (s) {
      var d = s.data;
      var rows = (d.results || []).map(function (r, i) {
        return '<div class="mr-row' + (i === 0 ? ' win' : '') + '">' +
          '<span class="mr-place">' + r.placement + 'º</span>' +
          logo(r.logo, '', 52) +
          '<span class="mr-name">' + esc(r.teamName) + '</span>' +
          '<span class="mr-num">' + r.kills + ' K</span>' +
          '<span class="mr-num">' + r.placement + 'º</span>' +
          '<span class="mr-num mr-pts">' + r.points + ' pts</span></div>';
      }).join('');
      return '<div class="ov-match-results">' +
        '<span class="ov-kicker">' + esc(d.match ? 'Match ' + d.match.matchNumber + ' · ' + d.match.map : 'Results') + '</span>' +
        '<div class="ov-title">Match results</div>' +
        (rows || '<p class="ov-kicker">No published results yet.</p>') + '</div>';
    },

    /* Overall standings, two columns of up to 16. */
    'overall-standings': function (s) {
      var rows = (s.data.rows || []).map(function (r, i) {
        return '<div class="os-row' + (i < 3 ? ' top3' : '') + '">' +
          '<span class="os-rank">' + r.rank + '</span>' +
          '<span class="os-name">' + esc(r.teamName) + '</span>' +
          '<span class="os-num">' + r.wins + 'W</span>' +
          '<span class="os-num">' + r.kills + 'K</span>' +
          '<span class="os-num os-pts">' + r.points + ' pts</span></div>';
      }).join('');
      return '<div class="ov-overall-standings">' +
        '<span class="ov-kicker">BGMI Champions Cup</span>' +
        '<div class="ov-title">Overall standings</div>' +
        '<div class="os-grid">' + (rows || '<p class="ov-kicker">No results yet.</p>') + '</div></div>';
    },

    /* Center-stage team slam (producer pins a team from the overlays page). */
    'team-intro': function (s) {
      var t = s.data.team;
      if (!t) return '';
      var roster = (t.roster || []).map(function (n) {
        return '<span class="ti-player">' + esc(n) + '</span>';
      }).join('');
      return '<div class="ov-team-intro"><div class="ti-box">' +
        logo(t.logo, 'ti-logo', 260) +
        '<div class="ti-name">' + esc(t.teamName) + '</div>' +
        '<div class="ti-tag">' + esc(t.teamTag) + ' · ' + esc(t.group) + '</div>' +
        '<div class="ti-roster">' + roster + '</div></div></div>';
    },

    /* Winner hero card for the last published match. */
    'chicken-dinner': function (s) {
      var d = s.data, w = d.winner;
      if (!w) return '';
      var mvp = d.mvp ? '<div class="cd-mvp">MVP · ' + esc(d.mvp.player) + ' · ' +
        d.mvp.kills + 'K / ' + d.mvp.damage + ' DMG</div>' : '';
      return '<div class="ov-chicken-dinner"><div class="cd-box">' +
        '<div class="cd-kicker">Winner winner…</div>' +
        '<div class="cd-win">Chicken dinner!</div>' +
        '<div class="cd-sub">' + esc(w.teamName) + ' [' + esc(w.teamTag) + '] · ' +
        esc(d.match ? 'Match ' + d.match.matchNumber : '') + '</div>' + mvp +
        '</div></div>';
    },

    /* Lower-third player card: caster push (90s) or auto match MVP. */
    'mvp-card': function (s) {
      var c = s.data.card;
      if (!c) return '';
      return '<div class="ov-mvp-card"><div class="mvp-card">' +
        logo(c.logo, '', 72) +
        '<div><div class="mvp-kicker">' +
        (s.data.mode === 'caster' ? 'Caster pick' : 'Match MVP') + '</div>' +
        '<div class="mvp-name">' + esc(c.player) + '</div>' +
        '<div class="mvp-team">' + esc(c.teamName || c.teamTag || '') + '</div></div>' +
        '<div class="mvp-stats"><b>' + c.kills + '</b> K<br>' + c.damage + ' DMG</div>' +
        '</div></div>';
    },

    /* Full-screen break card. */
    'break-screen': function (s) {
      var d = s.data;
      var next = d.match ? '<div class="br-next">Next · Match ' + d.match.number +
        ' · ' + esc(d.match.map) + (d.match.group ? ' · Group ' + esc(d.match.group) : '') + '</div>' : '';
      var sponsor = d.sponsor ? '<div class="br-sponsor">' + esc(d.sponsor) + '</div>' : '';
      return '<div class="ov-break-screen"><div class="br-box">' +
        '<div class="br-title">We&apos;ll be <em>right back</em></div>' +
        '<div class="br-sub">BGMI Champions Cup</div>' + sponsor + next +
        '</div></div>';
    },

    /* Small persistent corner bug. */
    'sponsor-bug': function (s) {
      var d = s.data;
      if (!d.sponsor && !d.logo) return '';
      return '<div class="ov-sponsor-bug"><div class="sb-box">' +
        logo(d.logo, 'sb-logo', 48) +
        (d.sponsor ? '<span class="sb-text">' + esc(d.sponsor) + '</span>' : '') +
        '</div></div>';
    }
  };

  /* ---------- fetch + render loop ---------- */
  function render(s) {
    document.documentElement.style.setProperty('--accent', s.themeColor || '#b6ff3e');
    var fn = scenes[s.name] || scenes[name];
    root.innerHTML = (s.disabled || !fn) ? '' : fn(s);
  }

  function tick() {
    return fetch('/api/overlay/state/' + name + '?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(render)
      .catch(function () { /* token revoked or server down: keep last frame */ });
  }

  if ('EventSource' in window) {
    var es = new EventSource('/api/overlay/stream/' + name + '?token=' + encodeURIComponent(token));
    es.onmessage = tick;
  }
  tick();
  setInterval(tick, 10000); // polling fallback + elimination-popup staleness
})();
