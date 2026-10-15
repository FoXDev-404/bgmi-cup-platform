/* Shared bootstrap for the broadcast admin pages (matches / control /
   overlays / caster). Boots the session like panel.js does, provides the
   api() helper with the CSRF header, a toast, and a live channel that uses
   Server-Sent Events with a 2-second polling fallback. */
(function (global) {
  'use strict';

  var BC = global.BC = { csrf: '', user: '' };

  BC.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  BC.api = function (path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if ((opts.method || 'GET').toUpperCase() !== 'GET' && BC.csrf) {
      headers['X-Admin-CSRF'] = BC.csrf;
    }
    opts.headers = headers;
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { location.href = '/admin'; throw new Error('signed out'); }
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    });
  };

  BC.post = function (path, body) {
    return BC.api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  };

  BC.toast = function (msg, bad) {
    var el = document.getElementById('bcToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bcToast';
      el.className = 'bc-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('bc-toast--bad', !!bad);
    el.classList.add('bc-toast--show');
    clearTimeout(BC._toastT);
    BC._toastT = setTimeout(function () {
      el.classList.remove('bc-toast--show');
    }, 3200);
  };

  BC.fmtClock = function (iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
      if (isNaN(d)) return iso;
      return d.toLocaleString(undefined, {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return iso; }
  };

  BC.fmtTime = function (iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d)) return iso;
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) { return iso; }
  };

  /* ---- live channel: SSE first, 2s polling fallback ---------------------- */
  BC.live = function (streamPath, onChange) {
    var closed = false;
    var poll = null;

    function startPolling() {
      if (closed || poll) return;
      poll = setInterval(function () { onChange(); }, 2000);
    }
    function stopPolling() {
      if (poll) { clearInterval(poll); poll = null; }
    }

    if (global.EventSource) {
      var es = new EventSource(streamPath);
      es.onmessage = function () { if (!closed) onChange(); };
      es.onopen = function () { stopPolling(); };
      es.onerror = function () {
        /* SSE drops (server restart, proxy) — poll until it comes back */
        startPolling();
      };
      BC._es = es;
    } else {
      startPolling();
    }
    return {
      close: function () {
        closed = true;
        stopPolling();
        if (BC._es) { BC._es.close(); BC._es = null; }
      }
    };
  };

  /* ---- boot -------------------------------------------------------------- */
  BC.boot = function (onReady) {
    BC.api('/api/admin/me').then(function (x) {
      if (x.s !== 200 || !x.d.ok) { location.href = '/admin'; return; }
      BC.csrf = x.d.csrf;
      BC.user = x.d.username;
      var who = document.getElementById('whoAmI');
      if (who) who.textContent = BC.user;
      if (onReady) onReady();
    }).catch(function () { location.href = '/admin'; });

    var logout = function (e) {
      if (e) e.preventDefault();
      BC.post('/api/admin/logout').then(function () {
        location.href = '/admin';
      });
    };
    var lb = document.getElementById('logoutBtn');
    if (lb) lb.addEventListener('click', logout);
    var ln = document.getElementById('logoutNavBtn');
    if (ln) ln.addEventListener('click', logout);
  };
})(window);
