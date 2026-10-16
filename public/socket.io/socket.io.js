/* socket.io compatibility shim for the original broadcast overlays.
 *
 * The merged server is Python stdlib (no socket.io server), so this tiny
 * adapter re-implements only the API surface the old overlay pages use:
 *   io()            -> { on(event, fn), off(event, fn), emit(...), close() }
 *   'tournament:update'  full legacy public state on every change
 *   'connect'            fired with the first payload
 * It reads the merged server's token-gated endpoints:
 *   GET /api/overlay/state/<scene>?token=…   (JSON snapshot)
 *   GET /api/overlay/stream/<scene>?token=…  (SSE change signals + "hb")
 *
 * SSE is the fast path. The server also sends a named "hb" event at least
 * every ~15 s; a silence watchdog treats ~3 missed heartbeats as a dead
 * stream. That is the OBS failure mode this guards against: proxies (e.g.
 * Railway's edge) can leave a connection open but silently stop delivering
 * data, which never fires an EventSource error. When the watchdog trips it
 * falls back to 2 s state polling AND re-establishes SSE; polling stops as
 * soon as real data/hb arrives, so a healthy stream costs zero extra
 * requests. A 403/404 state fetch means a stale token/scene in this URL, so
 * polling slows to 15 s (with one console warning) instead of hammering.
 */
(function () {
  'use strict';

  var SCENES = ['pre-show', 'stream-start', 'countdown', 'caster', 'format',
    'lineup', 'live', 'chicken-dinner', 'frag-leaders', 'results', 'overall',
    'mvp', 'map-feed', 'intermission', 'technical-difficulties', 'hidden'];

  function sceneFromLocation() {
    try {
      var seg = (location.pathname.split('/').pop() || '')
        .toLowerCase().replace(/\.html$/, '');
      if (SCENES.indexOf(seg) !== -1) return seg;
      var q = new URLSearchParams(location.search).get('scene');
      if (q && SCENES.indexOf(q.toLowerCase()) !== -1) return q.toLowerCase();
    } catch (e) { /* keep the default */ }
    return 'live';
  }

  function createSocket() {
    var HB_SILENCE_MS = 45000;      // ~3 missed heartbeats means the stream died
    var WATCHDOG_MS = 5000;         // how often silence is checked
    var RECONNECT_GAP_MS = 40000;   // throttle forced SSE reconnects
    var POLL_FAST_MS = 2000;        // fallback cadence while SSE is broken
    var POLL_SLOW_MS = 15000;       // rejected token/scene: don't hammer
    try {
      var over = parseInt(window.__overlayHbSilenceMs, 10);  // test hook
      if (over > 0) HB_SILENCE_MS = over;
    } catch (e) { /* keep the default */ }

    var listeners = {};
    var api = {
      on: function (ev, fn) {
        (listeners[ev] = listeners[ev] || []).push(fn);
        return api;
      },
      off: function (ev, fn) {
        var list = listeners[ev] || [];
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
        return api;
      },
      emit: function () { return api; },
      close: function () {
        if (source) { try { source.close(); } catch (e) { /* done */ } }
        source = null;
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
        stopPolling();
      }
    };

    function fire(ev, data) {
      (listeners[ev] || []).forEach(function (fn) {
        try { fn(data); } catch (e) {
          if (window.console) console.error(e);
        }
      });
    }

    var scene = sceneFromLocation();
    var token = '';
    try { token = new URLSearchParams(location.search).get('token') || ''; }
    catch (e) { /* no token -> the endpoints answer 403 */ }
    var qs = '?token=' + encodeURIComponent(token);
    var source = null, poll = null, pollMs = 0, watchdog = null;
    var sawPayload = false, warnedAuth = false;
    var lastDataAt = Date.now(), lastReconnectAt = 0;

    function apply(json) {
      if (!json || !json.ok || !json.state) return;
      if (!sawPayload) { sawPayload = true; fire('connect', {}); }
      fire('tournament:update', json.state);
    }

    function fetchState() {
      fetch('/api/overlay/state/' + scene + qs, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) { noteFetchFailure(r.status); return null; }
          noteFetchOk();
          return r.json();
        })
        .then(function (j) { if (j) apply(j); })
        .catch(function () { /* transient - keep the current cadence */ });
    }

    function noteFetchFailure(status) {
      if (status !== 403 && status !== 404) return;   // 5xx etc: transient
      if (!warnedAuth && window.console) {
        warnedAuth = true;
        console.warn('[overlay] state fetch rejected (HTTP ' + status +
          ') - the token or scene in this overlay URL is invalid or stale.');
      }
      setPoll(POLL_SLOW_MS);                          // pointless to hammer
    }

    function noteFetchOk() {
      warnedAuth = false;
      if (poll && pollMs !== POLL_FAST_MS) setPoll(POLL_FAST_MS);
    }

    function setPoll(ms) {
      if (poll && pollMs === ms) return;
      stopPolling();
      fetchState();                                   // immediate first pass
      pollMs = ms;
      poll = setInterval(fetchState, ms);
    }

    function stopPolling() {
      if (poll) { clearInterval(poll); poll = null; }
      pollMs = 0;
    }

    function ensurePolling() {
      if (!poll) setPoll(POLL_FAST_MS);
    }

    function openStream() {
      if (source) { try { source.close(); } catch (e) { /* done */ } }
      try {
        source = new EventSource('/api/overlay/stream/' + scene + qs);
      } catch (e) {
        source = null;
        ensurePolling();
        return;
      }
      lastDataAt = Date.now();
      source.onopen = function () {
        lastDataAt = Date.now();     // bounded credit until the first heartbeat
      };
      source.onerror = ensurePolling;   // EventSource retries on its own
      source.onmessage = function () {
        lastDataAt = Date.now();
        stopPolling();                  // real data: SSE is proven live again
        fetchState();
      };
      source.addEventListener('hb', function () {
        lastDataAt = Date.now();        // heartbeat: stream is alive
        stopPolling();
      });
    }

    function watchdogTick() {
      if (Date.now() - lastDataAt <= HB_SILENCE_MS) return;
      ensurePolling();                  // cover updates while SSE is repaired
      if (Date.now() - lastReconnectAt < RECONNECT_GAP_MS) return;
      lastReconnectAt = Date.now();
      openStream();                     // fresh connection for the next window
    }

    function connect() {
      fetchState();                     // first paint / polling baseline
      if (!window.EventSource) { ensurePolling(); return; }
      openStream();
      watchdog = setInterval(watchdogTick, WATCHDOG_MS);
    }

    setTimeout(connect, 0);
    return api;
  }

  window.io = function () { return createSocket(); };
})();
