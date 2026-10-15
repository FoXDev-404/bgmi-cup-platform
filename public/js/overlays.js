/* Overlay producer — enable/show overlays, theme, token, preview + copy. */
(function () {
  'use strict';
  var esc = BC.esc;
  var $ = function (id) { return document.getElementById(id); };

  var cfg = null;            // overlay-settings payload
  var disabled = {};

  var OVERLAY_BLURB = {
    'live-leaderboard': 'Rolling points table for the live lobby.',
    'teams-alive': 'Big squads-standing counter for tense moments.',
    'team-status-strip': 'Compact alive/knocked/out strip along an edge.',
    'elimination-popup': 'Slides in on every squad wipe.',
    'match-results': 'Final placements of the last published match.',
    'overall-standings': 'Tournament leaderboard with tie-breakers.',
    'team-intro': 'Lower-third squad intro with roster.',
    'chicken-dinner': 'Winner slate with MVP line.',
    'mvp-card': 'Player stat card — auto match MVP or caster push.',
    'break-screen': 'Break slate with sponsor line.',
    'sponsor-bug': 'Persistent corner sponsor bug.'
  };

  function urlFor(name) {
    return location.origin + '/overlay/' + name + '?token=' +
      encodeURIComponent(cfg.token);
  }

  /* ---- cards -------------------------------------------------------------- */

  function render() {
    $('overlayGrid').innerHTML = cfg.overlays.map(function (name) {
      var off = !!disabled[name];
      return '<article class="bc-overlay' + (off ? ' bc-overlay--off' : '') + '">' +
        '<div class="bc-overlay-name">' + esc(name) + '</div>' +
        '<p class="bc-p" style="margin:0;">' + esc(OVERLAY_BLURB[name] || '') + '</p>' +
        '<div class="bc-overlay-url" id="url-' + esc(name) + '">' +
        esc(urlFor(name)) + '</div>' +
        '<div class="bc-overlay-acts">' +
        '<label class="bc-toggle"><input type="checkbox" data-toggle="' +
        esc(name) + '"' + (off ? '' : ' checked') + '> on air</label>' +
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
    $('overlayGrid').querySelectorAll('[data-toggle]').forEach(function (c) {
      c.addEventListener('change', function () {
        var names = [];
        $('overlayGrid').querySelectorAll('[data-toggle]').forEach(function (x) {
          if (!x.checked) names.push(x.dataset.toggle);
        });
        BC.post('/api/admin/overlay-settings', { disabled: names }).then(function (x) {
          if (x.s === 200 && x.d.ok) {
            disabled = {};
            names.forEach(function (n) { disabled[n] = true; });
            render();
            BC.toast(names.length ? names.length + ' overlays hidden'
              : 'All overlays on air');
          } else BC.toast(x.d.error || 'Save failed', true);
        });
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
      disabled = {};
      (cfg.disabled || []).forEach(function (n) { disabled[n] = true; });
      $('tokenField').value = cfg.token;
      $('themeField').value = cfg.themeColor;
      $('logoField').value = cfg.logoPath;
      $('sponsorField').value = cfg.sponsorText;
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
      themeColor: $('themeField').value,
      logoPath: $('logoField').value.trim(),
      sponsorText: $('sponsorField').value.trim()
    }).then(function (x) {
      if (x.s === 200 && x.d.ok) {
        BC.toast('Theme saved');
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
