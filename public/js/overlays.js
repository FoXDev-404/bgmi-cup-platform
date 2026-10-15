/* Overlay producer — the original broadcast scenes, token, URLs + preview. */
(function () {
  'use strict';
  var esc = BC.esc;
  var $ = function (id) { return document.getElementById(id); };

  var cfg = null;            // overlay-settings payload

  var OVERLAY_BLURB = {
    'pre-show': 'Standby slate before the stream opens.',
    'stream-start': 'Stream starting soon screen with the event logo.',
    'countdown': 'Full-screen drop-in countdown clock.',
    'caster': 'Caster name card with photo and tagline.',
    'format': 'Tournament format and schedule panel.',
    'lineup': 'Teams dropping in, squad by squad.',
    'live': 'Live squad status board — rank, FIN, PTS, alive bars.',
    'chicken-dinner': 'Winner panel for the latest result.',
    'frag-leaders': 'Top five frag leaders with damage.',
    'results': 'Match results table with the winner panel.',
    'overall': 'Overall tournament standings.',
    'mvp': 'Player spotlight (match MVP or overall top fragger).',
    'map-feed': 'Tactical map feed frame.',
    'intermission': 'Match break slate.',
    'technical-difficulties': 'Technical difficulties slate.',
    'hidden': 'Blank slate — no graphics (standby).'
  };

  function urlFor(name) {
    return location.origin + '/overlay/' + name + '?token=' +
      encodeURIComponent(cfg.token);
  }

  /* ---- cards -------------------------------------------------------------- */

  function render() {
    $('overlayGrid').innerHTML = cfg.overlays.map(function (name) {
      return '<article class="bc-overlay">' +
        '<div class="bc-overlay-name">' + esc(name) + '</div>' +
        '<p class="bc-p" style="margin:0;">' + esc(OVERLAY_BLURB[name] || '') + '</p>' +
        '<div class="bc-overlay-url" id="url-' + esc(name) + '">' +
        esc(urlFor(name)) + '</div>' +
        '<div class="bc-overlay-acts">' +
        '<button class="bc-btn" data-copy="' + esc(name) + '">Copy URL</button>' +
        '<button class="bc-btn" data-preview="' + esc(name) + '">Preview</button>' +
        '</div></article>';
    }).join('');

    $('overlayGrid').querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.dataset.copy;
        var url = urlFor(name);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () {
            BC.toast('Copied ' + name + ' URL');
          }, function () { fallbackCopy(url); });
        } else {
          fallbackCopy(url);
        }
      });
    });
    $('overlayGrid').querySelectorAll('[data-preview]').forEach(function (b) {
      b.addEventListener('click', function () {
        $('previewPick').value = b.dataset.preview;
        loadPreview();
      });
    });
  }

  function fallbackCopy(url) {
    var ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); BC.toast('Copied'); }
    catch (e) { BC.toast('Copy failed — select the URL manually', true); }
    document.body.removeChild(ta);
  }

  /* ---- preview ------------------------------------------------------------- */

  function loadPreview() {
    var name = $('previewPick').value;
    var url = '/overlay/' + name + '?token=' + encodeURIComponent(cfg.token);
    var frame = $('previewFrame');
    frame.src = url;
    scalePreview();
  }

  function scalePreview() {
    var box = $('previewBox');
    var frame = $('previewFrame');
    var scale = box.clientWidth / 1920;
    frame.style.transform = 'scale(' + scale + ')';
  }
  window.addEventListener('resize', scalePreview);

  /* ---- settings ------------------------------------------------------------ */

  function load() {
    BC.api('/api/admin/overlay-settings').then(function (x) {
      if (x.s !== 200 || !x.d.ok) return;
      cfg = x.d;
      $('tokenField').value = cfg.token;
      $('logoField').value = cfg.logoPath;
      if ($('previewPick').options.length !== cfg.overlays.length) {
        $('previewPick').innerHTML = cfg.overlays.map(function (n) {
          return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
        }).join('');
      }
      render();
      loadPreview();
    });
  }

  $('saveThemeBtn').addEventListener('click', function () {
    BC.post('/api/admin/overlay-settings', {
      logoPath: $('logoField').value.trim()
    }).then(function (x) {
      if (x.s === 200 && x.d.ok) {
        BC.toast('Saved');
        load();
      } else BC.toast(x.d.error || 'Save failed', true);
    });
  });

  $('rotateBtn').addEventListener('click', function () {
    if (!window.confirm('Rotate the overlay token? Every existing OBS URL stops working until you paste the new one.')) return;
    BC.post('/api/admin/overlay-settings', { rotateToken: true }).then(function (x) {
      if (x.s === 200 && x.d.ok) {
        BC.toast('Token rotated — re-copy every OBS URL');
        load();
      } else BC.toast(x.d.error || 'Rotate failed', true);
    });
  });

  BC.boot(function () {
    load();
  });
})();
