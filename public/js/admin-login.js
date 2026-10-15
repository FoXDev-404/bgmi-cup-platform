/* Admin sign-in form (the Control Room gate). */
(function () {
  'use strict';
  var form = document.getElementById('loginForm');
  if (!form) return;
  var err = document.getElementById('loginError');
  var btn = document.getElementById('loginBtn');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('loginUser').value.trim(),
        password: document.getElementById('loginPass').value
      })
    })
      .then(function (r) {
        return r.json().then(function (d) { return { s: r.status, d: d }; });
      })
      .then(function (x) {
        if (x.s === 200 && x.d.ok) {
          location.href = '/admin';
        } else {
          err.textContent = x.d.error || 'Sign-in failed.';
          btn.disabled = false;
          btn.textContent = 'Sign in';
        }
      })
      .catch(function () {
        err.textContent = 'Network hiccup — try again.';
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
  });
})();
