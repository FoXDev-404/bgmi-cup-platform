/* Caster dashboard — live standings, alive counts, event timeline, stat cards.
   Reads the public live state (same PII-free payload overlays get) plus the
   admin SSE channel, so casters and overlays always agree. */
(function () {
  'use strict';
  var esc = BC.esc;
  var $ = function (id) { return document.getElementById(id); };

  function load() {
    BC.api('/api/live/state').then(function (x) {
      if (x.s !== 200 || !x.d.ok) return;
      var d = x.d;
      var m = d.match;
      $('casterMatch').textContent = m
        ? 'Match ' + m.match_number + ' — Group ' + m.group_name + ' · ' + m.map
        : 'No matches yet';
      var live = m && m.status === 'live';
      $('casterStatus').textContent = m ? (m.status || '').replace(/_/g, ' ') : '—';
      $('casterStatus').className = 'bc-stamp' +
        (live ? ' bc-stamp--live' : (m && m.status === 'published' ? ' bc-stamp--done' : ''));

      var total = d.teams.length;
      $('casterAlive').textContent = d.teamsAlive + '/' + total;

      $('casterStandings').innerHTML = d.teams.map(function (t, i) {
        var aliveTxt = t.alive + 'A ' + t.knocked + 'K ' + t.out + 'O';
        return '<tr><td>' + (t.placement || '—') + '</td>' +
          '<td>' + esc(t.teamName) + ' [' + esc(t.teamTag) + ']</td>' +
          '<td>' + esc(t.group) + '</td>' +
          '<td>' + aliveTxt + '</td>' +
          '<td>' + t.kills + '</td>' +
          '<td><b>' + t.points + '</b></td></tr>';
      }).join('') || '<tr><td colspan="6">No squads in the lobby.</td></tr>';

      /* stat cards: every player of the current lobby, pushable */
      var cards = [];
      d.teams.forEach(function (t) {
        (t.players || []).forEach(function (p) {
          cards.push({ t: t, p: p });
        });
      });
      cards.sort(function (a, b) { return b.p.kills - a.p.kills || b.p.damage - a.p.damage; });
      $('casterCards').innerHTML = cards.map(function (c) {
        return '<article class="bc-statcard">' +
          '<span class="bc-statcard-team">' + esc(c.t.teamTag) + ' · ' +
          esc(c.p.status) + '</span>' +
          '<span class="bc-statcard-name">' + esc(c.p.name) + '</span>' +
          '<span class="bc-statcard-stats">' + c.p.kills + ' frags · ' +
          c.p.damage + ' dmg</span>' +
          '<button class="bc-btn" data-push="' + encodeURIComponent(JSON.stringify({
            player: c.p.name, teamName: c.t.teamName, teamTag: c.t.teamTag,
            logo: c.t.logo, group: c.t.group, kills: c.p.kills,
            damage: c.p.damage, status: c.p.status
          })) + '" style="margin-top:6px;">Push to overlay</button>' +
          '</article>';
      }).join('') || '<div class="bc-empty">No players yet.</div>';
      $('casterCards').querySelectorAll('[data-push]').forEach(function (b) {
        b.addEventListener('click', function () {
          var card = JSON.parse(decodeURIComponent(b.dataset.push));
          BC.post('/api/admin/overlay-settings', { pushedCard: card }).then(function (r) {
            if (r.s === 200 && r.d.ok) BC.toast('Card pushed to mvp-card overlay');
            else BC.toast(r.d.error || 'Push failed', true);
          });
        });
      });

      /* event timeline */
      $('casterTimeline').innerHTML = (d.events || []).map(function (e) {
        return '<li class="' + (e.undone ? 'bc-ev-undone' : '') + '"><time>' +
          esc(String(e.at).slice(-8)) + '</time><span>' +
          esc(e.description) + '</span></li>';
      }).join('') || '<li><span>Nothing yet.</span></li>';

      /* top fraggers */
      $('casterFraggers').innerHTML = (d.leaders || []).slice(0, 10).map(function (f) {
        return '<tr><td>' + esc(f.player) + '</td><td>' + esc(f.teamTag) +
          '</td><td>' + f.kills + '</td></tr>';
      }).join('') || '<tr><td colspan="3">No frags yet.</td></tr>';
    });
  }

  BC.boot(function () {
    load();
    BC.live('/api/live/stream', load);
  });
})();
