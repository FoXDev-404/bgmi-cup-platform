/* ============================================================
   BGMI CUP — TEAM REGISTRATION
   Validation, roster management, logo upload, squad pass.
   ============================================================ */

(function () {
  'use strict';

  var jsPDF = window.jspdf ? window.jspdf.jsPDF : null;

  var MAX_ATTEMPTS = 3;
  var ENDPOINT = '/api/register';
  var CSRF_ENDPOINT = '/api/csrf';

  /* ===== NAVBAR ===== */
  var navbar = document.getElementById('navbar');
  function handleNavScroll() {
    if (!navbar) return;
    navbar.classList.toggle('scrolled', window.scrollY > 60);
  }
  window.addEventListener('scroll', handleNavScroll, { passive: true });
  handleNavScroll();

  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');
  var navOverlay = document.getElementById('navOverlay');

  function openNav() {
    navToggle.classList.add('active');
    navLinks.classList.add('open');
    navOverlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeNav() {
    navToggle.classList.remove('active');
    navLinks.classList.remove('open');
    navOverlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  if (navToggle) {
    navToggle.addEventListener('click', function () {
      if (navLinks.classList.contains('open')) closeNav();
      else openNav();
    });
  }
  if (navOverlay) navOverlay.addEventListener('click', closeNav);
  if (navLinks) {
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', closeNav);
    });
  }

  /* ===== SCROLL REVEAL ===== */
  var fadeEls = document.querySelectorAll('.fade-in-up');
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var d = entry.target.style.getPropertyValue('--delay') || '0s';
          entry.target.style.transitionDelay = d;
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });

    fadeEls.forEach(function (el) { observer.observe(el); });
  } else {
    fadeEls.forEach(function (el) { el.classList.add('visible'); });
  }

  /* ===== KONAMI CODE ===== */
  var konamiSequence = [
    'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
    'b', 'a'
  ];
  var konamiIndex = 0;

  document.addEventListener('keydown', function (e) {
    var key = e.key;
    var expected = konamiSequence[konamiIndex];

    if (key === expected || key.toLowerCase() === expected) {
      konamiIndex++;
      if (konamiIndex === konamiSequence.length) {
        triggerKonami();
        konamiIndex = 0;
      }
    } else {
      konamiIndex = 0;
    }
  });

  function triggerKonami() {
    var toast = document.getElementById('konamiToast');
    if (!toast) return;
    toast.classList.remove('hidden');
    toast.classList.add('show');

    document.body.style.transition = 'filter 0.3s';
    document.body.style.filter = 'hue-rotate(90deg)';

    setTimeout(function () { document.body.style.filter = ''; }, 500);
    setTimeout(function () {
      toast.classList.remove('show');
      toast.classList.add('hidden');
    }, 3200);
  }

  /* ============================================================
     FORM
     ============================================================ */

  var regForm = document.getElementById('teamForm');
  if (!regForm) return;

  var regFormWrapper = document.getElementById('regFormWrapper');
  var confirmation = document.getElementById('confirmation');

  function showError(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg || '';
  }

  function scrollToElement(el, extra) {
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.scrollY - (extra || 80);
    window.scrollTo({ top: top, behavior: 'smooth' });
  }

  function setInvalid(input, invalid) {
    if (!input) return;
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  /* ===== INPUT FORMAT HELPERS ===== */
  var tagInput = document.getElementById('teamTag');
  if (tagInput) {
    tagInput.addEventListener('input', function () {
      var pos = tagInput.selectionStart;
      tagInput.value = tagInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      try { tagInput.setSelectionRange(pos, pos); } catch (e) {}
    });
  }

  document.querySelectorAll('.uid-input').forEach(function (input) {
    input.addEventListener('input', function () {
      var pos = input.selectionStart;
      input.value = input.value.replace(/\D/g, '').slice(0, 12);
      if (document.activeElement === input) {
        try { input.setSelectionRange(pos, pos); } catch (e) {}
      }
    });
  });

  /* ===== VALIDATORS ===== */
  var validators = {
    teamName: function (val) {
      if (!val || val.trim().length < 3) return 'Team name needs at least 3 characters.';
      if (val.trim().length > 24) return 'Keep it to 24 characters — the lobby screen is small.';
      if (/[<>]/.test(val)) return 'No angle brackets, the lobby crashes.';
      return '';
    },
    teamTag: function (val) {
      if (!val) return 'A 2-5 character tag. Your identity in the kill feed.';
      if (!/^[A-Z0-9]{2,5}$/.test(val)) return 'Tag = 2-5 letters or numbers only.';
      return '';
    },
    guildName: function (val) {
      if (!val || val.trim().length < 2) return 'Enter your in-game guild name.';
      if (/[<>]/.test(val)) return 'No angle brackets, the lobby crashes.';
      return '';
    },
    ign: function (val) {
      if (!val || !val.trim()) return 'Player IGN is required.';
      if (val.trim().length < 3) return 'IGNs are at least 3 characters.';
      if (!/^[A-Za-z0-9_().\-\s]{3,16}$/.test(val.trim())) return '3-16 characters: letters, numbers, spaces, _ ( ) . -';
      return '';
    },
    uid: function (val) {
      if (!val) return 'Character ID is required.';
      if (!/^\d{6,12}$/.test(val)) return 'Character IDs are 6-12 digits. Check the profile screen.';
      return '';
    },
    email: function (val) {
      if (!val) return 'Email is required — check-in details go here.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) return 'That email doesn\'t look right.';
      return '';
    },
    phone: function (val) {
      if (!val) return 'Phone number is required.';
      var cleaned = val.replace(/\+91\s?/, '').replace(/\s/g, '');
      if (!/^\d{10}$/.test(cleaned)) return 'That phone number looks sus. Need exactly 10 digits.';
      return '';
    },
    discord: function (val) {
      if (!val) return '';
      if (!/^@?[A-Za-z0-9._]{2,32}(#\d{4})?$/.test(val.trim())) return 'Discord handles: letters, numbers, dots, underscores.';
      return '';
    }
  };

  /* field id -> validator key + error span id */
  var FIELD_MAP = [
    { input: 'teamName',  err: 'teamNameError',  key: 'teamName' },
    { input: 'teamTag',   err: 'teamTagError',   key: 'teamTag' },
    { input: 'guildName', err: 'guildNameError', key: 'guildName' },
    { input: 'capIgn',    err: 'capIgnError',    key: 'ign' },
    { input: 'capUid',    err: 'capUidError',    key: 'uid' },
    { input: 'capEmail',  err: 'capEmailError',  key: 'email' },
    { input: 'capPhone',  err: 'capPhoneError',  key: 'phone' },
    { input: 'capDiscord', err: 'capDiscordError', key: 'discord' }
  ];

  /* roster rows P2-P4 are always validated */
  function getRosterRows() {
    return Array.prototype.slice.call(regForm.querySelectorAll('[data-player]'));
  }

  function validateFieldInput(input, errId, key) {
    var msg = validators[key](input.value);
    showError(errId, msg);
    setInvalid(input, !!msg);
    return !msg;
  }

  FIELD_MAP.forEach(function (f) {
    var input = document.getElementById(f.input);
    if (!input) return;
    input.addEventListener('blur', function () {
      validateFieldInput(input, f.err, f.key);
    });
    input.addEventListener('input', function () {
      if (input.getAttribute('aria-invalid') === 'true') {
        validateFieldInput(input, f.err, f.key);
      }
    });
  });

  getRosterRows().forEach(function (row) {
    var num = row.getAttribute('data-player');
    row.querySelectorAll('input').forEach(function (input) {
      var isUid = input.classList.contains('uid-input');
      var key = isUid ? 'uid' : 'ign';
      var errId = 'p' + num + (isUid ? 'Uid' : 'Ign') + 'Error';
      input.addEventListener('blur', function () {
        validateFieldInput(input, errId, key);
      });
      input.addEventListener('input', function () {
        if (input.getAttribute('aria-invalid') === 'true') {
          validateFieldInput(input, errId, key);
        }
      });
    });
  });

  /* ===== CONSENT ===== */
  var agreeRules = document.getElementById('agreeRules');
  var agreeFairPlay = document.getElementById('agreeFairPlay');
  [agreeRules, agreeFairPlay].forEach(function (cb) {
    if (!cb) return;
    cb.addEventListener('change', function () {
      if (agreeRules.checked && agreeFairPlay.checked) showError('consentError', '');
    });
  });

  /* ============================================================
     SUBSTITUTES (max 2)
     ============================================================ */

  var subsWrap = document.getElementById('subsWrap');
  var addSubBtn = document.getElementById('addSub');
  var subsCount = document.getElementById('subsCount');
  var subTemplate = document.getElementById('subTemplate');
  var MAX_SUBS = 2;

  function updateSubsState() {
    var rows = subsWrap.querySelectorAll('[data-sub]');
    if (subsCount) subsCount.textContent = rows.length + ' / ' + MAX_SUBS + ' subs';
    if (addSubBtn) addSubBtn.disabled = rows.length >= MAX_SUBS;
    rows.forEach(function (row, i) {
      var slot = row.querySelector('.slot-no');
      if (slot) slot.textContent = 'S' + (i + 1);
    });
  }

  function bindSubRow(row) {
    row.querySelectorAll('input').forEach(function (input) {
      var isUid = input.classList.contains('uid-input');
      var key = isUid ? 'uid' : 'ign';
      input.addEventListener('blur', function () {
        var msg = input.value ? validators[key](input.value) : '';
        var errEl = row.querySelectorAll('.form-error')[isUid ? 1 : 0];
        if (errEl) errEl.textContent = msg;
        setInvalid(input, !!msg);
      });
    });

    var removeBtn = row.querySelector('.sub-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', function () {
        row.style.transition = 'opacity .25s, transform .25s';
        row.style.opacity = '0';
        row.style.transform = 'translateX(18px)';
        setTimeout(function () {
          row.remove();
          updateSubsState();
        }, 250);
      });
    }
  }

  if (addSubBtn && subTemplate) {
    addSubBtn.addEventListener('click', function () {
      if (subsWrap.querySelectorAll('[data-sub]').length >= MAX_SUBS) return;
      var row = subTemplate.content.firstElementChild.cloneNode(true);
      subsWrap.appendChild(row);
      bindSubRow(row);
      updateSubsState();
      var firstInput = row.querySelector('input');
      if (firstInput) firstInput.focus();
    });
  }

  updateSubsState();

  /* ============================================================
     TEAM LOGO UPLOAD
     ============================================================ */

  var logoInput = document.getElementById('teamLogo');
  var logoDrop = document.getElementById('logoDrop');
  var logoDropInner = document.getElementById('logoDropInner');
  var logoPreview = document.getElementById('logoPreview');
  var logoPreviewImg = document.getElementById('logoPreviewImg');
  var logoName = document.getElementById('logoName');
  var logoRemove = document.getElementById('logoRemove');

  var LOGO_MAX_BYTES = 2 * 1024 * 1024;
  var LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  var logoData = null; /* { name, dataUrl } for payload */

  function resetLogo() {
    logoData = null;
    if (logoInput) logoInput.value = '';
    if (logoPreview) logoPreview.classList.add('hidden');
    if (logoDropInner) logoDropInner.classList.remove('hidden');
    showError('logoError', '');
  }

  function acceptLogo(file) {
    if (!file) return;
    if (LOGO_TYPES.indexOf(file.type) === -1) {
      showError('logoError', 'That file format won\'t fly. PNG, JPG or WEBP only.');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      showError('logoError', 'Logo too thicc — max 2 MB. Compress it, soldier.');
      return;
    }

    var reader = new FileReader();
    reader.onload = function (e) {
      logoData = { name: file.name, dataUrl: e.target.result };
      logoPreviewImg.src = e.target.result;
      logoName.textContent = file.name;
      logoPreview.classList.remove('hidden');
      logoDropInner.classList.add('hidden');
      showError('logoError', '');
    };
    reader.readAsDataURL(file);
  }

  if (logoInput && logoDrop) {
    logoInput.addEventListener('change', function () {
      acceptLogo(logoInput.files && logoInput.files[0]);
    });

    logoDrop.addEventListener('click', function (e) {
      if (e.target === logoRemove || (logoRemove && logoRemove.contains(e.target))) return;
      if (logoPreview && !logoPreview.classList.contains('hidden')) return;
      logoInput.click();
    });

    logoDrop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        logoInput.click();
      }
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      logoDrop.addEventListener(evt, function (e) {
        e.preventDefault();
        logoDrop.classList.add('drag');
      });
    });

    ['dragleave', 'drop'].forEach(function (evt) {
      logoDrop.addEventListener(evt, function (e) {
        e.preventDefault();
        logoDrop.classList.remove('drag');
      });
    });

    logoDrop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        acceptLogo(e.dataTransfer.files[0]);
      }
    });

    if (logoRemove) {
      logoRemove.addEventListener('click', function (e) {
        e.stopPropagation();
        resetLogo();
      });
    }
  }

  /* ============================================================
     CROSS-ROSTER CHECKS
     ============================================================ */

  function collectRoster() {
    var members = [];
    var capIgn = document.getElementById('capIgn');
    var capUid = document.getElementById('capUid');

    members.push({ slot: 'P1', role: 'IGL / Captain', ign: capIgn.value.trim(), uid: capUid.value });

    getRosterRows().forEach(function (row) {
      var num = row.getAttribute('data-player');
      var inputs = row.querySelectorAll('input');
      members.push({
        slot: 'P' + num,
        role: 'Starter',
        ign: inputs[0].value.trim(),
        uid: inputs[1].value
      });
    });

    subsWrap.querySelectorAll('[data-sub]').forEach(function (row, i) {
      var inputs = row.querySelectorAll('input');
      members.push({
        slot: 'S' + (i + 1),
        role: 'Substitute',
        ign: inputs[0].value.trim(),
        uid: inputs[1].value
      });
    });

    return members;
  }

  function checkDuplicates(members) {
    var seenUid = {};
    var seenIgn = {};
    var problems = [];

    members.forEach(function (m) {
      if (!m.uid) return;
      if (seenUid[m.uid]) {
        problems.push('Character ID ' + m.uid + ' appears twice (' + seenUid[m.uid] + ' & ' + m.slot + '). One account per player — the rules said so.');
      } else {
        seenUid[m.uid] = m.slot;
      }
    });

    members.forEach(function (m) {
      if (!m.ign) return;
      var lower = m.ign.toLowerCase();
      if (seenIgn[lower]) {
        problems.push('IGN "' + m.ign + '" is registered twice (' + seenIgn[lower] + ' & ' + m.slot + ').');
      } else {
        seenIgn[lower] = m.slot;
      }
    });

    return problems;
  }

  /* ============================================================
     SUBMIT
     ============================================================ */

  var regSubmitBtn = regForm.querySelector('button[type="submit"]');
  var regOrigLabel = regSubmitBtn ? regSubmitBtn.innerHTML : '';
  var saving = false;
  var attempt = 0;
  var pendingReg = null;
  var lastTeamId = null;
  var csrfToken = null;

  function fetchCsrf() {
    return fetch(CSRF_ENDPOINT, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) { csrfToken = data.token; })
      .catch(function () { csrfToken = null; });
  }

  /* Map server field names -> local error span ids */
  var SERVER_FIELD_ERRS = {
    teamName: 'teamNameError', teamTag: 'teamTagError', guildName: 'guildNameError',
    capIgn: 'capIgnError', capUid: 'capUidError', capEmail: 'capEmailError',
    capPhone: 'capPhoneError', capDiscord: 'capDiscordError',
    p2Ign: 'p2IgnError', p2Uid: 'p2UidError',
    p3Ign: 'p3IgnError', p3Uid: 'p3UidError',
    p4Ign: 'p4IgnError', p4Uid: 'p4UidError'
  };

  function showServerFieldError(field, msg) {
    var errId = SERVER_FIELD_ERRS[field];
    if (errId) {
      showError(errId, msg);
      var input = document.getElementById(field);
      if (input) {
        setInvalid(input, true);
        scrollToElement(input, 90);
        return true;
      }
    }
    return false;
  }

  function showSavingState() {
    saving = true;
    setReviewBusy(true);
    var label = attempt > 0
      ? 'Retrying\u2026 ' + (attempt + 1) + '/' + MAX_ATTEMPTS
      : 'Locking your roster\u2026';
    if (reviewConfirmBtn && regReview && !regReview.classList.contains('hidden')) {
      reviewConfirmBtn.innerHTML = '<span>' + label + '</span>';
    }
    if (!regSubmitBtn) return;
    regSubmitBtn.disabled = true;
    regSubmitBtn.innerHTML = label;
  }

  function finishSave(reg) {
    saving = false;
    setReviewBusy(false);
    if (regSubmitBtn) {
      regSubmitBtn.disabled = false;
      regSubmitBtn.innerHTML = regOrigLabel;
    }
    showError('submitError', '');
    showConfirmation(reg);
  }

  function retryOrFail(reg) {
    saving = false;
    attempt++;
    if (attempt < MAX_ATTEMPTS) {
      window.setTimeout(function () { attemptSave(reg); }, 1200);
    } else {
      pendingReg = null;
      setReviewBusy(false);
      hideReview();
      if (reviewConfirmBtn) {
        reviewConfirmBtn.innerHTML =
          '<span>Confirm &amp; register</span>';
      }
      if (regSubmitBtn) {
        regSubmitBtn.disabled = false;
        regSubmitBtn.innerHTML = regOrigLabel;
      }
      showError('submitError', 'We couldn\u2019t confirm your save after ' + MAX_ATTEMPTS + ' attempts. Tap Register team again to retry \u2014 a repeat is safe and won\u2019t duplicate your squad. Your roster is still here.');
      regForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function attemptSave(reg) {
    if (!reg) return;
    showSavingState();

    var fd = new FormData();
    fd.append('teamName', reg.teamName);
    fd.append('teamTag', reg.teamTag);
    fd.append('guildName', reg.guildName);
    fd.append('capIgn', reg.capIgn);
    fd.append('capUid', reg.capUid);
    fd.append('capEmail', reg.capEmail);
    fd.append('capPhone', reg.capPhone);
    fd.append('capDiscord', reg.capDiscord || '');
    fd.append('roster', JSON.stringify(reg.roster));
    if (reg.logoDataUrl) fd.append('logoDataUrl', reg.logoDataUrl);
    /* honeypot — the hidden "company" field; humans never see it */
    var hp = document.getElementById('hpCompany');
    fd.append('company', hp ? hp.value : '');

    var doFetch = function () {
      return fetch(ENDPOINT, {
        method: 'POST',
        body: fd,
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
      }).then(function (r) {
        return r.json().then(function (data) { return { status: r.status, data: data }; });
      });
    };

    var sendWithCsrf = function () {
      if (csrfToken) return doFetch();
      return fetchCsrf().then(doFetch);
    };

    sendWithCsrf()
      .then(function (res) {
        var data = res.data || {};

        if (data.ok) {
          csrfToken = null;             /* single-use — drop it so the next submit fetches fresh */
          reg.teamId = data.teamId;      /* server allocates the ID */
          reg.regCode = data.regCode;    /* Reg ID — needed for /status lookups */
          finishSave(reg);
          return;
        }

        /* expired/invalid CSRF — refresh once and retry immediately */
        if (data.errorCode === 'csrf') {
          csrfToken = null;
          return fetchCsrf().then(doFetch).then(function (res2) {
            var d2 = res2.data || {};
            if (d2.ok) {
              reg.teamId = d2.teamId;
              reg.regCode = d2.regCode;
              finishSave(reg);
            } else {
              failValidation(d2);
            }
          });
        }

        if (res.status === 429) {
          /* rate limited — surface immediately, no point retrying */
          failValidation(data);
          return;
        }

        if (res.status >= 400 && res.status < 500) {
          failValidation(data);
          return;
        }

        retryOrFail(reg);
      })
      .catch(function () { retryOrFail(reg); });   /* network error */
  }

  /* Server rejected the data — show the message, don't retry. */
  function failValidation(data) {
    saving = false;
    pendingReg = null;
    setReviewBusy(false);
    if (reviewConfirmBtn) {
      reviewConfirmBtn.innerHTML = '<span>Confirm &amp; register</span>';
    }
    if (regSubmitBtn) {
      regSubmitBtn.disabled = false;
      regSubmitBtn.innerHTML = regOrigLabel;
    }
    hideReview();
    var msg = (data && data.error) || 'The server rejected this registration.';
    var mapped = data && data.field && showServerFieldError(data.field, msg);
    if (!mapped) {
      showError('submitError', msg);
      regForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ============================================================
     REVIEW STEP — nothing leaves the browser until Confirm
     ============================================================ */

  var regReview = document.getElementById('regReview');
  var reviewList = document.getElementById('reviewList');
  var reviewBackBtn = document.getElementById('reviewBack');
  var reviewConfirmBtn = document.getElementById('reviewConfirm');

  function setReviewBusy(busy) {
    if (reviewBackBtn) reviewBackBtn.disabled = busy;
    if (reviewConfirmBtn) reviewConfirmBtn.disabled = busy;
  }

  function reviewRow(label, value) {
    var wrap = document.createElement('div');
    wrap.className = 'review-row';
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value || '\u2014';
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    return wrap;
  }

  function showReview(reg) {
    if (!regReview || !reviewList || typeof regForm === 'undefined') {
      attemptSave(reg);           /* no review UI — fall back to direct save */
      return;
    }
    reviewList.textContent = '';
    reviewList.appendChild(reviewRow(
      'Team', reg.teamName + ' [' + reg.teamTag + ']'));
    if (reg.guildName) {
      reviewList.appendChild(reviewRow('Guild', reg.guildName));
    }
    reviewList.appendChild(reviewRow(
      'Captain', reg.capIgn + ' \u00b7 UID ' + reg.capUid));
    reviewList.appendChild(reviewRow('Contact', reg.capEmail + ' \u00b7 ' + reg.capPhone));
    if (reg.capDiscord) {
      reviewList.appendChild(reviewRow('Discord', reg.capDiscord));
    }
    reviewList.appendChild(reviewRow('Logo', reg.logoDataUrl ? 'attached' : 'none'));
    reviewList.appendChild(reviewRow(
      'Roster',
      reg.roster.map(function (m) {
        return m.slot + ' ' + m.ign + ' (' + m.uid + ')' +
          (m.role === 'Substitute' ? ' \u2014 sub' : '');
      }).join(' \u00b7 ')));
    showError('reviewError', '');
    setReviewBusy(false);
    regForm.classList.add('hidden');
    regReview.classList.remove('hidden');
    scrollToElement(regReview, 70);
    if (reviewConfirmBtn) reviewConfirmBtn.focus();
  }

  function hideReview() {
    if (regReview) regReview.classList.add('hidden');
    regForm.classList.remove('hidden');
  }

  if (reviewBackBtn) {
    reviewBackBtn.addEventListener('click', function () {
      hideReview();
      scrollToElement(regForm, 70);
      var first = document.getElementById('teamName');
      if (first) first.focus();
    });
  }

  if (reviewConfirmBtn) {
    reviewConfirmBtn.addEventListener('click', function () {
      if (saving || !pendingReg) return;      /* double-submit guard */
      attempt = 0;
      attemptSave(pendingReg);
    });
  }

  regForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (saving) return;

    var firstInvalid = null;

    FIELD_MAP.forEach(function (f) {
      var input = document.getElementById(f.input);
      if (!input) return;
      var ok = validateFieldInput(input, f.err, f.key);
      if (!ok && !firstInvalid) firstInvalid = input;
    });

    /* consent */
    if (!agreeRules.checked || !agreeFairPlay.checked) {
      showError('consentError', 'Both boxes. No exceptions. The gate staff can smell a forged consent.');
      if (!firstInvalid) firstInvalid = agreeRules;
    } else {
      showError('consentError', '');
    }

    /* roster P2-P4 */
    getRosterRows().forEach(function (row) {
      var num = row.getAttribute('data-player');
      row.querySelectorAll('input').forEach(function (input, i) {
        var isUid = i === 1;
        var msg = validators[isUid ? 'uid' : 'ign'](input.value);
        showError('p' + num + (isUid ? 'Uid' : 'Ign') + 'Error', msg);
        setInvalid(input, !!msg);
        if (msg && !firstInvalid) firstInvalid = input;
      });
    });

    /* subs: partial rows are an error, both-empty is fine */
    subsWrap.querySelectorAll('[data-sub]').forEach(function (row) {
      var inputs = row.querySelectorAll('input');
      var errEls = row.querySelectorAll('.form-error');
      var ignVal = inputs[0].value.trim();
      var uidVal = inputs[1].value;

      if (!ignVal && !uidVal) {
        errEls[0].textContent = '';
        errEls[1].textContent = '';
        setInvalid(inputs[0], false);
        setInvalid(inputs[1], false);
        return;
      }

      var ignMsg = validators.ign(ignVal);
      var uidMsg = validators.uid(uidVal);
      errEls[0].textContent = ignMsg;
      errEls[1].textContent = uidMsg;
      setInvalid(inputs[0], !!ignMsg);
      setInvalid(inputs[1], !!uidMsg);
      if ((ignMsg || uidMsg) && !firstInvalid) firstInvalid = ignMsg ? inputs[0] : inputs[1];
    });

    /* duplicate scan across every filled slot */
    var members = collectRoster();
    var dups = checkDuplicates(members);
    if (dups.length) {
      showError('submitError', dups[0]);
      if (!firstInvalid) firstInvalid = document.getElementById('capUid');
      scrollToElement(firstInvalid || regForm, 90);
      return;
    }

    if (firstInvalid) {
      showError('submitError', 'Some fields are still red. Fix those, then we drop.');
      scrollToElement(firstInvalid, 90);
      return;
    }

    showError('submitError', '');

    pendingReg = {
      teamName: document.getElementById('teamName').value.trim(),
      teamTag: document.getElementById('teamTag').value.trim(),
      guildName: document.getElementById('guildName').value.trim(),
      capIgn: document.getElementById('capIgn').value.trim(),
      capUid: document.getElementById('capUid').value.trim(),
      capEmail: document.getElementById('capEmail').value.trim(),
      capPhone: document.getElementById('capPhone').value.trim(),
      capDiscord: document.getElementById('capDiscord').value.trim(),
      roster: members,
      logoDataUrl: logoData ? logoData.dataUrl : null,
      teamId: null                    /* allocated by the server */
    };

    attempt = 0;
    showReview(pendingReg);        /* review first — save only on Confirm */
  });

  /* Warm the CSRF token on first form interaction so submit is snappy */
  regForm.addEventListener('focusin', function () {
    if (!csrfToken) fetchCsrf();
  }, { once: true });

  /* ============================================================
     CONFIRMATION + SQUAD PASS
     ============================================================ */

  function encodeQR(text) {
    try {
      if (typeof btoa === 'function') {
        return btoa(unescape(encodeURIComponent(text)));
      }
    } catch (e) {}
    return text;
  }

  function generateQR(elementId, text) {
    var el = document.getElementById(elementId);
    if (!el) return;
    el.innerHTML = '';

    if (typeof qrcode === 'function') {
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(4, 2);
      return;
    }

    var fallback = document.createElement('span');
    fallback.className = 'qr-fallback';
    fallback.textContent = text;
    el.appendChild(fallback);
  }

  function showConfirmation(reg) {
    regFormWrapper.classList.add('hidden');
    confirmation.classList.remove('hidden');
    lastTeamId = reg.teamId;

    document.getElementById('confTeamName').textContent = reg.teamName;
    document.getElementById('confTag').textContent = reg.teamTag;
    document.getElementById('confGuild').textContent = reg.guildName;
    document.getElementById('confCaptain').textContent = reg.capIgn + ' \u00b7 UID ' + reg.capUid;
    document.getElementById('confTeamId').textContent = reg.teamId;
    document.getElementById('confRegCode').textContent = reg.regCode || '\u2014';

    /* roster table */
    var rosterEl = document.getElementById('confRoster');
    rosterEl.innerHTML = '';
    reg.roster.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'roster-data-row' + (m.role === 'Substitute' ? ' is-sub' : '');
      row.innerHTML =
        '<b>' + m.slot + '</b>' +
        '<span>' + escapeHtml(m.ign) + '</span>' +
        '<span class="uid-cell">' + escapeHtml(m.uid) + '</span>';
      rosterEl.appendChild(row);
    });

    generateQR('teamQR', encodeQR((reg.regCode || reg.teamId) + ' | ' + reg.teamName + ' [' + reg.teamTag + ']'));

    /* share links */
    var shareText = 'Squad up: ' + reg.teamName + ' [' + reg.teamTag + '] is registered for the BGMI Cup! Team ID: ' + reg.teamId + ' #BGMI #BGMICup';
    var waText = 'Squad up: ' + reg.teamName + ' [' + reg.teamTag + '] is registered for the BGMI Cup! Team ID: ' + reg.teamId;

    document.getElementById('shareTwitter').href =
      'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText);
    document.getElementById('shareWhatsApp').href =
      'https://wa.me/?text=' + encodeURIComponent(waText);
    document.getElementById('shareMastodon').href =
      'https://mastodon.com/share?text=' + encodeURIComponent(shareText);

    scrollToElement(confirmation, 70);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ============================================================
     SQUAD PASS PDF
     ============================================================ */

  var downloadPassBtn = document.getElementById('downloadPass');

  function drawQRToPDF(doc, text, x, y, side, dark, light) {
    if (typeof qrcode !== 'function') return;
    var qr;
    try {
      qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
    } catch (e) { return; }

    var n = qr.getModuleCount();
    var quietZone = 4;
    var total = n + quietZone * 2;
    var cell = side / total;

    doc.setFillColor(light[0], light[1], light[2]);
    doc.rect(x, y, side, side, 'F');

    doc.setFillColor(dark[0], dark[1], dark[2]);
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          doc.rect(x + (c + quietZone) * cell, y + (r + quietZone) * cell, cell, cell, 'F');
        }
      }
    }
  }

  if (downloadPassBtn) {
    downloadPassBtn.addEventListener('click', function () {
      if (!jsPDF) {
        alert('PDF library is loading. Try again in a moment.');
        return;
      }
      if (!pendingReg) return;

      var doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [200, 100] });

      var DARK = [12, 13, 16];
      var INK = [236, 231, 216];
      var BEIGE = [200, 182, 144];
      var ACID = [182, 255, 62];
      var RED = [193, 77, 64];

      doc.setFillColor(DARK[0], DARK[1], DARK[2]);
      doc.rect(0, 0, 200, 100, 'F');

      doc.setDrawColor(RED[0], RED[1], RED[2]);
      doc.setLineWidth(0.6);
      doc.rect(4, 4, 192, 92);

      doc.setTextColor(ACID[0], ACID[1], ACID[2]);
      doc.setFont('courier', 'bold');
      doc.setFontSize(7);
      doc.text('BGMI CUP \u2022 SQUAD PASS', 10, 12);

      doc.setTextColor(INK[0], INK[1], INK[2]);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text(pendingReg.teamName.toUpperCase(), 10, 22);

      doc.setFont('courier', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(BEIGE[0], BEIGE[1], BEIGE[2]);
      doc.text('TAG: ' + pendingReg.teamTag + '   GUILD: ' + pendingReg.guildName, 10, 29);
      doc.text('CAPTAIN: ' + pendingReg.capIgn + '  UID ' + pendingReg.capUid, 10, 34);
      doc.text('MODE: SQUAD TPP \u2022 6 ROUNDS \u2022 ENTRY: FREE', 10, 39);

      var y = 47;
      doc.setFontSize(7);
      pendingReg.roster.forEach(function (m) {
        doc.setTextColor(m.role === 'Substitute' ? BEIGE[0] : ACID[0],
                         m.role === 'Substitute' ? BEIGE[1] : ACID[1],
                         m.role === 'Substitute' ? BEIGE[2] : ACID[2]);
        doc.setFont('courier', 'bold');
        doc.text(m.slot, 10, y);
        doc.setTextColor(INK[0], INK[1], INK[2]);
        doc.setFont('courier', 'normal');
        doc.text(m.ign + '  (' + m.role + ')', 18, y);
        doc.setTextColor(BEIGE[0], BEIGE[1], BEIGE[2]);
        doc.text('UID ' + m.uid, 100, y);
        y += 6;
      });

      drawQRToPDF(doc, encodeQR(pendingReg.teamId + '|' + pendingReg.teamName + '|' + pendingReg.teamTag),
                  164, 22, 28, DARK, INK);

      doc.setFont('courier', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(ACID[0], ACID[1], ACID[2]);
      doc.text('TEAM ID: ' + pendingReg.teamId, 164, 56);
      doc.setFont('courier', 'normal');
      doc.setFontSize(6);
      doc.setTextColor(BEIGE[0], BEIGE[1], BEIGE[2]);
      doc.text('SHOW AT CHECK-IN.', 164, 61);
      doc.text('ROSTER LOCKED.', 164, 65);

      doc.save('bgmi-squad-' + pendingReg.teamId + '.pdf');
    });
  }

  /* ============================================================
     RESET — REGISTER ANOTHER SQUAD
     ============================================================ */

  var newTeamBtn = document.getElementById('newTeamBtn');

  if (newTeamBtn) {
    newTeamBtn.addEventListener('click', function () {
      confirmation.classList.add('hidden');
      regFormWrapper.classList.remove('hidden');
      regForm.reset();

      FIELD_MAP.forEach(function (f) { showError(f.err, ''); });
      getRosterRows().forEach(function (row) {
        row.querySelectorAll('input').forEach(function (input) {
          setInvalid(input, false);
        });
      });
      subsWrap.innerHTML = '';
      updateSubsState();
      resetLogo();
      showError('consentError', '');
      showError('submitError', '');
      pendingReg = null;
      lastTeamId = null;

      scrollToElement(regFormWrapper, 80);
    });
  }

})();
