/* ==========================================================================
   About — team line-up (tactical dossier cards)
   Edit the TEAM array below to change members.
   Photo lookup is "as named": images/team/<name-lowercased>.png
   (FE_PSYCHO -> images/team/fe_psycho.png). Add `img:` to a member to
   override the path. Missing photo -> initials placeholder in the frame.
   Card chrome (operator number, dossier ref, status rows) is generated;
   per-member copy lives in the TEAM array.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- TEAM CONFIG — edit me ---------------- */
  var PHOTO_DIR = 'images/team/';   /* relative, so it works on any host */
  var PHOTO_EXT = '.png';
  var PHOTO_VER = '?v=2';           /* bump after replacing a portrait file */

  /* dossier flavour rows shown on every card (design copy, not stats) */
  var DOSSIER = { status: 'Active', threat: 'Elite', loyalty: 'Unquestioned' };

  var TEAM = [
    {
      name: 'FE_PSYCHO',
      role: 'Coach',
      ref: '#002-01',
      skills: ['Strategy', 'Analysis', 'Team Play', 'Leadership'],
      dossier: ['Tactical Mind', 'Squad Builder', 'Always a Step Ahead']
    },
    {
      name: 'FE_KANNU',
      role: 'Assaulter',
      ref: '#002-02',
      skills: ['Rush', 'Fragging', 'Positioning', 'Team Fight'],
      dossier: ['Aggressive Entry', 'High Impact', 'Built for the Last Zone']
    }
  ];
  /* ------------------------------------------------------ */

  function photoSrc(m) {
    return m.img || PHOTO_DIR + String(m.name).toLowerCase() + PHOTO_EXT + PHOTO_VER;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* FE_PSYCHO -> "FP" */
  function initials(name) {
    var parts = String(name || '').split(/[\s_-]+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function cardHtml(m, i) {
    var ini = esc(initials(m.name));
    var num = (i + 1 < 10 ? '0' : '') + (i + 1);
    var skills = (m.skills || []).map(function (s) {
      return '<li>' + esc(s) + '</li>';
    }).join('');
    var dossier = (m.dossier || []).map(function (s) {
      return esc(s);
    }).join('<i aria-hidden="true">|</i>');
    return '<article class="ab-op">' +
      '<span class="ab-corner ab-corner-tl" aria-hidden="true"></span>' +
      '<span class="ab-corner ab-corner-tr" aria-hidden="true"></span>' +
      '<span class="ab-corner ab-corner-bl" aria-hidden="true"></span>' +
      '<span class="ab-corner ab-corner-br" aria-hidden="true"></span>' +
      '<div class="ab-op-body">' +
        '<div class="ab-col ab-col-left">' +
          '<p class="ab-op-id">Operator <b>' + num + '</b></p>' +
          '<p class="ab-op-meta">Squad dossier<br>Field record<br>' + esc(m.ref || '') + '</p>' +
          '<p class="ab-op-skills-label">Skills</p>' +
          '<ul class="ab-op-skills">' + skills + '</ul>' +
          '<span class="ab-slash" aria-hidden="true">///</span>' +
        '</div>' +
        '<div class="ab-op-mid">' +
          '<div class="ab-frame">' +
            '<img src="' + esc(photoSrc(m)) + '" alt="' + esc(m.name) + '">' +
            '<div class="ab-initials" aria-hidden="true">' + ini + '</div>' +
          '</div>' +
          '<h3 class="ab-name">' + esc(m.name) + '</h3>' +
          '<span class="ab-role">' + esc(m.role) + '</span>' +
        '</div>' +
        '<div class="ab-col ab-col-right">' +
          '<span class="ab-barcode" aria-hidden="true"></span>' +
          '<p class="ab-stat"><span>Status</span><b class="ab-lime">' + esc(DOSSIER.status) + '</b></p>' +
          '<span class="ab-rule" aria-hidden="true"></span>' +
          '<p class="ab-stat"><span>Threat level</span><b class="ab-red">' + esc(DOSSIER.threat) + '</b></p>' +
          '<span class="ab-bars" aria-hidden="true"></span>' +
          '<span class="ab-rule" aria-hidden="true"></span>' +
          '<p class="ab-stat"><span>Loyalty</span><b>' + esc(DOSSIER.loyalty) + '</b></p>' +
        '</div>' +
      '</div>' +
      '<p class="ab-op-foot">' +
        '<span class="ab-op-foot-text">' + dossier + '</span>' +
        '<span class="ab-slash" aria-hidden="true">///</span>' +
      '</p>' +
      '</article>';
  }

  function render() {
    var grid = document.getElementById('teamGrid');
    if (!grid) return;
    grid.innerHTML = TEAM.map(cardHtml).join('');
    grid.querySelectorAll('img').forEach(function (img) {
      img.addEventListener('error', function () { img.classList.add('failed'); });
      /* already failed before the listener attached (cached 404) */
      if (img.complete && img.naturalWidth === 0) img.classList.add('failed');
    });
  }

  /* ---- navbar: scrolled backdrop + mobile drawer (theme behaviour) -------- */

  var navbar = document.getElementById('navbar');
  function handleNavScroll() {
    if (navbar) navbar.classList.toggle('scrolled', window.scrollY > 60);
  }
  window.addEventListener('scroll', handleNavScroll, { passive: true });
  handleNavScroll();

  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');
  var navOverlay = document.getElementById('navOverlay');

  function closeNav() {
    if (!navToggle) return;
    navToggle.classList.remove('active');
    if (navLinks) navLinks.classList.remove('open');
    if (navOverlay) navOverlay.classList.add('hidden');
  }

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', function () {
      if (navLinks.classList.contains('open')) {
        closeNav();
      } else {
        navToggle.classList.add('active');
        navLinks.classList.add('open');
        if (navOverlay) navOverlay.classList.remove('hidden');
      }
    });
    if (navOverlay) navOverlay.addEventListener('click', closeNav);
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', closeNav);
    });
  }

  render();
})();
