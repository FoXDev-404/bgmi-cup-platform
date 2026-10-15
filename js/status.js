/* status.js — public registration-status lookup (no PII stored anywhere) */
(function () {
  'use strict';

  var lookupForm = document.getElementById('lookupForm');
  if (!lookupForm) return;

  var regCodeInput = document.getElementById('regCode');
  var hintInput = document.getElementById('hint');
  var lookupBtn = document.getElementById('lookupBtn');
  var lookupError = document.getElementById('lookupError');

  var result = document.getElementById('result');
  var reqForm = document.getElementById('reqForm');
  var reqToggle = document.getElementById('reqToggle');
  var reqBtn = document.getElementById('reqBtn');
  var reqMessage = document.getElementById('reqMessage');
  var reqError = document.getElementById('reqError');
  var reqOk = document.getElementById('reqOk');

  /* kept in memory only — never written to storage */
  var currentCode = '';
  var currentHint = '';

  function showError(el, msg) {
    el.textContent = msg || '';
  }

  /* operational next steps — generic guidance, no invented policies */
  var NEXT_STEPS = {
    pending: 'No action needed. Your entry is in the review queue — this page updates the moment an admin decides.',
    approved: "You're in. Watch this page for your group and match schedule; lobby details get posted here.",
    rejected: "This entry won't proceed. If you think something's wrong, request a correction below.",
    waitlisted: "You're on the waitlist. If a slot opens, your status flips to approved here — no action needed.",
    needs_changes: 'Fix the issue noted above, then send a correction request below. Your entry stays visible while it is reviewed.'
  };

  function fmtWhen(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    try {
      return d.toLocaleString(undefined, {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  function render(d) {
    document.getElementById('resCode').textContent = d.regCode || '';
    document.getElementById('resTeam').textContent = d.teamName || '';
    document.getElementById('resTag').textContent = '[' + (d.teamTag || '') + ']';

    var badge = document.getElementById('resBadge');
    badge.className = 'st-badge st-badge--' + (d.status || 'pending');
    /* text label is the source of truth; the colour is decoration */
    badge.textContent = d.statusLabel || d.status || '';

    var note = document.getElementById('resNote');
    if (d.note) {
      note.textContent = d.note;
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }

    var groupCell = document.getElementById('resGroupCell');
    if (d.group) {
      document.getElementById('resGroup').textContent = d.group;
      groupCell.classList.remove('hidden');
    } else {
      groupCell.classList.add('hidden');
    }

    var schedCell = document.getElementById('resScheduleCell');
    if (d.schedule) {
      document.getElementById('resSchedule').textContent = d.schedule;
      schedCell.classList.remove('hidden');
    } else {
      schedCell.classList.add('hidden');
    }

    document.getElementById('resUpdated').textContent = fmtWhen(d.updatedAt);
    document.getElementById('resNext').textContent =
      NEXT_STEPS[d.status] || NEXT_STEPS.pending;

    reqForm.classList.add('hidden');
    reqOk.classList.add('hidden');
    reqError.textContent = '';
    reqMessage.value = '';
    result.classList.remove('hidden');
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  lookupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    showError(lookupError, '');
    var code = regCodeInput.value.trim();
    var hint = hintInput.value.trim();
    if (!code || !hint) {
      showError(lookupError, 'Enter your Reg ID and the captain phone or email.');
      return;
    }

    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Checking…';

    fetch('/api/status/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regCode: code, hint: hint })
    })
      .then(function (r) {
        return r.json().then(function (d) { return { status: r.status, d: d }; });
      })
      .then(function (x) {
        if (x.status === 200 && x.d.found) {
          currentCode = code;
          currentHint = hint;
          render(x.d);
        } else if (x.status === 429) {
          result.classList.add('hidden');
          showError(lookupError, x.d.error || 'Too many attempts. Try again in a minute.');
        } else {
          result.classList.add('hidden');
          showError(lookupError, x.d.error || 'No registration found. Double-check the ID and the phone or email you registered with.');
        }
      })
      .catch(function () {
        showError(lookupError, 'Network hiccup — try again.');
      })
      .finally(function () {
        lookupBtn.disabled = false;
        lookupBtn.textContent = 'Check status';
      });
  });

  reqToggle.addEventListener('click', function () {
    reqForm.classList.toggle('hidden');
    if (!reqForm.classList.contains('hidden')) reqMessage.focus();
  });

  reqForm.addEventListener('submit', function (e) {
    e.preventDefault();
    showError(reqError, '');
    reqOk.classList.add('hidden');
    var msg = reqMessage.value.trim();
    if (msg.length < 5) {
      showError(reqError, 'Describe the correction in at least 5 characters.');
      return;
    }

    reqBtn.disabled = true;
    reqBtn.textContent = 'Sending…';

    fetch('/api/status/request-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regCode: currentCode, hint: currentHint, message: msg })
    })
      .then(function (r) {
        return r.json().then(function (d) { return { status: r.status, d: d }; });
      })
      .then(function (x) {
        if (x.status === 200 && x.d.ok) {
          reqOk.classList.remove('hidden');
          reqMessage.value = '';
        } else {
          showError(reqError, x.d.error || 'Could not send the request.');
        }
      })
      .catch(function () {
        showError(reqError, 'Network hiccup — try again.');
      })
      .finally(function () {
        reqBtn.disabled = false;
        reqBtn.textContent = 'Send request';
      });
  });
})();
