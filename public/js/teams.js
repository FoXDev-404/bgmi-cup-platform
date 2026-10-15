/* Approved teams feed — names/tags/logos only, nothing else ever. */
(function () {
  'use strict';

  /* HTML-escape everything that came from the server before it goes
     anywhere near innerHTML (logos are additionally restricted to the
     /uploads/ path the server itself generates) */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var grid = document.getElementById('tmGrid');
  if (!grid) return;
  var controls = document.getElementById('tmControls');
  var searchInput = document.getElementById('tmSearch');
  var filterSel = document.getElementById('tmFilter');
  var countEl = document.getElementById('tmCount');
  var emptyEl = document.getElementById('tmEmpty');
  var teams = [];

  function card(t) {
    var logo;
    if (t.logo_path && String(t.logo_path).indexOf('/uploads/') === 0) {
      logo = '<img class="tm-logo" src="' + esc(t.logo_path) +
             '" alt="' + esc(t.team_name) + ' logo" loading="lazy">';
    } else {
      logo = '<span class="tm-logo tm-logo--ph" aria-hidden="true">' +
             esc(t.team_tag) + '</span>';
    }
    return '<article class="tm-card">' + logo +
      '<div class="tm-info"><h2>' + esc(t.team_name) + '</h2>' +
      '<span class="tm-tag">[' + esc(t.team_tag) + ']</span>' +
      (t.group_name ? '<p class="tm-group">' + esc(t.group_name) + '</p>' : '') +
      '</div></article>';
  }

  function render() {
    var q = (searchInput.value || '').trim().toLowerCase();
    var grp = filterSel.value;
    var list = teams.filter(function (t) {
      if (grp && (t.group_name || '') !== grp) return false;
      if (!q) return true;
      return (t.team_name || '').toLowerCase().indexOf(q) !== -1 ||
             (t.team_tag || '').toLowerCase().indexOf(q) !== -1;
    });
    grid.innerHTML = list.map(card).join('');
    if (list.length === 0 && teams.length > 0) {
      emptyEl.textContent = 'No teams match that search.';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
    }
    countEl.textContent = teams.length
      ? list.length + ' / ' + teams.length + ' team' +
        (teams.length === 1 ? '' : 's') +
        (q || grp ? ' shown' : ' published')
      : '';
  }

  searchInput.addEventListener('input', render);
  filterSel.addEventListener('change', render);

  fetch('/api/public/approved').then(function (r) {
    return r.json().then(function (d) { return { s: r.status, d: d }; });
  }).then(function (x) {
    if (x.s !== 200 || !x.d.ok) {
      document.getElementById('tmOff').classList.remove('hidden');
      return;
    }
    if (!x.d.teams.length) {
      emptyEl.textContent = 'No teams approved yet — check back after registrations close.';
      emptyEl.classList.remove('hidden');
      return;
    }
    teams = x.d.teams;
    /* group options built from what actually exists, never trusted raw */
    var groups = [];
    teams.forEach(function (t) {
      if (t.group_name && groups.indexOf(t.group_name) === -1) {
        groups.push(t.group_name);
      }
    });
    groups.sort().forEach(function (g) {
      var opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      filterSel.appendChild(opt);
    });
    controls.classList.remove('hidden');
    render();
  }).catch(function () {
    emptyEl.classList.remove('hidden');
  });
})();
