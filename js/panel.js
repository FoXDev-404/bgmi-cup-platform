/* panel.js — BGMI Cup control room (queue / detail / groups / audit / settings) */
(function () {
  'use strict';
  var queueBody = document.getElementById('queueBody');
  if (!queueBody) return;

  var csrf = '';
  var LABELS = {
    pending: 'Pending review', approved: 'Approved', rejected: 'Rejected',
    waitlisted: 'Waitlisted', needs_changes: 'Needs changes'
  };

  var state = {
    q: '', status: 'all', sort: 'date',
    rows: [], counts: {}, slotLimit: 16, approved: 0,
    remaining: null, notify: null,
    conflicts: {}, selected: {},
    groups: [], unassigned: [], groupsLocked: false,
    detail: null, smtp: false, publicTeams: false
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (opts.method && opts.method !== 'GET') headers['X-Admin-CSRF'] = csrf;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) { location.href = '/admin'; throw new Error('auth'); }
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    });
  }

  function fatal(msg) {
    var el = $('loadError');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(function () { el.classList.add('hidden'); }, 6000);
  }

  /* ---------- tabs ---------- */

  var TABS = ['Queue', 'Detail', 'Groups', 'Audit', 'Settings'];

  function showTab(name) {
    TABS.forEach(function (t) {
      var sec = $('tab' + t);
      if (sec) sec.classList.toggle('hidden', t !== name);
    });
    ['Queue', 'Groups', 'Audit', 'Settings'].forEach(function (t) {
      var btn = $('tabBtn' + t);
      if (!btn) return;
      var on = (t === name) || (t === 'Queue' && name === 'Detail');
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  ['Queue', 'Groups', 'Audit', 'Settings'].forEach(function (t) {
    $('tabBtn' + t).addEventListener('click', function () {
      showTab(t);
      if (t === 'Groups') loadGroups();
      if (t === 'Audit') loadAudit();
      if (t === 'Settings') loadSettings();
    });
  });

  /* ---------- stats / chips ---------- */

  function paintStats() {
    var c = state.counts;
    $('statTotal').textContent = state.rows.length
      ? Object.keys(c).reduce(function (a, k) { return a + c[k]; }, 0) : 0;
    $('statPending').textContent = c.pending || 0;
    $('statApproved').textContent = c.approved || 0;
    $('statRejected').textContent = c.rejected || 0;
    $('statWaitlisted').textContent = c.waitlisted || 0;
    $('statNeeds').textContent = c.needs_changes || 0;
    $('slotLine').textContent = state.remaining !== null
      ? 'approved / ' + state.slotLimit + ' slots · ' + state.remaining + ' left'
      : 'approved / ' + state.slotLimit + ' slots';
    $('chipAll').textContent = Object.keys(c).reduce(function (a, k) { return a + c[k]; }, 0);
    $('chipPending').textContent = c.pending || 0;
    $('chipApproved').textContent = c.approved || 0;
    $('chipRejected').textContent = c.rejected || 0;
    $('chipWaitlisted').textContent = c.waitlisted || 0;
    $('chipNeeds').textContent = c.needs_changes || 0;
    $('groupSlots').textContent = 'Approved ' + (c.approved || 0) + ' / ' + state.slotLimit;
    $('unassignedCount').textContent = '(' + state.unassigned.length + ')';
    renderNotify();
  }

  /* ---------- notification queue health ---------- */

  function renderNotify() {
    var banner = $('notifyBanner');
    if (!banner) return;
    var n = state.notify;
    if (!n) { banner.classList.add('hidden'); return; }
    var parts = [];
    if (n.failed) parts.push(n.failed + ' failed');
    if (n.pending) parts.push(n.pending + ' pending');
    if (!parts.length && !state.smtp) {
      /* SMTP off is a configuration choice, not an error — quiet note */
      banner.classList.add('hidden');
      return;
    }
    if (!parts.length) { banner.classList.add('hidden'); return; }
    $('notifyText').textContent =
      'Email queue: ' + parts.join(', ') +
      (state.smtp ? '' : ' (SMTP not configured — jobs will skip)');
    $('notifyRetry').hidden = !n.failed;
    banner.classList.remove('hidden');
  }

  if ($('notifyRetry')) {
    $('notifyRetry').addEventListener('click', function () {
      this.disabled = true;
      api('/api/admin/notifications/retry', { method: 'POST', body: {} })
        .then(function (x) {
          if (x.s === 200) {
            $('autoNotice').textContent =
              '✓ requeued ' + x.d.requeued + ' notification(s).';
            $('autoNotice').classList.remove('hidden');
          } else {
            fatal(x.d.error || 'Retry failed.');
          }
          loadQueue();
        })
        .catch(function () { fatal('Network hiccup retrying queue.'); });
    });
  }

  /* ---------- queue ---------- */

  function badge(status) {
    return '<span class="st-badge st-badge--' + status + '">' +
      esc(LABELS[status] || status) + '</span>';
  }

  function conflictHtml(cid) {
    var c = state.conflicts[cid];
    if (!c) return '';
    var parts = [];
    if (c.uids) parts.push('UID ' + c.uids.join(', ') + ' also on ' +
      (c.uidTeams || []).join(', '));
    if (c.phone) parts.push('phone shared with ' + (c.phoneTeams || []).join(', '));
    if (c.name) parts.push('team name shared with ' + (c.nameTeams || []).join(', '));
    return '<div class="adm-conflict" role="alert">&#9888; ' + esc(parts.join(' · ')) + '</div>';
  }

  function rowHtml(r) {
    var st = r.status || 'pending';
    var checked = state.selected[r.team_id] ? ' checked' : '';
    var conflict = state.conflicts[r.team_id] ? ' adm-tr--warn' : '';
    var reqBadge = r.open_requests
      ? ' <span class="adm-req-badge" title="Open change requests">' + r.open_requests + '</span>' : '';
    return '<tr class="adm-tr' + conflict + '" data-id="' + esc(r.team_id) + '">' +
      '<td class="adm-td-check"><input type="checkbox" class="row-check" data-id="' +
        esc(r.team_id) + '"' + checked + ' aria-label="Select ' + esc(r.team_name) + '"></td>' +
      '<td><b>' + esc(r.team_name) + '</b> <span class="adm-tag">[' + esc(r.team_tag) + ']</span>' +
        '<div class="adm-sub">' + esc(r.reg_code || r.team_id) + ' · ' + esc(r.guild_name) + '</div>' +
        conflictHtml(r.team_id) + '</td>' +
      '<td>' + esc(r.cap_ign) + '<div class="adm-sub">UID ' + esc(r.cap_uid) + '</div></td>' +
      '<td>' + badge(st) + reqBadge + '</td>' +
      '<td>' + (r.group_name ? esc(r.group_name) : '<span class="adm-dim">—</span>') + '</td>' +
      '<td class="adm-td-date">' + esc(fmtDate(r.created_at)) + '</td>' +
      '<td class="adm-acts">' +
        '<button class="adm-act adm-act--open" data-act="open">Open</button>' +
        '<button class="adm-act adm-act--go" data-act="approved" title="Approve">✓</button>' +
        '<button class="adm-act adm-act--no" data-act="rejected" title="Reject (reason)">✕</button>' +
        '<button class="adm-act" data-act="waitlisted" title="Waitlist">⏳</button>' +
        '<button class="adm-act" data-act="needs_changes" title="Request changes (note)">✎</button>' +
      '</td></tr>';
  }

  function renderQueue() {
    var rows = state.rows;
    queueBody.innerHTML = rows.map(rowHtml).join('');
    $('emptyState').classList.toggle('hidden', rows.length > 0);
    $('updatedAt').textContent = 'just now';
    paintStats();
    syncSelUi();
  }

  function loadQueue() {
    var params = '?q=' + encodeURIComponent(state.q) +
      '&status=' + state.status + '&sort=' + state.sort;
    return api('/api/admin/registrations' + params).then(function (x) {
      if (x.s !== 200) { fatal(x.d.error || 'Queue failed to load.'); return; }
      state.rows = x.d.registrations;
      state.counts = x.d.counts;
      state.slotLimit = x.d.slot_limit;
      state.approved = x.d.approved;
      state.remaining = typeof x.d.remaining === 'number'
        ? x.d.remaining : null;
      state.notify = x.d.notify || null;
      state.conflicts = x.d.conflicts;
      renderQueue();
    }).catch(function () { fatal('Network hiccup loading the queue.'); });
  }

  /* ---------- selection + bulk ---------- */

  function selectedIds() {
    return Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
  }

  function syncSelUi() {
    var n = selectedIds().length;
    $('selCount').textContent = n + ' selected';
    $('bulkApprove').disabled = !n;
    $('bulkReject').disabled = !n;
    $('selAll').checked = n > 0 && n === state.rows.length;
  }

  $('selAll').addEventListener('change', function () {
    var on = $('selAll').checked;
    state.rows.forEach(function (r) { state.selected[r.team_id] = on; });
    if (!on) state.selected = {};
    renderQueue();
  });

  queueBody.addEventListener('change', function (e) {
    var cb = e.target.closest('.row-check');
    if (!cb) return;
    state.selected[cb.dataset.id] = cb.checked;
    syncSelUi();
  });

  function applyStatus(ids, status, note, override) {
    if (ids.length === 1) {
      return api('/api/admin/registrations/' + ids[0] + '/status', {
        method: 'POST', body: { status: status, note: note || '', override: !!override }
      }).then(function (x) { return { one: x, ids: ids }; });
    }
    return api('/api/admin/bulk-status', {
      method: 'POST', body: { teamIds: ids, status: status, note: note || '', override: !!override }
    }).then(function (x) { return { bulk: x, ids: ids }; });
  }

  function handleStatusResult(res, status) {
    var x = res.one || res.bulk;
    if (!x) { fatal('Request failed.'); return; }
    if (x.s === 200) {
      var msg = 'Status updated.';
      if (res.bulk) {
        var errs = res.bulk.d.errors || [];
        var okN = (res.bulk.d.done || []).length;
        msg = okN + ' team(s) updated' +
          (errs.length ? ', ' + errs.length + ' failed — first: ' + errs[0].error : '.');
      }
      $('autoNotice').textContent = msg;
      if (res.bulk && res.bulk.d.errors && res.bulk.d.errors.length &&
          res.bulk.d.errors[0].error.indexOf('Slot limit') === 0) {
        if (confirm(res.bulk.d.errors[0].error + '\n\nOverride and approve anyway?')) {
          return applyStatus(res.ids, status, '', true).then(function (r) {
            handleStatusResult(r, status);
          });
        }
      }
      state.selected = {};
      loadQueue();
      if (state.detail && res.ids.indexOf(state.detail.team_id) >= 0) openDetail(state.detail.team_id);
      return;
    }
    if (x.s === 400 && x.d.field === 'slotLimit') {
      if (confirm(x.d.error + '\n\nOverride and approve anyway?')) {
        return applyStatus(res.ids, status, '', true).then(function (r) {
          handleStatusResult(r, status);
        });
      }
      return;
    }
    fatal(x.d.error || 'Status change failed.');
  }

  function statusAction(ids, status, override) {
    if (!ids.length) return;
    /* every bulk action states exactly how many teams it touches */
    if (ids.length > 1 && !override) {
      var verb = status === 'approved' ? 'Approve' :
                 status === 'rejected' ? 'Reject' :
                 status === 'waitlisted' ? 'Waitlist' : 'Flag';
      var detail = status === 'approved'
        ? '\nSlots after this: ' + state.approved + ' / ' + state.slotLimit +
          (state.remaining !== null ? ' (' + state.remaining + ' free now)' : '') + '.'
        : '';
      if (!confirm(verb + ' ' + ids.length + ' teams?' + detail)) return;
    }
    var note = '';
    if (status === 'rejected') {
      note = window.prompt('Reason (optional, shown to the team):', '') || '';
      if (note === null) return;
    } else if (status === 'waitlisted') {
      note = window.prompt('Note for the team (optional):', '') || '';
      if (note === null) return;
    } else if (status === 'needs_changes') {
      note = window.prompt('What should the team fix? (required, shown on /status)', '');
      if (!note || !note.trim()) { if (note === null) return; fatal('A note is required for "needs changes".'); return; }
    }
    if (status !== 'approved' && ids.length === 1) {
      var row = state.rows.filter(function (r) { return r.team_id === ids[0]; })[0];
      if (row && (row.status || '') === 'approved' && row.group_id) {
        if (!confirm(row.team_name + ' sits in ' + (row.group_name || 'a group') +
                     '.\nLeaving Approved removes it from the group. Continue?')) return;
      }
    }
    applyStatus(ids, status, note.trim(), override).then(function (res) {
      handleStatusResult(res, status);
    }).catch(function () { fatal('Network hiccup.'); });
  }

  $('bulkApprove').addEventListener('click', function () {
    statusAction(selectedIds(), 'approved');
  });
  $('bulkReject').addEventListener('click', function () {
    statusAction(selectedIds(), 'rejected');
  });

  queueBody.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-act');
    if (!btn) return;
    var id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'open') { openDetail(id); return; }
    statusAction([id], btn.dataset.act);
  });

  /* ---------- toolbar ---------- */

  var searchTimer = null;
  $('searchInput').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.q = $('searchInput').value.trim();
      loadQueue();
    }, 250);
  });

  $('sortSelect').addEventListener('change', function () {
    state.sort = $('sortSelect').value;
    loadQueue();
  });

  $('statusChips').addEventListener('click', function (e) {
    var chip = e.target.closest('.adm-chip');
    if (!chip) return;
    state.status = chip.dataset.status;
    document.querySelectorAll('.adm-chip').forEach(function (c) {
      var on = c === chip;
      c.classList.toggle('adm-chip--active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    loadQueue();
  });

  $('refreshBtn').addEventListener('click', function () {
    loadQueue();
    loadGroupsSilent();
  });

  /* ---------- copy status message ---------- */

  function statusMessage(d) {
    var lines = [
      'BGMI Cup Noida 2026 — ' + d.team_name + ' (' + (d.reg_code || d.team_id) + ')',
      'Status: ' + LABELS[d.status || 'pending']
    ];
    if (d.status_note) lines.push('Note: ' + d.status_note);
    if (d.group_name) lines.push('Group: ' + d.group_name);
    if (d.schedule_note) lines.push('Schedule: ' + d.schedule_note);
    lines.push('Check anytime: ' + location.origin + '/status');
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  /* ---------- detail ---------- */

  function rosterRowHtml(m) {
    var isSub = String(m.slot).charAt(0) === 'S';
    return '<tr class="adm-rs" data-slot="' + esc(m.slot) + '">' +
      '<td><span class="adm-slot">' + esc(m.slot) + '</span></td>' +
      '<td><input class="adm-mini" data-k="role" value="' + esc(m.role) + '"' +
        (isSub ? ' readonly' : '') + ' aria-label="Role ' + esc(m.slot) + '"></td>' +
      '<td><input class="adm-mini" data-k="ign" value="' + esc(m.ign) + '" required aria-label="IGN ' + esc(m.slot) + '"></td>' +
      '<td><input class="adm-mini" data-k="uid" inputmode="numeric" value="' + esc(m.uid) + '" required aria-label="UID ' + esc(m.slot) + '"></td>' +
      (isSub ? '<td><button type="button" class="adm-act adm-act--no rsub-del" title="Remove sub">✕</button></td>' : '<td></td>') +
      '</tr>';
  }

  function detailHtml(d) {
    var st = d.status || 'pending';
    var canGroups = st === 'approved';
    var groupOpts = '<option value="0">— no group —</option>' + state.groups.map(function (g) {
      var sel = d.group_id === g.id ? ' selected' : '';
      return '<option value="' + g.id + '"' + sel + '>' + esc(g.name) +
        ' (' + g.count + '/' + g.size + ')' + (g.locked ? ' 🔒' : '') + '</option>';
    }).join('');

    var conf = '';
    if (d.conflicts && (d.conflicts.uids || d.conflicts.phone || d.conflicts.name)) {
      var citems = [];
      if (d.conflicts.uids) {
        citems.push('UID ' + d.conflicts.uids.join(', ') + ' also on ' +
          (d.conflicts.uidTeams || []).join(', '));
      }
      if (d.conflicts.phone) {
        citems.push('Phone shared with ' + (d.conflicts.phoneTeams || []).join(', '));
      }
      if (d.conflicts.name) {
        citems.push('Team name shared with ' + (d.conflicts.nameTeams || []).join(', '));
      }
      conf = '<div class="adm-panel adm-panel--warn" role="alert">' +
        '<b>&#9888; Duplicate / conflict warnings</b><ul>' +
        citems.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') +
        '</ul></div>';
    }

    var reqs = (d.requests || []).length
      ? '<div class="adm-panel"><b>Change requests from the team</b><ul class="adm-reqs">' +
        d.requests.map(function (r) {
          return '<li' + (r.seen ? ' class="seen"' : '') + '>' +
            '<span class="adm-sub">' + esc(fmtDate(r.created_at)) + '</span>' +
            '<p>' + esc(r.message) + '</p>' +
            (r.seen ? '<span class="adm-dim">seen</span>'
                    : '<button class="adm-act" data-req="' + r.id + '">Mark seen</button>') +
            '</li>';
        }).join('') + '</ul></div>'
      : '';

    return '' +
      '<div class="adm-detail-head">' +
        '<div><div class="adm-eyebrow">' + esc(d.reg_code || d.team_id) + '</div>' +
        '<h2 class="adm-dtitle">' + esc(d.team_name) + ' <span class="adm-tag">[' + esc(d.team_tag) + ']</span></h2></div>' +
        '<div class="adm-detail-status">' + badge(st) +
          '<button class="adm-act adm-act--go" data-dact="approved">✓ Approve</button>' +
          '<button class="adm-act adm-act--no" data-dact="rejected">✕ Reject</button>' +
          '<button class="adm-act" data-dact="waitlisted">⏳ Waitlist</button>' +
          '<button class="adm-act" data-dact="needs_changes">✎ Request changes</button>' +
          '<button class="adm-act" id="copyStatus">⧉ Copy status</button>' +
        '</div>' +
      '</div>' +
      conf + reqs +
      '<form id="editForm" class="adm-grid" autocomplete="off">' +
        '<div class="adm-panel">' +
          '<b>Team</b>' +
          '<label>Team name<input name="teamName" value="' + esc(d.team_name) + '" required></label>' +
          '<label>Tag<input name="teamTag" value="' + esc(d.team_tag) + '" maxlength="5" required></label>' +
          '<label>Guild name<input name="guildName" value="' + esc(d.guild_name) + '" required></label>' +
          '<label>Group<select name="group" id="groupSel"' + (canGroups ? '' : ' disabled') + '>' + groupOpts + '</select></label>' +
          '<label>Match schedule (shown on /status)<input name="scheduleNote" value="' + esc(d.schedule_note) + '" placeholder="e.g. Erangel 4PM IST, lobby 3:50"></label>' +
        '</div>' +
        '<div class="adm-panel">' +
          '<b>Captain / contact</b>' +
          '<label>Captain IGN<input name="capIgn" value="' + esc(d.cap_ign) + '" required></label>' +
          '<label>Captain UID<input name="capUid" value="' + esc(d.cap_uid) + '" inputmode="numeric" required></label>' +
          '<label>Email<input name="capEmail" type="email" value="' + esc(d.cap_email) + '" required></label>' +
          '<label>Phone<input name="capPhone" value="' + esc(d.cap_phone) + '" required></label>' +
          '<label>Discord<input name="capDiscord" value="' + esc(d.cap_discord || '') + '"></label>' +
        '</div>' +
        '<div class="adm-panel adm-panel--wide">' +
          '<b>Roster</b>' +
          '<table class="adm-roster"><thead><tr><th>Slot</th><th>Role</th><th>IGN</th><th>Character ID</th><th></th></tr></thead>' +
          '<tbody id="rosterBody">' + (d.roster || []).map(rosterRowHtml).join('') + '</tbody></table>' +
          '<button type="button" class="adm-act" id="addSub">+ Add substitute</button>' +
        '</div>' +
        '<div class="adm-panel adm-panel--wide">' +
          '<b>Admin-only note (never public)</b>' +
          '<label><textarea name="adminNote" rows="3" placeholder="internal notes…">' + esc(d.admin_note || '') + '</textarea></label>' +
        '</div>' +
        '<div class="adm-form-actions">' +
          '<button class="adm-btn adm-btn--go" type="submit">&#10003; Save changes</button>' +
          '<span class="adm-saved" id="savedTick" role="status"></span>' +
          '<span class="adm-form-actions-spacer"></span>' +
          '<button type="button" class="adm-btn adm-btn--no" id="deleteBtn">&#128465; Delete registration</button>' +
        '</div>' +
      '</form>' +
      '<div class="adm-panel"><b>History for this team</b><table class="adm-table adm-table--audit">' +
        '<thead><tr><th>When</th><th>Who</th><th>Action</th><th>Change</th></tr></thead>' +
        '<tbody id="teamAuditBody"><tr><td colspan="4">loading…</td></tr></tbody></table></div>';
  }

  function openDetail(id) {
    api('/api/admin/registrations/' + encodeURIComponent(id)).then(function (x) {
      if (x.s !== 200) { fatal(x.d.error || 'Could not open team.'); return; }
      state.detail = x.d.registration;
      $('detailBody').innerHTML = detailHtml(state.detail);
      showTab('Detail');
      wireDetail(state.detail);
      loadTeamAudit(id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }).catch(function () { fatal('Network hiccup.'); });
  }

  function loadTeamAudit(id) {
    api('/api/admin/audit?teamId=' + encodeURIComponent(id)).then(function (x) {
      if (x.s !== 200) return;
      var body = $('teamAuditBody');
      if (!body) return;
      if (!x.d.audit.length) {
        body.innerHTML = '<tr><td colspan="4" class="adm-dim">No changes logged yet.</td></tr>';
        return;
      }
      body.innerHTML = x.d.audit.map(function (a) {
        var change = a.old_value || a.new_value
          ? esc(a.old_value || '—') + ' → ' + esc(a.new_value || '—') : '';
        return '<tr><td>' + esc(fmtDate(a.at)) + '</td><td>' + esc(a.admin) + '</td>' +
          '<td>' + esc(a.action) + (a.field ? ' · ' + esc(a.field) : '') + '</td>' +
          '<td>' + change + '</td></tr>';
      }).join('');
    });
  }

  function collectRoster() {
    var rows = document.querySelectorAll('#rosterBody .adm-rs');
    var out = [];
    rows.forEach(function (tr) {
      out.push({
        slot: tr.dataset.slot,
        role: tr.querySelector('[data-k=role]').value,
        ign: tr.querySelector('[data-k=ign]').value,
        uid: tr.querySelector('[data-k=uid]').value
      });
    });
    return out;
  }

  function wireDetail(d) {
    $('editForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var body = {
        teamName: f.teamName.value, teamTag: f.teamTag.value,
        guildName: f.guildName.value, capIgn: f.capIgn.value,
        capUid: f.capUid.value, capEmail: f.capEmail.value,
        capPhone: f.capPhone.value, capDiscord: f.capDiscord.value,
        scheduleNote: f.scheduleNote.value, adminNote: f.adminNote.value,
        roster: collectRoster()
      };
      api('/api/admin/registrations/' + encodeURIComponent(d.team_id), {
        method: 'PUT', body: body
      }).then(function (x) {
        if (x.s === 200) {
          $('savedTick').textContent = '✓ saved ' + new Date().toLocaleTimeString('en-GB');
          state.detail = x.d.registration;
          loadQueue();
          setTimeout(function () { if ($('savedTick')) $('savedTick').textContent = ''; }, 4000);
        } else {
          fatal((x.d.error || 'Save failed.') + (x.d.field ? ' [' + x.d.field + ']' : ''));
        }
      }).catch(function () { fatal('Network hiccup.'); });
    });

    // group assignment (only approved teams)
    var gsel = $('groupSel');
    if (gsel) {
      gsel.addEventListener('change', function () {
        var gid = parseInt(gsel.value, 10);
        if (gid === 0) {
          if (!confirm('Remove ' + d.team_name + ' from its group?')) {
            gsel.value = d.group_id || 0;
            return;
          }
        }
        api('/api/admin/groups/' + gid + '/assign', {
          method: 'POST', body: { teamId: d.team_id }
        }).then(function (x) {
          if (x.s === 200) {
            loadQueue();
            loadGroupsSilent();
            openDetail(d.team_id);
          } else {
            fatal(x.d.error || 'Assign failed.');
            gsel.value = d.group_id || 0;
          }
        });
      });
    }

    $('addSub').addEventListener('click', function () {
      var subs = document.querySelectorAll('#rosterBody .adm-rs[data-slot^="S"]');
      if (subs.length >= 2) { fatal('Max 2 substitutes.'); return; }
      var n = subs.length + 1;
      var tr = document.createElement('tr');
      tr.className = 'adm-rs';
      tr.dataset.slot = 'S' + n;
      tr.innerHTML = '<td><span class="adm-slot">S' + n + '</span></td>' +
        '<td><input class="adm-mini" data-k="role" value="Substitute" readonly aria-label="Role S' + n + '"></td>' +
        '<td><input class="adm-mini" data-k="ign" aria-label="IGN S' + n + '"></td>' +
        '<td><input class="adm-mini" data-k="uid" inputmode="numeric" aria-label="UID S' + n + '"></td>' +
        '<td><button type="button" class="adm-act adm-act--no rsub-del" title="Remove sub">✕</button></td>';
      $('rosterBody').appendChild(tr);
      tr.querySelector('[data-k=ign]').focus();
    });

    $('rosterBody').addEventListener('click', function (e) {
      var del = e.target.closest('.rsub-del');
      if (del) del.closest('.adm-rs').remove();
    });

    $('copyStatus').addEventListener('click', function () {
      copyText(statusMessage(state.detail)).then(function () {
        $('copyStatus').textContent = '✓ copied';
        setTimeout(function () {
          if ($('copyStatus')) $('copyStatus').textContent = '⧉ Copy status';
        }, 2000);
      });
    });

    $('deleteBtn').addEventListener('click', function () {
      if (!confirm('Delete ' + d.team_name + ' permanently?')) return;
      if (!confirm('Last chance — this also removes its logo and roster. Delete?')) return;
      api('/api/admin/registrations/' + encodeURIComponent(d.team_id), { method: 'DELETE' })
        .then(function (x) {
          if (x.s === 200) {
            state.detail = null;
            showTab('Queue');
            loadQueue();
          } else fatal(x.d.error || 'Delete failed.');
        });
    });
  }

  /* ---------- groups ---------- */

  function loadGroups() {
    return api('/api/admin/groups').then(function (x) {
      if (x.s !== 200) { fatal(x.d.error || 'Groups failed to load.'); return; }
      state.groups = x.d.groups;
      state.unassigned = x.d.unassigned;
      state.groupsLocked = x.d.locked;
      state.slotLimit = x.d.slot_limit;
      $('lockGlobal').checked = state.groupsLocked;
      renderGroups();
      paintStats();
    }).catch(function () { fatal('Network hiccup.'); });
  }

  function loadGroupsSilent() {
    api('/api/admin/groups').then(function (x) {
      if (x.s === 200) {
        state.groups = x.d.groups;
        state.unassigned = x.d.unassigned;
        state.groupsLocked = x.d.locked;
        paintStats();
      }
    });
  }

  function renderGroups() {
    var pool = state.unassigned.map(function (t) {
      return '<option value="' + esc(t.team_id) + '">' + esc(t.team_name) +
        ' [' + esc(t.team_tag) + '] ' + esc(t.reg_code || '') + '</option>';
    }).join('');

    $('groupsGrid').innerHTML = state.groups.map(function (g) {
      var full = g.count >= g.size;
      return '<div class="adm-group' + (g.locked ? ' adm-group--locked' : '') + '">' +
        '<div class="adm-group-head"><b>' + esc(g.name) + '</b>' +
          '<span class="adm-slots' + (full ? ' adm-slots--full' : '') + '">' +
          g.count + ' / ' + g.size + '</span>' +
          '<button class="adm-act" data-glock="' + g.id + '" title="' +
          (g.locked ? 'Unlock group' : 'Lock group') + '">' + (g.locked ? '🔒' : '🔓') + '</button>' +
          '<button class="adm-act adm-act--no" data-gdel="' + g.id + '" title="Delete group">✕</button>' +
        '</div>' +
        '<ul class="adm-group-list">' +
          (g.teams.length ? g.teams.map(function (t) {
            return '<li><span>' + esc(t.team_name) + ' <span class="adm-tag">[' +
              esc(t.team_tag) + ']</span></span>' +
              '<button class="adm-act" data-gunassign="' + esc(t.team_id) +
              '" title="Remove from group">✕</button></li>';
          }).join('') : '<li class="adm-dim">empty</li>') +
        '</ul>' +
        (g.locked ? '<p class="adm-dim">locked</p>'
          : '<div class="adm-group-assign"><select data-gsel="' + g.id +
            '" aria-label="Move an approved team into ' + esc(g.name) + '"><option value="">+ move team here…</option>' +
            pool + '</select></div>') +
        '</div>';
    }).join('') || '<p class="adm-dim">No groups yet — create some or auto-distribute.</p>';
  }

  $('groupsGrid').addEventListener('change', function (e) {
    var sel = e.target.closest('[data-gsel]');
    if (!sel || !sel.value) return;
    var gid = sel.dataset.gsel;
    var tid = sel.value;
    api('/api/admin/groups/' + gid + '/assign', { method: 'POST', body: { teamId: tid } })
      .then(function (x) {
        if (x.s !== 200) { fatal(x.d.error || 'Assign failed.'); }
        loadGroups();
        loadQueue();
      });
  });

  $('groupsGrid').addEventListener('click', function (e) {
    var un = e.target.closest('[data-gunassign]');
    if (un) {
      if (!confirm('Remove this team from its group?')) return;
      api('/api/admin/groups/0/assign', { method: 'POST', body: { teamId: un.dataset.gunassign } })
        .then(function () { loadGroups(); loadQueue(); });
      return;
    }
    var lock = e.target.closest('[data-glock]');
    if (lock) {
      api('/api/admin/groups/' + lock.dataset.glock, {
        method: 'PUT', body: { locked: !(state.groups.filter(function (g) {
          return String(g.id) === lock.dataset.glock; })[0] || {}).locked }
      }).then(function () { loadGroups(); });
      return;
    }
    var del = e.target.closest('[data-gdel]');
    if (del) {
      if (!confirm('Delete this group? Its teams become unassigned.')) return;
      api('/api/admin/groups/' + del.dataset.gdel, { method: 'DELETE' })
        .then(function () { loadGroups(); loadQueue(); });
    }
  });

  $('createForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('/api/admin/groups', {
      method: 'POST',
      body: {
        name: $('newGroupName').value.trim(),
        size: parseInt($('newGroupSize').value, 10)
      }
    }).then(function (x) {
      if (x.s === 200) {
        $('newGroupName').value = '';
        loadGroups();
      } else fatal(x.d.error || 'Create failed.');
    });
  });

  $('autoBtn').addEventListener('click', function () {
    var defCount = state.groups.length || 3;
    var countStr = window.prompt('How many groups? (1-26)', String(defCount));
    if (countStr === null) return;
    var sizeStr = window.prompt('Teams per group? (1-32)', '4');
    if (sizeStr === null) return;
    var count = parseInt(countStr, 10), size = parseInt(sizeStr, 10);
    if (!(count >= 1 && count <= 26 && size >= 1 && size <= 32)) {
      fatal('Need 1-26 groups of size 1-32.'); return;
    }
    var rebuildAns = window.prompt(
      'Teams already in a group: keep them where they are (leave blank)\n' +
      'or reshuffle every unlocked group (type R)?', '');
    if (rebuildAns === null) return;
    var rebuild = rebuildAns.trim().toUpperCase() === 'R';

    /* preview first — the plan is shown, nothing is saved yet */
    api('/api/admin/groups/auto', {
      method: 'POST', body: { count: count, size: size, preview: true, rebuild: rebuild }
    }).then(function (x) {
      if (x.s !== 200) { fatal(x.d.error || 'Preview failed.'); return; }
      var lines = (x.d.plan || []).map(function (g) {
        return g.name + ' (' + g.teams.length + '/' + g.size + '): ' +
          (g.teams.length ? g.teams.join(', ') : '—');
      });
      var note = x.d.overflow
        ? '\n\n⚠ ' + x.d.overflow + ' team(s) beyond capacity remain in the last group.'
        : '';
      if (!confirm('PREVIEW — nothing is saved yet:\n\n' + lines.join('\n') +
                   note + '\n\nApply this plan?')) return;
      api('/api/admin/groups/auto', {
        method: 'POST', body: { count: count, size: size, rebuild: rebuild }
      }).then(function (y) {
        if (y.s === 200) {
          loadGroups();
          loadQueue();
          $('autoNotice').textContent = '✓ auto-distributed: ' + y.d.moved +
            ' team(s) placed' + (y.d.overflow ? ' (' + y.d.overflow + ' over capacity)' : '') + '.';
          $('autoNotice').classList.remove('hidden');
        } else fatal(y.d.error || 'Auto-distribute failed.');
      });
    }).catch(function () { fatal('Network hiccup running the preview.'); });
  });

  $('lockGlobal').addEventListener('change', function () {
    api('/api/admin/settings', {
      method: 'POST', body: { groups_locked: $('lockGlobal').checked }
    }).then(function () { loadGroups(); });
  });

  $('printBtn').addEventListener('click', function () {
    document.body.classList.add('printing');
    window.print();
    setTimeout(function () { document.body.classList.remove('printing'); }, 800);
  });

  /* ---------- audit ---------- */

  function loadAudit() {
    api('/api/admin/audit?limit=200').then(function (x) {
      if (x.s !== 200) { fatal(x.d.error || 'Audit failed to load.'); return; }
      var body = $('auditBody');
      if (!x.d.audit.length) {
        body.innerHTML = '';
        $('auditEmpty').classList.remove('hidden');
        return;
      }
      $('auditEmpty').classList.add('hidden');
      body.innerHTML = x.d.audit.map(function (a) {
        var change = (a.old_value || a.new_value)
          ? esc(a.old_value == null ? '—' : a.old_value) + ' → ' +
            esc(a.new_value == null ? '—' : a.new_value) : '';
        return '<tr><td>' + esc(fmtDate(a.at)) + '</td><td>' + esc(a.admin) + '</td>' +
          '<td>' + esc(a.team_id || '—') + '</td><td>' + esc(a.action) +
          (a.field ? ' · ' + esc(a.field) : '') + '</td><td>' + change + '</td></tr>';
      }).join('');
    }).catch(function () { fatal('Network hiccup.'); });
  }

  /* ---------- settings ---------- */

  function loadSettings() {
    api('/api/admin/settings').then(function (x) {
      if (x.s !== 200) return;
      $('slotInput').value = x.d.slot_limit;
      $('pubTeams').checked = x.d.public_teams;
      $('schedTimezone').value = x.d.timezone || 'Asia/Kolkata';
      $('schedNote').value = x.d.schedule_note || '';
      $('schedUpdated').textContent = x.d.schedule_updated
        ? 'Last published: ' + fmtDate(x.d.schedule_updated) : '';
      $('smtpLine').textContent = x.d.smtp
        ? 'SMTP is configured — teams get an email on every status change.'
        : 'No SMTP configured (set BGMI_SMTP_* env vars). Status still updates on /status instantly; mails are skipped silently.';
      state.smtp = x.d.smtp;
      state.publicTeams = x.d.public_teams;
      state.slotLimit = x.d.slot_limit;
    });
  }

  $('slotForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('/api/admin/settings', {
      method: 'POST', body: { slot_limit: parseInt($('slotInput').value, 10) }
    }).then(function (x) {
      if (x.s === 200) { fatal(''); loadQueue(); }
      else fatal(x.d.error || 'Save failed.');
    });
  });

  $('pubTeams').addEventListener('change', function () {
    api('/api/admin/settings', {
      method: 'POST', body: { public_teams: $('pubTeams').checked }
    }).then(function (x) {
      if (x.s !== 200) fatal(x.d.error || 'Save failed.');
      else state.publicTeams = $('pubTeams').checked;
    });
  });

  if ($('schedForm')) {
    $('schedForm').addEventListener('submit', function (e) {
      e.preventDefault();
      api('/api/admin/settings', {
        method: 'POST',
        body: {
          timezone: $('schedTimezone').value.trim() || 'Asia/Kolkata',
          schedule_note: $('schedNote').value
        }
      }).then(function (x) {
        if (x.s === 200) {
          $('autoNotice').textContent = '✓ schedule published to /schedule.';
          $('autoNotice').classList.remove('hidden');
          loadSettings();
        } else fatal(x.d.error || 'Schedule save failed.');
      });
    });
  }

  $('purgeBtn').addEventListener('click', function () {
    $('purgeForm').classList.remove('hidden');
    $('purgeInput').focus();
  });
  $('purgeCancel').addEventListener('click', function () {
    $('purgeForm').classList.add('hidden');
    $('purgeInput').value = '';
  });
  $('purgeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!confirm('FINAL CHECK: purge EVERY registration, roster, logo, group and request?')) return;
    api('/api/admin/purge', {
      method: 'POST', body: { confirm: $('purgeInput').value }
    }).then(function (x) {
      if (x.s === 200) {
        $('purgeInput').value = '';
        $('purgeForm').classList.add('hidden');
        loadQueue();
        loadGroupsSilent();
        alert('Purged ' + x.d.removed + ' registrations.');
      } else fatal(x.d.error || 'Purge failed.');
    });
  });

  /* ---------- session / misc ---------- */

  function logout() {
    api('/api/admin/logout', { method: 'POST', body: {} })
      .then(function () { location.href = '/admin'; })
      .catch(function () { location.href = '/admin'; });
  }
  $('logoutBtn').addEventListener('click', logout);
  $('logoutNavBtn').addEventListener('click', function (e) {
    e.preventDefault();
    logout();
  });

  /* wired once — detailBody content is re-rendered wholesale */
  $('backBtn').addEventListener('click', function () {
    state.detail = null;
    showTab('Queue');
    loadQueue();
  });

  $('detailBody').addEventListener('click', function (e) {
    if (!state.detail) return;
    var act = e.target.closest('[data-dact]');
    if (act) { statusAction([state.detail.team_id], act.dataset.dact); return; }
    var req = e.target.closest('[data-req]');
    if (req) {
      api('/api/admin/registrations/' + encodeURIComponent(state.detail.team_id) +
          '/requests/' + req.dataset.req + '/seen', { method: 'POST', body: {} })
        .then(function () {
          openDetail(state.detail.team_id);
          loadQueue();
        });
    }
  });

  /* navbar (same behaviour as other pages) */
  (function () {
    var navbar = document.getElementById('navbar');
    function onScroll() { navbar.classList.toggle('scrolled', window.scrollY > 60); }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    var toggle = document.getElementById('navToggle');
    var links = document.getElementById('navLinks');
    var overlay = document.getElementById('navOverlay');
    function closeNav() {
      toggle.classList.remove('active');
      links.classList.remove('open');
      overlay.classList.add('hidden');
    }
    toggle.addEventListener('click', function () {
      if (links.classList.contains('open')) closeNav();
      else {
        toggle.classList.add('active');
        links.classList.add('open');
        overlay.classList.remove('hidden');
      }
    });
    overlay.addEventListener('click', closeNav);
    links.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', closeNav); });
  })();

  /* boot: prove the session, then load everything */
  api('/api/admin/me').then(function (x) {
    if (x.s !== 200) { location.href = '/admin'; return; }
    csrf = x.d.csrf;
    $('whoAmI').textContent = x.d.username;
    return loadQueue().then(loadGroups).then(loadSettings);
  }).catch(function () { fatal('Could not reach the server.'); });
})();
