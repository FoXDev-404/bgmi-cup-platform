/* socket.io compatibility shim for the original broadcast overlays.
 *
 * The merged server is Python stdlib (no socket.io server), so this tiny
 * adapter re-implements only the API surface the old overlay pages use:
 *   io()            -> { on(event, fn), off(event, fn), emit(...), close() }
 *   'tournament:update'  full legacy public state on every change
 *   'connect'            fired with the first payload
 * It reads the merged server's token-gated endpoints:
 *   GET /api/overlay/state/<scene>?token=…   (JSON snapshot)
 *   GET /api/overlay/stream/<scene>?token=…  (SSE change signals)
 * with a 2 s polling fallback whenever SSE is unavailable or drops.
 * The overlay files themselves are untouched by this bridge.
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
        if (source) source.close();
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
    var source = null, poll = null, sawPayload = false;

    function apply(json) {
      if (!json || !json.ok || !json.state) return;
      if (!sawPayload) { sawPayload = true; fire('connect', {}); }
      fire('tournament:update', json.state);
    }

    function fetchState() {
      fetch('/api/overlay/state/' + scene + qs, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j) apply(j); })
        .catch(function () { /* transient - keep the last state on screen */ });
    }

    function startPolling() {
      if (poll) return;
      fetchState();
      poll = setInterval(fetchState, 2000);
    }

    function stopPolling() {
      if (poll) { clearInterval(poll); poll = null; }
    }

    function connect() {
      fetchState();                       // first paint / polling baseline
      if (!window.EventSource) { startPolling(); return; }
      try {
        source = new EventSource('/api/overlay/stream/' + scene + qs);
        source.onopen = stopPolling;      // SSE is live: drop the fallback
        source.onerror = startPolling;    // EventSource retries on its own
        source.onmessage = fetchState;    // a change signal: refetch
      } catch (e) {
        startPolling();
      }
    }

    setTimeout(connect, 0);
    return api;
  }

  window.io = function () { return createSocket(); };
})();
