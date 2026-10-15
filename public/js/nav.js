/* Shared navbar behaviour — scrolled backdrop + mobile drawer.
   Loaded by every page that keeps its own inline page logic out of the
   <script> tag (also keeps the site compatible with a strict CSP). */
(function () {
  'use strict';
  var navbar = document.getElementById('navbar');
  if (!navbar) return;
  function handleNavScroll() {
    navbar.classList.toggle('scrolled', window.scrollY > 60);
  }
  window.addEventListener('scroll', handleNavScroll, { passive: true });
  handleNavScroll();

  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');
  var navOverlay = document.getElementById('navOverlay');
  if (!navToggle || !navLinks) return;
  function closeNav() {
    navToggle.classList.remove('active');
    navLinks.classList.remove('open');
    if (navOverlay) navOverlay.classList.add('hidden');
  }
  navToggle.addEventListener('click', function () {
    if (navLinks.classList.contains('open')) { closeNav(); }
    else {
      navToggle.classList.add('active');
      navLinks.classList.add('open');
      if (navOverlay) navOverlay.classList.remove('hidden');
    }
  });
  if (navOverlay) navOverlay.addEventListener('click', closeNav);
  navLinks.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', closeNav);
  });
})();
