/* ==========================================================================
   About — team line-up
   Edit the TEAM array below to change members.
   Photo lookup is "as named": public/team/<name-lowercased>.png
   (FE_PSYCHO -> public/team/fe_psycho.png). Add `img:` to a member to
   override the path. Missing photo -> initials placeholder in the frame.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- TEAM CONFIG — edit me ---------------- */
  var PHOTO_DIR = 'public/team/';   /* relative, so it works on any host */
  var PHOTO_EXT = '.png';

  var TEAM = [
    { name: 'FE_PSYCHO', role: 'Coach' },
    { name: 'FE_SAHIL',  role: 'IGL' },
    { name: 'FE_KANNU',  role: 'Assaulter' }
  ];
  /* ------------------------------------------------------ */

  function photoSrc(m) {
    return m.img || PHOTO_DIR + String(m.name).toLowerCase() + PHOTO_EXT;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* FE_PSYCHO -> "FP", FE_SAHIL -> "FS" */
  function initials(name) {
    var parts = String(name || '').split(/[\s_-]+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function cardHtml(m) {
    var ini = esc(initials(m.name));
    return '<article class="about-card">' +
      '<div class="about-frame">' +
        '<img src="' + esc(photoSrc(m)) + '" alt="' + esc(m.name) + '" loading="lazy">' +
        '<div class="about-initials" aria-hidden="true">' + ini + '</div>' +
      '</div>' +
      '<h2 class="about-name">' + esc(m.name) + '</h2>' +
      '<span class="about-role">' + esc(m.role) + '</span>' +
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
