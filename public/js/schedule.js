/* Schedule feed — gated server-side by the public teams switch.
   Everything from the server is rendered via textContent (never innerHTML),
   so a schedule note can never inject markup. */
(function () {
  'use strict';

  var card = document.getElementById('schedCard');
  var off = document.getElementById('schedOff');
  var err = document.getElementById('schedErr');
  if (!card) return;

  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    try {
      return d.toLocaleString(undefined, {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return d.toISOString(); }
  }

  fetch('/api/public/schedule').then(function (r) {
    return r.json().then(function (d) { return { s: r.status, d: d }; });
  }).then(function (x) {
    if (x.s === 404) { card.classList.add('hidden'); off.classList.remove('hidden'); return; }
    if (x.s !== 200 || !x.d.ok) { card.classList.add('hidden'); err.classList.remove('hidden'); return; }

    card.textContent = '';
    var note = (x.d.schedule || '').trim();
    var body = document.createElement('p');
    body.style.whiteSpace = 'pre-wrap';
    body.style.margin = '0';
    if (note) {
      body.textContent = note;
    } else {
      body.style.color = 'rgba(237,230,211,.6)';
      body.textContent = 'The schedule will be posted here. Times and lobbies also appear on /status for registered teams.';
    }
    card.appendChild(body);

    var meta = document.createElement('p');
    meta.style.cssText = 'margin:14px 0 0; font-size:.8rem; letter-spacing:.06em; color:rgba(237,230,211,.5);';
    var bits = [];
    if (x.d.timezone) bits.push('Times in ' + x.d.timezone);
    if (x.d.updatedAt) bits.push('Last updated ' + fmtWhen(x.d.updatedAt));
    if (bits.length) meta.textContent = bits.join(' · ');
    card.appendChild(meta);
  }).catch(function () {
    card.classList.add('hidden');
    err.classList.remove('hidden');
  });
})();
