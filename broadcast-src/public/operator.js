const socket = io();
const $ = (id) => document.getElementById(id);

async function loadOperatorIdentity() {
  try {
    const response = await fetch("/api/auth/me", {
      credentials: "same-origin",
    });
    if (!response.ok) {
      location.replace("/login");
      return;
    }
    const payload = await response.json();
    // Development login bypass: the server hands out an admin session, so the
    // sign-out button would only drop us back onto the same dashboard.
    if (payload.loginBypass) {
      const logout = $("logoutBtn");
      if (logout) {
        logout.style.display = "none";
        logout.setAttribute("aria-hidden", "true");
      }
    }
    const username = payload.user?.username || "Operator";
    const name = $("operatorName");
    if (name) name.textContent = username;
    const avatar = $("userAvatar");
    if (avatar) avatar.textContent = username.charAt(0).toUpperCase();
    const healthResponse = await fetch("/api/health");
    if (healthResponse.ok) {
      const health = await healthResponse.json();
      const el = $("storageMode");
      if (el) el.textContent = health.storageMode || "LOCAL STORAGE";
    }
  } catch {
    /* socket connection indicator reports backend availability */
  }
}
$("logoutBtn")?.addEventListener("click", async () => {
  if (!confirm("Sign out of the operator dashboard?")) return;
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } finally {
    location.replace("/login");
  }
});
// ---------------------------------------------------------------------------
// NAVIGATION PANEL TOGGLE
// The operator can fold the sidebar away so the squad controls (or any table)
// get the whole screen, and unfold it with the same button. The choice is
// remembered per browser, and a floating button keeps the panel reachable while
// scrolling through a long live-controls page.
// ---------------------------------------------------------------------------
const SIDEBAR_KEY = "bgmi.sidebarHidden";
const sidebarCollapsed = () =>
  document.body.classList.contains("sidebar-collapsed");
function applySidebarState(hidden, { persist = true } = {}) {
  document.body.classList.toggle("sidebar-collapsed", Boolean(hidden));
  const button = $("navToggle");
  if (button) {
    button.setAttribute("aria-expanded", String(!hidden));
    button.title = hidden
      ? "Show the navigation panel"
      : "Hide the navigation panel";
  }
  const floating = $("navToggleFloat");
  if (floating) {
    floating.setAttribute("aria-expanded", String(hidden));
    floating.title = hidden
      ? "Show the navigation panel"
      : "Hide the navigation panel";
  }
  if (!persist) return;
  try {
    localStorage.setItem(SIDEBAR_KEY, hidden ? "1" : "0");
  } catch {
    /* private browsing — the toggle still works for this session */
  }
}
function toggleSidebar() {
  applySidebarState(!sidebarCollapsed());
}
$("navToggle")?.addEventListener("click", toggleSidebar);
$("navToggleFloat")?.addEventListener("click", toggleSidebar);
try {
  applySidebarState(localStorage.getItem(SIDEBAR_KEY) === "1", {
    persist: false,
  });
} catch {
  applySidebarState(false, { persist: false });
}

socket.on("connect_error", (err) => {
  if ((err.message || "").toLowerCase().includes("unauthorized"))
    location.replace("/login");
});
loadOperatorIdentity();

let state = null,
  registrations = [],
  activePage = "overview",
  collapsedSquads = new Set(),
  standingsMode = "overall",
  registrationFilter = "pending",
  toastTimer,
  pendingTeamEdits = new Map(),
  pendingMatchTeamIds = null,
  lineupDirty = false;
const pageMeta = {
  overview: [
    "OVERVIEW",
    "Production overview",
    "Monitor match operations, scoring and broadcast readiness.",
  ],
  "match-setup": [
    "MATCH SETUP",
    "Match setup & squad selection",
    "Configure the lobby, map and the 16-squad lineup for this match.",
  ],
  "live-controls": [
    "LIVE OPERATIONS",
    "Live squad controls",
    "One workspace for finishes, player status, damage and roster edits.",
  ],
  teams: [
    "TEAMS & GROUPS",
    "Teams & group allocation",
    "Manage squad names, players and group assignments.",
  ],
  standings: [
    "RESULTS & STANDINGS",
    "Results & standings",
    "Review official results, cumulative points and qualification.",
  ],
  broadcast: [
    "BROADCAST CONTROL",
    "Broadcast control",
    "Manage the on-air graphic state connected to your OBS overlay.",
  ],
  settings: [
    "TOURNAMENT SETUP",
    "Tournament setup",
    "Configure event identity, scoring, registration and qualification slots.",
  ],
  registrations: [
    "TEAM INTAKE",
    "Team registration desk",
    "Review incoming team registrations and publish approved rosters directly to tournament operations.",
  ],
};
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
}
function safe(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function fmtDate(value) {
  try {
    return new Date(value).toLocaleString([], {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
function sortedOverall() {
  return [...(state?.teams || [])].sort(
    (a, b) =>
      b.overallPoints - a.overallPoints ||
      b.overallKills - a.overallKills ||
      a.name.localeCompare(b.name),
  );
}
function sortedCurrent() {
  return [...(state?.teams || [])].sort(
    (a, b) =>
      (a.placement || 999) - (b.placement || 999) ||
      b.kills - a.kills ||
      a.name.localeCompare(b.name),
  );
}
// "live" was a single combined page before the squad-control split.
const PAGE_ALIASES = { live: "live-controls" };
function showPage(page) {
  page = PAGE_ALIASES[page] || page;
  if (!pageMeta[page]) return;
  activePage = page;
  document
    .querySelectorAll(".page")
    .forEach((el) => el.classList.toggle("active", el.id === `page-${page}`));
  document
    .querySelectorAll(".nav-item")
    .forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("pageCrumb").textContent = pageMeta[page][0];
  $("pageTitle").textContent = pageMeta[page][1];
  $("pageDescription").textContent = pageMeta[page][2];
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document
  .querySelectorAll("[data-page]")
  .forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));
document
  .querySelectorAll("[data-goto]")
  .forEach((b) => b.addEventListener("click", () => showPage(b.dataset.goto)));
socket.on("connect", () => {
  $("connection").textContent = "CONNECTED";
  $("connectionDot").classList.add("online");
  toast("Control server connected.");
});
socket.on("disconnect", () => {
  $("connection").textContent = "DISCONNECTED";
  $("connectionDot").classList.remove("online");
  toast("Connection lost. Changes are not being submitted.");
});
socket.on("operator:error", (message) => toast(message));
socket.on("tournament:update", (data) => {
  state = data;
  if (!lineupDirty) pendingMatchTeamIds = [...(data.matchTeamIds || [])];
  render();
});
socket.on("registrations:update", (data) => {
  registrations = Array.isArray(data) ? data : [];
  renderRegistrations();
});
socket.on("registration:reviewed", (data) =>
  toast(
    `Registration ${data.status}${data.teamId ? ` · assigned team slot #${data.teamId}` : ""}`,
  ),
);
function render() {
  if (!state) return;
  const name = state.tournamentName || "BGMI TOURNAMENT";
  $("sideEventName").textContent = name;
  $("overviewEventName").textContent = name;
  $("overviewEventMeta").textContent =
    `${state.registrationCount || 0} approved teams · ${state.format || "Tournament series"} · ${state.organizer || "Production workspace"}`;
  $("overviewMatch").textContent =
    `MATCH ${String(state.currentMatch).padStart(2, "0")}`;
  $("overviewMap").textContent =
    `${state.currentMap || "ERANGEL"} · GROUP ${state.currentGroup || "A"}`;
  $("statTeams").textContent =
    `${state.registrationCount || state.teams.filter((t) => t.registered).length || 0} / ${state.registrationSettings?.maxTeams || 96}`;
  $("registrationNavCount").textContent =
    `${state.pendingRegistrationCount || registrations.filter((r) => r.status === "pending").length} NEW`;
  $("regApprovedCount").textContent =
    state.registrationCount ||
    state.teams.filter((t) => t.registered).length ||
    0;
  $("regPendingCount").textContent =
    state.pendingRegistrationCount ||
    registrations.filter((r) => r.status === "pending").length;
  $("regCapacityCount").textContent =
    `${state.reservedRegistrationCount ?? (state.registrationCount || 0) + (state.pendingRegistrationCount || 0)} / ${state.registrationSettings?.maxTeams || 96}`;
  $("regCapacityNote").textContent =
    `${Math.max(0, (state.registrationSettings?.maxTeams || 96) - (state.reservedRegistrationCount ?? (state.registrationCount || 0) + (state.pendingRegistrationCount || 0)))} slots remaining`;
  $("regOpenState").textContent =
    state.registrationSettings?.open === false ? "CLOSED" : "OPEN";
  $("statMatches").textContent = (state.matchHistory || []).length;
  const leader = sortedOverall()[0];
  $("statLeader").textContent =
    leader && leader.overallPoints > 0 ? leader.name : "—";
  $("leaderPoints").textContent =
    leader && leader.overallPoints > 0
      ? `${leader.overallPoints} overall points`
      : "No points published yet";
  const status = (state.matchStatus || "upcoming")
    .toUpperCase()
    .replaceAll("-", " ");
  $("statStatus").textContent = status;
  $("statusHelp").textContent =
    {
      UPCOMING: "Ready for operator setup",
      LIVE: "Live event controls enabled",
      "AWAITING VERIFICATION": "Review scores before publishing",
      VERIFIED: "Official results are locked",
    }[status] || "Match status";
  const statusPillState =
    status === "LIVE"
      ? "live"
      : status === "VERIFIED"
        ? "verified"
        : status === "AWAITING VERIFICATION"
          ? "review"
          : "upcoming";
  ["matchSetupStatusPill", "liveControlsStatusPill"].forEach((id) => {
    const pill = $(id);
    if (!pill) return;
    pill.textContent = `● ${status}`;
    pill.classList.remove("live", "verified", "review", "upcoming");
    pill.classList.add(statusPillState);
  });
  $("liveNavStatus").textContent =
    status === "LIVE" ? "ON AIR" : status === "VERIFIED" ? "LOCKED" : "READY";
  renderSetupBar(status);
  $("onAirText").textContent = (state.broadcastState || "pre-show")
    .toUpperCase()
    .replaceAll("-", " ");
  $("broadcastCurrent").textContent = $("onAirText").textContent;
  $("matchNumberInput").value = state.currentMatch;
  $("matchGroupInput").value = state.currentGroup || "A";
  $("matchMapInput").value = state.currentMap || "Erangel";
  document
    .querySelectorAll("[data-scene]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.scene === state.broadcastState),
    );
  document
    .querySelectorAll("[data-stream-start]")
    .forEach((b) =>
      b.classList.toggle("active", state.broadcastState === "stream-start"),
    );
  document
    .querySelectorAll("[data-mvp-mode]")
    .forEach((b) =>
      b.classList.toggle(
        "active",
        state.broadcastState === "mvp" &&
          b.dataset.mvpMode === (state.production?.mvpMode || "match"),
      ),
    );
  document
    .querySelectorAll("[data-countdown]")
    .forEach((b) =>
      b.classList.toggle("active", state.broadcastState === "countdown"),
    );
  renderWorkflow();
  renderEvents($("overviewEvents"), (state.eventLog || []).slice(0, 8));
  renderEvents($("liveEvents"), (state.eventLog || []).slice(0, 100));
  renderOverviewStandings();
  renderLiveTeams();
  renderTeamAdmin();
  renderMatchTeamPicker();
  renderStandings();
  renderSettings();
  renderRegistrationSummary();
  renderProductionAssets();
  $("airEvent").textContent = name;
  $("airMatch").textContent =
    `${String(state.currentMatch).padStart(2, "0")} / GROUP ${state.currentGroup}`;
  $("airMap").textContent = state.currentMap || "Erangel";
  $("verifyStatus").textContent =
    status === "VERIFIED"
      ? "VERIFIED & LOCKED"
      : status === "AWAITING VERIFICATION"
        ? "AWAITING REVIEW"
        : "NOT VERIFIED";
  $("verifyResults").disabled = status === "VERIFIED";
  $("startMatch").disabled = status === "VERIFIED";
  $("quickLive").textContent =
    status === "LIVE" ? "● Match live" : "▶ Start match";
  $("overlayHealth").textContent = "Dashboard connected · open /overlay in OBS";
  $("overlayHealthDot").classList.add("online");
}
function renderWorkflow() {
  const items = [
    [
      "Match configured",
      `${state.currentMap} · Group ${state.currentGroup}`,
      !!state.currentMatch,
    ],
    [
      "Live operations",
      state.matchStatus === "live"
        ? "Match in progress"
        : "Start the match to enable live operations",
      state.matchStatus === "live",
    ],
    [
      "Results verification",
      state.matchStatus === "verified"
        ? "Results locked and published"
        : state.matchStatus === "awaiting-verification"
          ? "Ready for final review"
          : "Awaiting match end",
      state.matchStatus === "verified",
    ],
    [
      "Broadcast state",
      (state.broadcastState || "pre-show").replaceAll("-", " "),
      true,
    ],
  ];
  $("workflow").innerHTML = items
    .map(
      (it, i) =>
        `<div class="workflow-step ${it[2] ? "done" : ""}"><span class="step-icon">${it[2] ? "✓" : String(i + 1).padStart(2, "0")}</span><div><b>${safe(it[0])}</b><small>${safe(it[1])}</small></div><span class="step-state">${it[2] ? "READY" : "PENDING"}</span></div>`,
    )
    .join("");
}
function renderEvents(container, events) {
  container.innerHTML = "";
  if (!events.length) {
    container.innerHTML =
      '<div class="empty-state">No events recorded yet.<br>Match activity will appear here.</div>';
    return;
  }
  events.forEach((e) => {
    const row = document.createElement("div");
    row.className = "event-row";
    const dot = document.createElement("i");
    dot.className = "event-dot";
    const body = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = e.description || e.action || e.type || "Tournament event";
    const small = document.createElement("small");
    small.textContent = `MATCH ${String(e.matchNumber || state.currentMatch).padStart(2, "0")} · ${e.group || state.currentGroup || "A"}`;
    body.append(b, small);
    const time = document.createElement("time");
    time.textContent = fmtDate(e.at);
    row.append(dot, body, time);
    container.append(row);
  });
}
function renderOverviewStandings() {
  const rows = sortedOverall().slice(0, 8);
  $("overviewStandings").innerHTML = rows
    .map(
      (t, i) =>
        `<tr><td class="${i < 3 ? "rank-top" : ""}">${String(i + 1).padStart(2, "0")}</td><td class="team-cell">${safe(t.name)}</td><td><span class="group-chip">${safe(t.group || "A")}</span></td><td>${t.overallMatches || 0}</td><td>${t.overallKills || 0}</td><td class="points-cell">${t.overallPoints || 0}</td></tr>`,
    )
    .join("");
}
function selectedMatchIds() {
  return (
    pendingMatchTeamIds !== null
      ? pendingMatchTeamIds
      : state?.matchTeamIds || []
  ).map(Number);
}
/* ---------------------------------------------------------------------------
   Premium squad workspace.
   The controls, data attributes and emitted socket events are unchanged; this
   only reorganises how the same match inputs are presented and filtered.
--------------------------------------------------------------------------- */
let liveStatusFilter = "all";
let liveSearchTerm = "";

function squadHealth(t) {
  const players = t.players || [];
  const eliminated = players.filter((p) => p.status === "eliminated").length;
  if (eliminated >= players.length && players.length)
    return { key: "out", label: "ELIMINATED", short: "ELIM" };
  if (eliminated > 0 || players.some((p) => p.status === "knocked"))
    return { key: "damaged", label: "IN FIGHT", short: "FIGHT" };
  if (Number(t.kills) > 0 || Number(t.placement) > 0)
    return { key: "damaged", label: "SCORING", short: "SCORE" };
  return { key: "clean", label: "FULL SQUAD", short: "ALIVE" };
}

function filteredLiveTeams() {
  const filter = $("liveGroupFilter").value || "all";
  const ids = new Set(state.matchTeamIds || []);
  const lineupOrder = state.matchTeamIds || [];
  const idsOrder = (t) => {
    const index = lineupOrder.indexOf(t.id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const q = liveSearchTerm.trim().toLowerCase();
  return state.teams
    .filter((t) => ids.has(t.id) && (filter === "all" || t.group === filter))
    .filter((t) => {
      if (q && !t.name.toLowerCase().includes(q) && !String(t.id).includes(q))
        return false;
      const health = squadHealth(t);
      if (liveStatusFilter === "live") return health.key !== "out";
      if (liveStatusFilter === "finished") return health.key === "out";
      return true;
    })
    // Keep the operator's saved lineup order: cards must never jump around
    // while finishes and placements are being entered during a live match.
    .sort((a, b) => idsOrder(a) - idsOrder(b));
}

function renderSetupBar(status) {
  const title = $("setupBarTitle");
  const meta = $("setupBarMeta");
  if (!title || !meta) return;
  const ids = (pendingMatchTeamIds !== null ? pendingMatchTeamIds : state.matchTeamIds || []).length;
  const saved = (state.matchTeamIds || []).length;
  const dirtyNote = lineupDirty
    ? " · unsaved lineup changes"
    : ids !== saved
      ? " · lineup not saved yet"
      : "";
  title.textContent =
    status === "LIVE"
      ? `Match ${String(state.currentMatch).padStart(2, "0")} is live`
      : status === "VERIFIED"
        ? `Match ${String(state.currentMatch).padStart(2, "0")} results are locked`
        : `Ready to start Match ${String(state.currentMatch).padStart(2, "0")}`;
  const group = String(state.currentGroup || "A");
  const groupLabel = ["A", "B", "C", "D", "E", "F"].includes(group.toUpperCase())
    ? `Group ${group.toUpperCase()}`
    : group;
  meta.textContent = `${groupLabel} · ${state.currentMap || "Erangel"} · ${ids} squad(s) selected${dirtyNote}`;
}

function renderLiveTeamCounts() {
  const filter = $("liveGroupFilter").value || "all";
  const ids = new Set(state.matchTeamIds || []);
  const inLobby = state.teams.filter(
    (t) => ids.has(t.id) && (filter === "all" || t.group === filter),
  );
  const out = inLobby.filter((t) => squadHealth(t).key === "out").length;
  const count = $("liveTeamCount");
  if (count) count.textContent = `${inLobby.length} / ${ids.size} SQUADS`;
  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  set("liveFilterAllCount", inLobby.length);
  set("liveFilterActiveCount", inLobby.length - out);
  set("liveFilterOutCount", out);
}

function playerStatsChips(p, kills) {
  return `<span class="player-chip-fin">${kills} FIN</span>
    <span class="player-chip-dmg">${Number(p.damage) || 0} DMG</span>`;
}

function refreshSetupBar() {
  if (!state) return;
  renderSetupBar(
    (state.matchStatus || "upcoming").toUpperCase().replaceAll("-", " "),
  );
}

function captureGridFocus() {
  const el = window.document.activeElement;
  if (!el || typeof el.closest !== "function" || !el.closest("#liveTeams"))
    return null;
  const placement = el.getAttribute?.("data-placement");
  const damageTeam = el.getAttribute?.("data-player-damage-team");
  const damageIndex = el.getAttribute?.("data-player-damage-index");
  const selector = placement
    ? `[data-placement="${placement}"]`
    : damageTeam !== null && damageIndex !== null
      ? `[data-player-damage-team="${damageTeam}"][data-player-damage-index="${damageIndex}"]`
      : null;
  if (!selector || !("value" in el)) return null;
  return {
    selector,
    value: el.value,
    start: el.selectionStart,
    end: el.selectionEnd,
  };
}

function restoreGridFocus(info) {
  if (!info) return;
  const el = $("liveTeams")?.querySelector(info.selector);
  if (!el || !("value" in el)) return;
  el.value = info.value;
  el.focus();
  if (typeof el.setSelectionRange === "function" && info.start !== null)
    try {
      el.setSelectionRange(info.start, info.end);
    } catch {
      /* not a text-selectable input */
    }
}

function placementPointsFor(team) {
  const table = state.scoringRules?.placementPoints || {};
  return Math.max(0, Number(table[String(Number(team.placement) || 0)]) || 0);
}

function pendingPlacements() {
  const ids = new Set(state.matchTeamIds || []);
  return state.teams.filter((t) => ids.has(t.id) && !(Number(t.placement) >= 1));
}

function placementsAreAuto(team) {
  return team.placementAuto !== false && state.autoPlacements !== false;
}

function renderSquadIndex(teams) {
  const strip = $("squadIndex");
  if (!strip) return;
  if (!teams.length) {
    strip.innerHTML = "";
    strip.classList.add("hidden");
    return;
  }
  strip.classList.remove("hidden");
  strip.innerHTML = teams
    .map((t) => {
      const health = squadHealth(t);
      return `<button type="button" class="squad-index-chip health-${health.key}${collapsedSquads.has(Number(t.id)) ? " collapsed" : ""}" data-squad-jump="${t.id}" title="${safe(t.name)} · ${health.label}">
        <span class="squad-index-rank">${String(t.placement || "–").padStart(2, "0")}</span>
        <b>${safe(t.name)}</b>
        <span class="squad-index-pts">${Number(t.matchPoints) || 0}</span>
        <i class="squad-index-dot health-${health.key}"></i>
      </button>`;
    })
    .join("");
}

function renderPlacementStatus() {
  const status = $("lobbyPlacementStatus");
  const toggle = $("autoPlacementsToggle");
  if (!status) return;
  const ids = new Set(state.matchTeamIds || []);
  const lobby = state.teams.filter((t) => ids.has(t.id));
  const alive = lobby.filter((t) => squadHealth(t).key !== "out");
  const missing = pendingPlacements();
  const autoMode = state.autoPlacements !== false;
  if (toggle) {
    toggle.textContent = autoMode ? "AUTO PLACEMENTS · ON" : "AUTO PLACEMENTS · OFF";
    toggle.classList.toggle("on", autoMode);
    toggle.classList.toggle("off", !autoMode);
    toggle.setAttribute("aria-pressed", autoMode ? "true" : "false");
  }
  const nextPlace = alive.length;
  const parts = [
    `<b>${alive.length}</b> alive`,
    `<b>${lobby.length - alive.length}</b> eliminated`,
  ];
  if (alive.length > 1)
    parts.push(`next squad wiped takes <b>${nextPlace}th place</b>${nextPlace > 8 ? " · 0 placement points" : ""}`);
  else if (alive.length === 1) parts.push("one squad left · winner already placed 1st");
  else parts.push("lobby complete");
  if (missing.length)
    parts.push(`<span class="placement-warn">${missing.length} squad(s) still need a placement</span>`);
  status.innerHTML = parts.join(' <span class="placement-sep">·</span> ');
}

function renderLiveTeams() {
  if (!state) return;
  renderLiveTeamCounts();
  renderPlacementStatus();
  const teams = filteredLiveTeams();
  const grid = $("liveTeams");
  const focusInfo = captureGridFocus();

  grid.innerHTML = "";
  if (!teams.length) {
    grid.innerHTML =
      '<div class="empty-state">No squads match this view. Clear the search, switch the status filter, or change the match lineup in Match setup.</div>';
  } else {
    // Every squad in the lobby is rendered on this single page — no paging.
    teams.forEach((t, index) => grid.append(buildSquadCard(t, index + 1, teams.length)));
  }
  renderSquadIndex(teams);
  applyDensity();
  applyTeamLayout();
  applyColumns();
  renderColumnReadout(teams.length);
  restoreGridFocus(focusInfo);
}

function buildSquadCard(t, rank, totalVisible) {
  const ids = new Set(state.matchTeamIds || []);
  const health = squadHealth(t);
  const collapsed = collapsedSquads.has(Number(t.id));
  const players = t.players || [];
  const alive = players.filter((p) => p.status === "alive").length;
  const knocked = players.filter((p) => p.status === "knocked").length;
  const placement = Number(t.placement) || 0;
  const auto = placementsAreAuto(t);
  const placePts = placementPointsFor(t);
  const card = document.createElement("article");
  card.className = `team-layout-card ${teamLayout}-layout ${collapsed ? "collapsed" : ""} health-${health.key}`;
  card.dataset.squadCard = String(t.id);
  card.innerHTML = teamLayout === "scoreboard"
    ? buildScoreboardLayout(t, rank, collapsed, ids, placement, auto, placePts, players)
    : buildFigmaLayout(t, rank, collapsed, ids, placement, auto, placePts, players);
  return card;
}

function teamActionMarkup(t, ids, placement, auto) {
  return `<div class="team-action-row">
    <div class="team-finish-control"><button class="team-finish-plus" data-action="plus" data-id="${t.id}">＋ FINISH</button><button class="team-finish-minus" data-action="minus" data-id="${t.id}" aria-label="Decrease team finishes">−</button></div>
    <label class="team-placement-control">PLACE <input type="number" min="0" max="${ids.size}" value="${placement}" data-placement="${t.id}" aria-label="Placement for ${safe(t.name)}"></label>
    <span class="team-placement-mode">${auto ? "AUTO" : "MANUAL"}</span>
    ${auto ? "" : `<button class="team-placement-auto" data-placement-auto="${t.id}" type="button">↺ AUTO</button>`}
    <button class="team-edit" data-action="edit" data-id="${t.id}">Edit roster</button>
  </div>`;
}

function playerActionMarkup(t, p, i, style) {
  const icon = style === "scoreboard" ? { alive: "▶", knocked: "●", eliminated: "☠" } : { alive: "ALIVE", knocked: "KNOCK", eliminated: "ELIM" };
  return `<div class="${style}-player ${p.status}">
    <div class="player-identity-block"><span class="player-avatar">${safe((p.name || "P").trim().charAt(0).toUpperCase())}</span><div><small>PLAYER ${String(i + 1).padStart(2, "0")}</small><b title="${safe(p.name)}">${safe(p.name)}</b><span>UID ${safe(p.uid || "NOT ENTERED")}</span></div></div>
    <div class="player-finish-badge">${Number(p.kills) || 0} FIN</div>
    <div class="player-damage-control-new"><b>DMG</b><input type="number" min="0" max="50000" value="${Number(p.damage) || 0}" data-player-damage-team="${t.id}" data-player-damage-index="${i}" aria-label="Damage for ${safe(p.name)}"><button data-player-kill-team="${t.id}" data-player-kill-index="${i}" data-amount="-1" aria-label="Decrease ${safe(p.name)} finishes">−</button><button data-player-kill-team="${t.id}" data-player-kill-index="${i}" data-amount="1" aria-label="Increase ${safe(p.name)} finishes">＋</button></div>
    <div class="player-status-controls"><button class="${p.status === "alive" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="alive" title="Alive">${icon.alive}</button><button class="${p.status === "knocked" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="knocked" title="Knock">${icon.knocked}</button><button class="${p.status === "eliminated" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="eliminated" title="Eliminated">${icon.eliminated}</button></div>
  </div>`;
}

function buildFigmaLayout(t, rank, collapsed, ids, placement, auto, placePts, players) {
  const health = squadHealth(t);
  return `<header class="figma-team-header"><div class="figma-team-identity"><span class="figma-rank">${String(rank).padStart(2, "0")}</span><span class="figma-mark">${safe((t.name || "G").trim().charAt(0).toUpperCase())}</span><div><small>SQUAD #${String(t.id).padStart(2, "0")} · GROUP ${safe(t.group || "A")}</small><h3>${safe(t.name)}</h3><span class="figma-health">${health.label}</span></div></div><div class="figma-points"><small>MATCH PTS</small><strong>${Number(t.matchPoints) || 0}</strong></div><button class="figma-collapse" data-squad-toggle="${t.id}" type="button" aria-expanded="${!collapsed}">${collapsed ? "▸" : "⌄"}</button></header><div class="figma-summary"><div><small>FINISHES</small><b>${Number(t.kills) || 0}</b></div><div><small>PLACEMENT</small><b>${placement || "—"}</b></div><div><small>PLACE PTS</small><b>+${placePts}</b></div></div><div class="figma-detail" ${collapsed ? "hidden" : ""}>${teamActionMarkup(t, ids, placement, auto)}<div class="figma-player-grid">${players.map((p, i) => `<article class="figma-player-card">${playerActionMarkup(t, p, i, "figma")}</article>`).join("")}</div></div>`;
}

function buildScoreboardLayout(t, rank, collapsed, ids, placement, auto, placePts, players) {
  return `<header class="scoreboard-team-header"><div class="scoreboard-team-identity"><span class="scoreboard-number">${String(rank).padStart(2, "0")}</span><span class="scoreboard-mark">${safe((t.name || "G").trim().charAt(0).toUpperCase())}</span><div><h3>${safe(t.name)}</h3><p>GROUP ${safe(t.group || "A")}</p></div></div><div class="scoreboard-stats"><div><small>★ FIN</small><strong>${Number(t.kills) || 0}</strong></div><div><small>⚑ PLACE</small><strong>${placement || "—"}</strong></div><div><small>★ PTS</small><strong>${Number(t.matchPoints) || 0}</strong></div></div><button class="scoreboard-collapse" data-squad-toggle="${t.id}" type="button" aria-expanded="${!collapsed}">${collapsed ? "▸" : "⌄"}</button></header><div class="scoreboard-detail" ${collapsed ? "hidden" : ""}><div class="scoreboard-controls"><div class="scoreboard-action-row"><button class="scoreboard-finish" data-action="plus" data-id="${t.id}">＋ FINISH</button><button class="scoreboard-minus" data-action="minus" data-id="${t.id}" aria-label="Decrease team finishes">−</button><label class="scoreboard-place">PLACE <input type="number" min="0" max="${ids.size}" value="${placement}" data-placement="${t.id}" aria-label="Placement for ${safe(t.name)}"></label><button class="scoreboard-place-plus" type="button" data-placement-step="1" data-placement-team="${t.id}" aria-label="Increase placement">＋</button><button class="scoreboard-auto ${auto ? "is-on" : ""}" type="button" data-auto-layout="${t.id}" aria-pressed="${auto}">${auto ? "AUTO" : "MANUAL"}</button><button class="scoreboard-settings" type="button" title="Scoring settings" aria-label="Scoring settings">⚙</button></div></div><div class="scoreboard-player-list">${players.map((p, i) => `<article class="scoreboard-player-row">${scoreboardPlayerMarkup(t, p, i)}</article>`).join("")}</div></div>`;
}

function scoreboardPlayerMarkup(t, p, i) {
  return `<div class="scoreboard-player"><span class="scoreboard-player-number">${String(i + 1).padStart(2, "0")}</span><div class="player-identity-block"><div><b title="${safe(p.name)}">${safe(p.name)}</b><span>UID ${safe(p.uid || "NOT ENTERED")}</span></div></div><div class="player-damage-control-new"><b>DMG</b><input type="number" min="0" max="50000" value="${Number(p.damage) || 0}" data-player-damage-team="${t.id}" data-player-damage-index="${i}" aria-label="Damage for ${safe(p.name)}"><button data-player-kill-team="${t.id}" data-player-kill-index="${i}" data-amount="-1" aria-label="Decrease ${safe(p.name)} finishes">−</button><button data-player-kill-team="${t.id}" data-player-kill-index="${i}" data-amount="1" aria-label="Increase ${safe(p.name)} finishes">＋</button></div><div class="player-status-controls"><button class="${p.status === "alive" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="alive" title="Alive">▶</button><button class="${p.status === "knocked" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="knocked" title="Knock">●</button><button class="${p.status === "eliminated" ? "selected" : ""}" data-player="${t.id}" data-index="${i}" data-status="eliminated" title="Eliminated">☠</button></div></div>`;
}

function renderMatchTeamPicker() {
  if (!state) return;
  const q = ($("lineupSearch")?.value || "").toLowerCase();
  const checked = new Set(selectedMatchIds());
  const groupFilter = $("liveGroupFilter")?.value || "all";
  const teams = (state.teams || []).filter(
    (t) =>
      (groupFilter === "all" || t.group === groupFilter) &&
      (t.name.toLowerCase().includes(q) || String(t.id).includes(q)),
  );
  $("lineupTeamPicker").innerHTML = teams
    .map(
      (t) =>
        `<label class="lineup-team ${checked.has(t.id) ? "selected" : ""}"><input type="checkbox" data-lineup-team="${t.id}" ${checked.has(t.id) ? "checked" : ""} ${!checked.has(t.id) && checked.size >= 16 ? "disabled" : ""}><span class="lineup-team-id">#${String(t.id).padStart(2, "0")}</span><span class="lineup-team-copy"><b>${safe(t.name)}</b><small>${safe(t.college || "Tournament roster")} · GROUP ${safe(t.group || "A")}</small></span><span class="lineup-mark">${t.registered ? "REG" : "SLOT"}</span></label>`,
    )
    .join("");
  const visibleSelected = teams.filter((t) => checked.has(t.id)).length;
  $("selectedLineupCount").textContent =
    groupFilter === "all"
      ? `${checked.size} / 16 SELECTED`
      : `${visibleSelected} OF ${checked.size} SELECTED · GROUP ${groupFilter}`;
  const hiddenSelected = checked.size - visibleSelected;
  $("lineupTeamPicker").querySelector("[data-filter-note]")?.remove();
  if (hiddenSelected > 0 && groupFilter !== "all") {
    const note = document.createElement("div");
    note.dataset.filterNote = "true";
    note.className = "lineup-filter-note";
    note.textContent = `${hiddenSelected} selected squad(s) are outside Group ${groupFilter}. Choose All teams to review the complete lineup.`;
    $("lineupTeamPicker").prepend(note);
  }
  if (!teams.length)
    $("lineupTeamPicker").innerHTML =
      '<div class="empty-state">No team matches that search.</div>';
}
$("lineupTeamPicker").addEventListener("change", (e) => {
  const input = e.target.closest("[data-lineup-team]");
  if (!input) return;
  const id = Number(input.dataset.lineupTeam);
  const set = new Set(selectedMatchIds());
  if (input.checked) {
    if (set.size >= 16) {
      input.checked = false;
      toast("A match lineup can contain at most 16 teams.");
      return;
    }
    set.add(id);
  } else set.delete(id);
  pendingMatchTeamIds = [...set];
  lineupDirty = true;
  renderMatchTeamPicker();
  refreshSetupBar();
});
$("lineupSearch").addEventListener("input", renderMatchTeamPicker);
$("loadGroupLineup").addEventListener("click", () => {
  const source = $("lineupSourceGroup").value;
  $("liveGroupFilter").value = ["A", "B", "C", "D", "E", "F"].includes(
    source,
  )
    ? source
    : "all";
  let teams = state.teams.filter(
    (t) =>
      source === "all" ||
      (source === "registered" ? t.registered : t.group === source),
  );
  if (teams.length > 16) {
    teams = teams.slice(0, 16);
    toast(
      "Loaded the first 16 teams in this selection. You can edit the lineup below.",
    );
  }
  pendingMatchTeamIds = teams.map((t) => t.id);
  lineupDirty = true;
  renderMatchTeamPicker();
  refreshSetupBar();
});
$("clearLineup").addEventListener("click", () => {
  pendingMatchTeamIds = [];
  lineupDirty = true;
  renderMatchTeamPicker();
  refreshSetupBar();
});
$("liveTeams").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const id = Number(b.dataset.id);
  if (b.dataset.action === "plus")
    socket.emit("team:kill", { teamId: id, amount: 1 });
  if (b.dataset.action === "minus")
    socket.emit("team:kill", { teamId: id, amount: -1 });
  if (b.dataset.action === "edit") {
    const t = state.teams.find((x) => x.id === id);
    if (!t) return;
    const name = prompt("Team name", t.name);
    if (name === null) return;
    const group = prompt("Group (A-F)", t.group || "A");
    if (group === null) return;
    const players = t.players.map((p, i) => ({
      name: prompt(`Player ${i + 1} name`, p.name) ?? p.name,
      status: p.status,
    }));
    socket.emit("team:update", {
      teamId: id,
      updates: { name, group, players },
    });
  }
});
$("liveTeams").addEventListener("change", (e) => {
  if (e.target.matches("[data-placement]")) {
    const value = Number(e.target.value);
    // A typed placement wins over the automation until the operator resets that
    // squad; clearing the field back to 0 hands it straight back to the engine.
    socket.emit("team:update", {
      teamId: Number(e.target.dataset.placement),
      updates: { placement: value, placementAuto: value < 1 },
    });
  }
  if (e.target.matches("[data-player-damage-team]"))
    socket.emit("player:damage", {
      teamId: Number(e.target.dataset.playerDamageTeam),
      playerIndex: Number(e.target.dataset.playerDamageIndex),
      damage: Number(e.target.value),
    });
});
$("liveTeams").addEventListener("click", (e) => {
  const placementStep = e.target.closest("[data-placement-step]");
  if (placementStep) {
    const input = $("liveTeams").querySelector(
      `[data-placement="${placementStep.dataset.placementTeam}"]`,
    );
    const value = Math.max(0, Number(input?.value) || 0) + Number(placementStep.dataset.placementStep);
    socket.emit("team:update", {
      teamId: Number(placementStep.dataset.placementTeam),
      updates: { placement: value, placementAuto: value < 1 },
    });
    return;
  }
  const autoLayout = e.target.closest("[data-auto-layout]");
  if (autoLayout) {
    if (state.matchStatus === "verified") return toast("This match is verified.");
    socket.emit("placements:auto-mode", { enabled: autoLayout.getAttribute("aria-pressed") !== "true" });
    return;
  }
  const kill = e.target.closest("[data-player-kill-team]");
  if (kill) {
    socket.emit("player:kill", {
      teamId: Number(kill.dataset.playerKillTeam),
      playerIndex: Number(kill.dataset.playerKillIndex),
      amount: Number(kill.dataset.amount),
    });
    return;
  }
  const b = e.target.closest("[data-player]");
  if (b)
    socket.emit("player:update", {
      teamId: Number(b.dataset.player),
      playerIndex: Number(b.dataset.index),
      status: b.dataset.status,
    });
});
$("liveGroupFilter").addEventListener("change", () => {
  if (!state) return;
  const filter = $("liveGroupFilter").value,
    phase = $("matchGroupInput").value;
  $("lineupSourceGroup").value = ["A", "B", "C", "D", "E", "F"].includes(
    filter,
  )
    ? filter
    : "all";
  if (
    ["A", "B", "C", "D", "E", "F"].includes(filter) &&
    phase === filter &&
    state.matchStatus !== "verified"
  ) {
    const groupIds = state.teams
      .filter((t) => t.group === filter)
      .slice(0, 16)
      .map((t) => t.id);
    const active = [...(state.matchTeamIds || [])];
    if (
      groupIds.length >= 2 &&
      (groupIds.length !== active.length ||
        groupIds.some((id) => !active.includes(id)))
    ) {
      const hasInput = state.teams.some(
        (t) =>
          active.includes(t.id) &&
          (Number(t.kills) > 0 ||
            Number(t.placement) > 0 ||
            t.players?.some(
              (p) => Number(p.kills) > 0 || p.status !== "alive",
            )),
      );
      if (
        hasInput &&
        !confirm(
          `Load Group ${filter} as the active lineup? Unverified match inputs may be reset when the lineup changes.`,
        )
      ) {
        renderLiveTeams();
        renderMatchTeamPicker();
        return;
      }
      socket.emit("match:configure", {
        number: Number($("matchNumberInput").value) || state.currentMatch,
        group: filter,
        map: $("matchMapInput").value || state.currentMap,
        teamIds: groupIds,
      });
      pendingMatchTeamIds = groupIds;
      lineupDirty = false;
      toast(`Loading Group ${filter} lineup…`);
    }
  }
  renderLiveTeams();
  renderMatchTeamPicker();
});
/* --- Squad workspace controls: search, status filters, collapse and paging --- */
$("liveTeamSearch").addEventListener("input", (e) => {
  liveSearchTerm = e.target.value || "";
  renderLiveTeams();
});
$("liveStatusFilter")?.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-live-filter]");
  if (!chip) return;
  liveStatusFilter = chip.dataset.liveFilter || "all";
  $("liveStatusFilter")
    .querySelectorAll("[data-live-filter]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.liveFilter === liveStatusFilter),
    );
  renderLiveTeams();
});
/* ---------------------------------------------------------------------------
   Squad grid view: how many columns, and how much detail per card.
   "2 columns" is the default because it halves the scrolling, and every card
   turns its roster into one compact strip per player so a 16-squad lobby is
   readable without hunting up and down the page.
--------------------------------------------------------------------------- */
const DENSITY_KEY = "bgmi.squadDensity";
const COLUMNS_KEY = "bgmi.squadColumns";
const TEAM_LAYOUT_KEY = "bgmi.teamLayout";
const COLUMN_CHOICES = ["auto", "1", "2", "3", "4"];
let squadDensity = "compact";
let squadColumns = "4";
let teamLayout = "figma";
try {
  const stored = window.localStorage?.getItem(DENSITY_KEY);
  if (stored === "compact" || stored === "comfortable") squadDensity = stored;
  const storedColumns = window.localStorage?.getItem(COLUMNS_KEY);
  if (COLUMN_CHOICES.includes(storedColumns)) squadColumns = storedColumns;
  const storedLayout = window.localStorage?.getItem(TEAM_LAYOUT_KEY);
  if (storedLayout === "figma" || storedLayout === "scoreboard") teamLayout = storedLayout;
} catch {
  /* storage unavailable — keep the defaults */
}
function applyDensity() {
  const compact = squadDensity === "compact";
  const grid = $("liveTeams");
  if (grid) grid.classList.toggle("density-compact", compact);
  // Also shrink the page chrome so more of the lobby fits on screen.
  $("page-live-controls")?.classList.toggle("compact-view", compact);
  $("densitySwitch")
    ?.querySelectorAll("[data-density]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.density === squadDensity),
    );
}
function applyTeamLayout() {
  const grid = $("liveTeams");
  if (grid) grid.dataset.teamLayout = teamLayout;
  $("teamLayoutSwitch")
    ?.querySelectorAll("[data-team-layout]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.teamLayout === teamLayout),
    );
}
/* An explicit choice is honoured on every screen wide enough to hold the
   panels; only a genuinely tiny viewport drops to a single column. This is why
   "2" means two squads side by side (2 x 8 for a 16-squad lobby) instead of
   silently collapsing to one column on a laptop or a split screen. */
// Minimum viewport that still leaves a usable panel: two panels need ~900px,
// three need ~1500px, otherwise the 2 x 2 player grid inside each panel gets
// squeezed below a comfortable size.
const COLUMN_MIN_VIEWPORT = { 2: 900, 3: 1500, 4: 1200 };
function viewportWidth() {
  return (
    window.document.documentElement.clientWidth ||
    window.innerWidth ||
    1440
  );
}
function effectiveColumns() {
  const vw = viewportWidth();
  /* Scoreboard panels zoom to fit whatever track they are given, so the
     operator's requested column count works on any screen — the viewport
     minimums below only guard the fixed-size Figma panels. */
  if (teamLayout === "scoreboard") {
    if (squadColumns === "auto") {
      const grid = $("liveTeams");
      const width = grid && grid.clientWidth ? grid.clientWidth : vw - 300;
      return Math.max(1, Math.min(4, Math.floor((width + 12) / 442)));
    }
    return Math.max(1, Math.min(4, Number(squadColumns) || 1));
  }
  if (squadColumns === "1") return 1;
  if (squadColumns === "2") return vw >= COLUMN_MIN_VIEWPORT[2] ? 2 : 1;
  if (squadColumns === "3")
    return vw >= COLUMN_MIN_VIEWPORT[3] ? 3 : vw >= COLUMN_MIN_VIEWPORT[2] ? 2 : 1;
  if (squadColumns === "4")
    return vw >= COLUMN_MIN_VIEWPORT[4] ? 4 : vw >= COLUMN_MIN_VIEWPORT[3] ? 3 : vw >= COLUMN_MIN_VIEWPORT[2] ? 2 : 1;
  // Auto: responsive auto-fill around a 430px panel.
  const grid = $("liveTeams");
  const width = grid && grid.clientWidth ? grid.clientWidth : vw - 300;
  return Math.max(1, Math.min(4, Math.floor((width + 12) / 442)));
}
/* Scoreboard multi-column mode: the GODL panel is a fixed 1024px design, so
   instead of restyling it we zoom the whole card to the measured grid track
   width — a pure zoom-out that keeps every proportion inside the card intact. */
const SCOREBOARD_PANEL_WIDTH = 1024;
function applyScoreboardZoom(grid, cols) {
  if (!grid) return;
  if (teamLayout !== "scoreboard" || cols < 2) {
    grid.style.removeProperty("--scoreboard-zoom");
    return;
  }
  const tracks = String(getComputedStyle(grid).gridTemplateColumns || "");
  const trackWidth = parseFloat(tracks.split(" ")[0]);
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return;
  const zoom = Math.max(0.15, Math.min(1, trackWidth / SCOREBOARD_PANEL_WIDTH));
  grid.style.setProperty("--scoreboard-zoom", String(Math.round(zoom * 10000) / 10000));
}
function applyColumns() {
  const grid = $("liveTeams");
  const cols = effectiveColumns();
  if (grid) {
    grid.dataset.cols = String(cols);
    applyScoreboardZoom(grid, cols);
  }
  $("columnsSwitch")
    ?.querySelectorAll("[data-columns]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.columns === squadColumns),
    );
  const narrowed = Number(squadColumns) > cols && squadColumns !== "auto";
  const switchEl = $("columnsSwitch");
  if (switchEl) switchEl.classList.toggle("narrowed", narrowed);
  return cols;
}
/* Reports the exact panel shape the operator is looking at, e.g. "2 x 8". */
function renderColumnReadout(visibleCount) {
  const el = $("columnsReadout");
  if (!el) return;
  const cols = Number($("liveTeams").dataset.cols) || 1;
  const rows = Math.max(1, Math.ceil(visibleCount / cols));
  el.textContent = `${cols} × ${rows}`;
  el.classList.toggle(
    "narrowed",
    Number(squadColumns) > cols && squadColumns !== "auto",
  );
  el.title =
    Number(squadColumns) > cols && squadColumns !== "auto"
      ? `Your screen fits ${cols} panel(s) side by side — showing ${cols} × ${rows}. Widen the window for ${squadColumns} columns.`
      : `Columns × rows for the squads currently shown (${cols} × ${rows})`;
}
/* The sidebar slides in/out and changes the squad grid's width without any
   window resize. Re-measure the grid whenever its width changes so the
   scoreboard panels re-zoom and re-count their columns to fill the new track
   (otherwise the old zoom leaves an empty gap after the panel is closed). */
const liveTeamsTrack = $("liveTeams");
let trackRemeasureTimer;
if (liveTeamsTrack && typeof ResizeObserver === "function") {
  let lastTrackWidth = liveTeamsTrack.clientWidth;
  new ResizeObserver(() => {
    const width = liveTeamsTrack.clientWidth;
    if (width === lastTrackWidth) return;
    lastTrackWidth = width;
    clearTimeout(trackRemeasureTimer);
    trackRemeasureTimer = setTimeout(() => {
      if (!state) return;
      applyColumns();
      renderColumnReadout(filteredLiveTeams().length);
    }, 150);
  }).observe(liveTeamsTrack);
}
/* Keep the layout honest when the operator resizes or splits the screen. */
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state) return;
    applyColumns();
    renderColumnReadout(filteredLiveTeams().length);
  }, 120);
});
$("columnsSwitch").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-columns]");
  if (!btn) return;
  squadColumns = btn.dataset.columns;
  try {
    window.localStorage?.setItem(COLUMNS_KEY, squadColumns);
  } catch {
    /* ignore */
  }
  applyColumns();
  renderColumnReadout(filteredLiveTeams().length);
});
$("densitySwitch").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-density]");
  if (!btn) return;
  squadDensity = btn.dataset.density;
  try {
    window.localStorage?.setItem(DENSITY_KEY, squadDensity);
  } catch {
    /* ignore */
  }
  applyDensity();
});
$("teamLayoutSwitch").addEventListener("click", (e) => {
  const button = e.target.closest("[data-team-layout]");
  if (!button) return;
  teamLayout = button.dataset.teamLayout;
  try {
    window.localStorage?.setItem(TEAM_LAYOUT_KEY, teamLayout);
  } catch {
    /* ignore */
  }
  renderLiveTeams();
});
/* Fast jump from the lobby index straight to a squad card. */
$("squadIndex").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-squad-jump]");
  if (!chip) return;
  const card = $("liveTeams").querySelector(
    `[data-squad-card="${chip.dataset.squadJump}"]`,
  );
  if (!card) return;
  if (collapsedSquads.has(Number(chip.dataset.squadJump))) {
    collapsedSquads.delete(Number(chip.dataset.squadJump));
    renderLiveTeams();
  }
  const target = $("liveTeams").querySelector(
    `[data-squad-card="${chip.dataset.squadJump}"]`,
  );
  if (target && typeof target.scrollIntoView === "function")
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  if (target) {
    target.classList.add("squad-card-flash");
    setTimeout(() => target.classList.remove("squad-card-flash"), 1200);
  }
});
/* Placement automation switches. */
$("autoPlacementsToggle").addEventListener("click", () => {
  if (state.matchStatus === "verified")
    return toast("This match is verified.");
  const enabled = state.autoPlacements === false;
  socket.emit("placements:auto-mode", { enabled });
  toast(
    enabled
      ? "Automatic placements on · positions 9–16 score zero placement points."
      : "Automatic placements off · every placement is now typed in manually.",
  );
});
$("resetAutoPlacements").addEventListener("click", () => {
  if (state.matchStatus === "verified")
    return toast("This match is verified.");
  if (
    !confirm(
      "Rebuild every placement from the recorded elimination order? Typed-in placements will be replaced.",
    )
  )
    return;
  socket.emit("placements:reset-auto");
});
/* Per-squad: hand a typed placement back to the automation engine. */
$("liveTeams").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-placement-auto]");
  if (!btn) return;
  socket.emit("team:update", {
    teamId: Number(btn.dataset.placementAuto),
    updates: { placementAuto: true },
  });
});
$("liveTeams").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-squad-toggle]");
  if (!toggle) return;
  const id = Number(toggle.dataset.squadToggle);
  if (collapsedSquads.has(id)) collapsedSquads.delete(id);
  else collapsedSquads.add(id);
  renderLiveTeams();
});
$("expandAllSquads").addEventListener("click", () => {
  collapsedSquads.clear();
  renderLiveTeams();
});
$("collapseAllSquads").addEventListener("click", () => {
  collapsedSquads = new Set(filteredLiveTeams().map((t) => Number(t.id)));
  renderLiveTeams();
});
$("backToSetup").addEventListener("click", () => showPage("match-setup"));
$("openLiveControls").addEventListener("click", () => showPage("live-controls"));
$("startMatchTop").addEventListener("click", () => {
  if (state.matchStatus === "verified")
    return toast("This match is already verified.");
  if (
    confirm(
      `Start Match ${$("matchNumberInput").value} and switch the overlay to LIVE MATCH?`,
    )
  ) {
    socket.emit("match:status", "live");
    showPage("live-controls");
  }
});

function renderTeamAdmin() {
  const search = ($("teamSearch").value || "").toLowerCase();
  const group = $("teamGroupFilter").value;
  const teams = state.teams.filter(
    (t) =>
      (group === "all" || t.group === group) &&
      (t.name.toLowerCase().includes(search) || String(t.id).includes(search)),
  );
  $("teamAdminRows").innerHTML = teams
    .map(
      (t) =>
        `<tr data-teamrow="${t.id}"><td>${String(t.id).padStart(2, "0")}</td><td><input data-edit="name" value="${safe(pendingValue(t.id, "name", t.name))}" maxlength="48" aria-label="Team ${t.id} name"></td><td><select data-edit="group">${["A", "B", "C", "D", "E", "F"].map((g) => `<option ${pendingValue(t.id, "group", t.group) === g ? "selected" : ""}>${g}</option>`).join("")}</select></td>${t.players.map((p, i) => `<td><input data-edit="player${i}" value="${safe(pendingValue(t.id, `player${i}`, p.name))}" maxlength="32" aria-label="${safe(t.name)} player ${i + 1}"><small class="team-uid-note">UID ${safe(p.uid || "—")}</small></td>`).join("")}<td><span class="${t.registered ? "registered-chip" : "placeholder-chip"}">${t.registered ? "REGISTERED" : "OPEN SLOT"}</span></td><td>${t.overallPoints || 0}</td></tr>`,
    )
    .join("");
}
function pendingValue(id, key, fallback) {
  return pendingTeamEdits.has(id + "|" + key)
    ? pendingTeamEdits.get(id + "|" + key)
    : fallback;
}
$("teamAdminRows").addEventListener("input", (e) => {
  const row = e.target.closest("[data-teamrow]");
  if (!row || !e.target.dataset.edit) return;
  pendingTeamEdits.set(
    row.dataset.teamrow + "|" + e.target.dataset.edit,
    e.target.value,
  );
});
$("teamAdminRows").addEventListener("change", (e) => {
  const row = e.target.closest("[data-teamrow]");
  if (!row || !e.target.dataset.edit) return;
  pendingTeamEdits.set(
    row.dataset.teamrow + "|" + e.target.dataset.edit,
    e.target.value,
  );
});
$("saveTeamEdits").addEventListener("click", () => {
  const byTeam = new Map();
  for (const [key, value] of pendingTeamEdits) {
    const [id, field] = key.split("|");
    if (!byTeam.has(Number(id))) byTeam.set(Number(id), {});
    const obj = byTeam.get(Number(id));
    if (field === "name" || field === "group") obj[field] = value;
    else if (field.startsWith("player")) {
      obj.players ||= state.teams
        .find((t) => t.id === Number(id))
        .players.map((p) => ({ ...p }));
      obj.players[Number(field.slice(6))].name = value;
    }
  }
  for (const [teamId, updates] of byTeam)
    socket.emit("team:update", { teamId, updates });
  pendingTeamEdits.clear();
  toast(`Saving edits for ${byTeam.size} team(s)…`);
});
$("teamSearch").addEventListener("input", renderTeamAdmin);
$("teamGroupFilter").addEventListener("change", renderTeamAdmin);
$("generateRoster").addEventListener("click", () => {
  const count = Number($("rosterCount").value);
  if (
    confirm(
      `Resize the roster to ${count} teams? Existing records for retained team IDs will be preserved.`,
    )
  )
    socket.emit("teams:generate", { count });
});
function renderStandings() {
  const rowsEl = $("standingsRows"),
    head = $("standingsHead"),
    history = $("historyList");
  history.classList.add("hidden");
  head.classList.remove("hidden");
  rowsEl.classList.remove("hidden");
  let teams = [],
    columns = "",
    heading = "",
    sub = "";
  if (standingsMode === "overall") {
    teams = sortedOverall();
    heading = "Tournament leaderboard";
    sub = "Sorted by official cumulative points.";
    columns =
      "<tr><th>RANK</th><th>TEAM</th><th>GROUP</th><th>MATCHES</th><th>FINISHES</th><th>OVERALL PTS</th></tr>";
  } else if (standingsMode === "current") {
    teams = sortedCurrent().filter((t) =>
      (state.matchTeamIds || []).includes(t.id),
    );
    heading = `Match ${String(state.currentMatch).padStart(2, "0")} results`;
    sub = "Current match inputs. These are official only after verification.";
    columns =
      "<tr><th>RANK</th><th>TEAM</th><th>GROUP</th><th>PLACEMENT</th><th>FINISHES</th><th>MATCH PTS</th></tr>";
  } else if (standingsMode === "qualification") {
    teams = sortedOverall();
    heading = "Qualification projection";
    sub = `Top ${state.qualification?.semifinalSlots || 24} projected semifinal slots and top ${state.qualification?.finalSlots || 16} final slots. Configure actual tournament rules before use.`;
    columns =
      "<tr><th>RANK</th><th>TEAM</th><th>GROUP</th><th>OVERALL PTS</th><th>SEMIFINAL</th><th>GRAND FINAL</th></tr>";
  } else {
    head.classList.add("hidden");
    rowsEl.classList.add("hidden");
    history.classList.remove("hidden");
    heading = "Finalized match history";
    sub = "Published result snapshots and their match details.";
    history.innerHTML = "";
    const matches = [...(state.matchHistory || [])].sort(
      (a, b) => b.matchNumber - a.matchNumber,
    );
    if (!matches.length)
      history.innerHTML =
        '<div class="empty-state">No matches have been verified and published yet.</div>';
    matches.forEach((m) => {
      const el = document.createElement("div");
      el.className = "history-item";
      const left = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = `Match ${String(m.matchNumber).padStart(2, "0")} · Group ${m.group || "A"} · ${m.map || "Map not set"}`;
      const sm = document.createElement("small");
      sm.textContent = `${m.results.length} team records · ${fmtDate(m.finalizedAt)} · ${m.verified ? "VERIFIED" : "LEGACY SNAPSHOT"}`;
      left.append(b, sm);
      const right = document.createElement("b");
      right.textContent = `${m.results.reduce((n, r) => n + r.matchPoints, 0)} PTS`;
      el.append(left, right);
      history.append(el);
    });
  }
  $("standingsHeading").textContent = heading;
  $("standingsSub").textContent = sub;
  $("standingsCount").textContent =
    standingsMode === "history"
      ? `${(state.matchHistory || []).length} MATCHES`
      : `${teams.length} TEAMS`;
  $("standingsHead").innerHTML = columns;
  if (standingsMode === "overall")
    rowsEl.innerHTML = teams
      .map(
        (t, i) =>
          `<tr><td class="${i < 3 ? "rank-top" : ""}">${String(i + 1).padStart(2, "0")}</td><td class="team-cell">${safe(t.name)}</td><td><span class="group-chip">${safe(t.group || "A")}</span></td><td>${t.overallMatches || 0}</td><td>${t.overallKills || 0}</td><td class="points-cell">${t.overallPoints || 0}</td></tr>`,
      )
      .join("");
  if (standingsMode === "current")
    rowsEl.innerHTML = teams
      .map(
        (t, i) =>
          `<tr><td>${String(i + 1).padStart(2, "0")}</td><td class="team-cell">${safe(t.name)}</td><td>${safe(t.group || "A")}</td><td>${t.placement || "—"}</td><td>${t.kills}</td><td class="points-cell">${t.matchPoints}</td></tr>`,
      )
      .join("");
  if (standingsMode === "qualification") {
    const semi = Number(state.qualification?.semifinalSlots || 24),
      final = Number(state.qualification?.finalSlots || 16);
    rowsEl.innerHTML = teams
      .map(
        (t, i) =>
          `<tr><td class="${i < 3 ? "rank-top" : ""}">${String(i + 1).padStart(2, "0")}</td><td class="team-cell">${safe(t.name)}</td><td>${safe(t.group || "A")}</td><td class="points-cell">${t.overallPoints || 0}</td><td>${i < semi ? '<span class="qual-yes">PROJECTED</span>' : "—"}</td><td>${i < final ? '<span class="qual-yes">PROJECTED</span>' : "—"}</td></tr>`,
      )
      .join("");
  }
}
document.querySelectorAll("[data-standings]").forEach((b) =>
  b.addEventListener("click", () => {
    standingsMode = b.dataset.standings;
    document
      .querySelectorAll("[data-standings]")
      .forEach((x) => x.classList.toggle("active", x === b));
    renderStandings();
  }),
);
function renderSettings() {
  if (
    document.activeElement?.matches(
      "#settingName,#settingOrganizer,#settingFormat,#settingFinishPoint,#settingSemiSlots,#settingFinalSlots,#settingRegistrationCapacity,#settingRegistrationOpen,[data-placepoints]",
    )
  )
    return;
  $("settingName").value = state.tournamentName || "";
  $("settingOrganizer").value = state.organizer || "";
  $("settingFormat").value = state.format || "";
  $("settingFinishPoint").value = state.scoringRules?.finishPoint ?? 1;
  $("settingSemiSlots").value = state.qualification?.semifinalSlots || 24;
  $("settingFinalSlots").value = state.qualification?.finalSlots || 16;
  $("settingRegistrationCapacity").value =
    state.registrationSettings?.maxTeams || 96;
  $("settingRegistrationOpen").value =
    state.registrationSettings?.open === false ? "false" : "true";
  const rules = state.scoringRules?.placementPoints || {};
  $("placementRules").innerHTML = Array.from({ length: 8 }, (_, i) => i + 1)
    .map(
      (p) =>
        `<label class="rule-item"><small>${p === 1 ? "1ST" : p === 2 ? "2ND" : p === 3 ? "3RD" : p + "TH"} PLACE</small><input type="number" min="0" max="100" data-placepoints="${p}" value="${Number(rules[p] || 0)}"></label>`,
    )
    .join("");
}
function renderProductionAssets() {
  const prod = state?.production || {},
    caster = prod.caster || {},
    map = prod.mapFeed || {};
  const ids = [
    "prodEventLogo",
    "prodThemeMusic",
    "prodStreamStartMinutes",
    "prodCasterName",
    "prodCasterTagline",
    "prodCasterImage",
    "prodMapImage",
    "prodBroadcastStage",
    "prodBroadcastDay",
    "prodBroadcastGroupLabel",
    "prodBroadcastMatchCaption",
  ];
  if (ids.some((id) => document.activeElement === $(id))) return;
  $("prodEventLogo").value = prod.eventLogoUrl || "";
  $("prodThemeMusic").value = prod.themeMusicUrl || "";
  $("prodStreamStartMinutes").value = Math.round(
    (Number(prod.streamStartDurationSeconds) || 1200) / 60,
  );
  $("prodCasterName").value = caster.name || "";
  $("prodCasterTagline").value = caster.tagline || "";
  $("prodCasterImage").value = caster.imageUrl || "";
  $("prodMapImage").value = map.imageUrl || "";
  $("prodBroadcastStage").value = prod.broadcastStageLabel || "GROUP STAGE";
  $("prodBroadcastDay").value = prod.broadcastDayLabel || "DAY 1";
  $("prodBroadcastGroupLabel").value = prod.broadcastGroupLabel || "";
  $("prodBroadcastMatchCaption").value = prod.broadcastMatchCaption || "";
}
$("saveProductionAssets").addEventListener("click", () => {
  const payload = {
    eventLogoUrl: $("prodEventLogo").value.trim(),
    themeMusicUrl: $("prodThemeMusic").value.trim(),
    streamStartDurationMinutes: Number($("prodStreamStartMinutes").value) || 20,
    casterName: $("prodCasterName").value.trim(),
    casterTagline: $("prodCasterTagline").value.trim(),
    casterImageUrl: $("prodCasterImage").value.trim(),
    mapImageUrl: $("prodMapImage").value.trim(),
    broadcastStageLabel: $("prodBroadcastStage").value.trim(),
    broadcastDayLabel: $("prodBroadcastDay").value.trim(),
    broadcastGroupLabel: $("prodBroadcastGroupLabel").value.trim(),
    broadcastMatchCaption: $("prodBroadcastMatchCaption").value.trim(),
  };
  for (const id of ["prodEventLogo", "prodCasterImage", "prodMapImage"]) {
    const value = $(id).value.trim();
    if (value) {
      try {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      } catch {
        return toast("Image fields must contain valid HTTP or HTTPS URLs.");
      }
    }
  }
  const music = $("prodThemeMusic").value.trim();
  if (music && !music.startsWith("/assets/")) {
    try {
      const url = new URL(music);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error();
    } catch {
      return toast("Theme audio must be HTTPS/HTTP or a /assets/ path.");
    }
  }
  socket.emit("production:update", payload);
  toast("Show assets sent to production server.");
});
$("saveRegistrationSettings").addEventListener("click", () => {
  socket.emit("tournament:update-settings", {
    registrationCapacity: Number($("settingRegistrationCapacity").value),
    registrationOpen: $("settingRegistrationOpen").value === "true",
  });
  toast("Registration settings submitted.");
});
$("saveSettings").addEventListener("click", () => {
  const placementPoints = {};
  document
    .querySelectorAll("[data-placepoints]")
    .forEach(
      (el) =>
        (placementPoints[el.dataset.placepoints] = Math.max(
          0,
          Math.min(100, Number(el.value) || 0),
        )),
    );
  socket.emit("tournament:update-settings", {
    tournamentName: $("settingName").value,
    organizer: $("settingOrganizer").value,
    format: $("settingFormat").value,
    finishPoint: Number($("settingFinishPoint").value),
    semifinalSlots: Number($("settingSemiSlots").value),
    finalSlots: Number($("settingFinalSlots").value),
    placementPoints,
  });
  toast("Tournament settings submitted.");
});
$("saveMatchConfig").addEventListener("click", () => {
  const number = Number($("matchNumberInput").value);
  if (!Number.isInteger(number) || number < 1 || number > 999)
    return toast("Match number must be between 1 and 999.");
  const teamIds = selectedMatchIds();
  if (teamIds.length < 2 || teamIds.length > 16)
    return toast("Select between 2 and 16 squads for this match.");
  socket.emit("match:configure", {
    number,
    group: $("matchGroupInput").value,
    map: $("matchMapInput").value,
    teamIds,
  });
  pendingMatchTeamIds = teamIds;
  lineupDirty = false;
  toast(`Saving match setup with ${teamIds.length} squads…`);
});
$("startMatch").addEventListener("click", () => {
  if (
    confirm(
      `Start Match ${$("matchNumberInput").value} and switch the overlay to LIVE MATCH?`,
    )
  ) {
    socket.emit("match:status", "live");
    // Hand the operator straight to the full-page squad workspace.
    showPage("live-controls");
  }
});
$("quickLive").addEventListener("click", () => {
  if (state.matchStatus === "live") return showPage("live-controls");
  if (confirm(`Start Match ${state.currentMatch}?`)) {
    socket.emit("match:status", "live");
    showPage("live-controls");
  }
});
$("endMatch").addEventListener("click", () => {
  if (state.matchStatus === "verified")
    return toast("This match is already verified.");
  if (
    confirm(
      "End live operations and move this match to result review? Scores will not be published yet.",
    )
  )
    socket.emit("match:status", "awaiting-verification");
});
$("verifyResults").addEventListener("click", () => {
  if (state.matchStatus === "verified")
    return toast("This match is already verified.");
  const active = new Set(state.matchTeamIds || []);
  const selected = state.teams.filter((t) => active.has(t.id));
  const zero = selected.every((t) => t.kills === 0 && t.placement === 0);
  if (zero)
    return toast("Enter at least one finish or placement before publishing.");
  const placements = selected.map((t) => Number(t.placement) || 0);
  if (placements.some((p) => p < 1 || p > selected.length))
    return toast(
      `Assign a final placement from 1 to ${selected.length} to every squad before publishing. Positions 1–8 receive placement points; positions 9–${selected.length} receive zero.`,
    );
  if (new Set(placements).size !== placements.length)
    return toast(
      "Duplicate placements found. Each squad must have a unique final placement before publishing.",
    );
  if (
    !confirm(
      `Verify and publish Match ${state.currentMatch} · Group ${state.currentGroup}? This creates the official result snapshot and updates overall standings.`,
    )
  )
    return;
  socket.emit("match:finalize");
});
$("resetMatch").addEventListener("click", () => {
  if (
    confirm(
      "Clear current match finishes, placements and player statuses? Verified results remain locked.",
    )
  )
    socket.emit("match:reset");
});
document
  .querySelectorAll("[data-scene]")
  .forEach((b) =>
    b.addEventListener("click", () =>
      socket.emit("broadcast:state", b.dataset.scene),
    ),
  );
document.querySelectorAll("[data-stream-start]").forEach((b) =>
  b.addEventListener("click", () => {
    const minutes = Math.max(
      1,
      Math.min(
        180,
        Number($("prodStreamStartMinutes").value) ||
          Number(b.dataset.streamStart) ||
          20,
      ),
    );
    if (
      confirm(
        `Start the full-screen tournament slate countdown for ${minutes} minutes? When it ends, the overlay will advance to the caster scene.`,
      )
    )
      socket.emit("broadcast:stream-start", { durationMinutes: minutes });
  }),
);
document.querySelectorAll("[data-countdown]").forEach((b) =>
  b.addEventListener("click", () => {
    if (
      confirm(
        "Start a 30-second corner countdown over the full-screen caster? At zero, the overlay switches to the live match HUD.",
      )
    )
      socket.emit("broadcast:countdown", {
        durationSeconds: Number(b.dataset.countdown),
      });
  }),
);
document.querySelectorAll("[data-mvp-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    const mode = b.dataset.mvpMode;
    socket.emit("broadcast:mvp", { mode });
  }),
);
// ---------------------------------------------------------------------------
// MASTER RESET — every destructive reset is unlocked by the administrator's
// special reset password, never by the login session alone. The competition
// scope keeps team registrations; the factory scope clears the event entirely.
// ---------------------------------------------------------------------------
let resetPasswordInfo = {
  configured: false,
  updatedAt: null,
  updatedBy: "",
  loginPasswordRequired: true,
};
let masterResetScope = "competition";
let masterResetBusy = false;
let resetPasswordLoaded = false;

const masterResetDialog = () => $("masterResetDialog");
function renderResetPasswordPanel() {
  const tag = $("resetPasswordState");
  if (tag) {
    tag.textContent = resetPasswordInfo.configured ? "SET" : "NOT SET";
    tag.classList.toggle("warn", !resetPasswordInfo.configured);
  }
  const hint = $("resetPasswordHint");
  if (hint) {
    if (!resetPasswordInfo.configured)
      hint.textContent =
        "No reset password is set yet, so the master reset stays locked. Set one now: it is asked for every time data is wiped.";
    else
      hint.textContent = `Reset password set${
        resetPasswordInfo.updatedBy
          ? ` by ${resetPasswordInfo.updatedBy}`
          : ""
      }${
        resetPasswordInfo.updatedAt
          ? ` on ${fmtDate(resetPasswordInfo.updatedAt)}`
          : ""
      }. Changing it asks for your administrator login password again.`;
  }
  const loginWrap = $("resetSetupLoginWrap");
  if (loginWrap) loginWrap.hidden = !resetPasswordInfo.loginPasswordRequired;
  const note = $("masterResetNote");
  if (note)
    note.textContent = resetPasswordInfo.configured
      ? "The reset password is set by the admin in Tournament setup → Reset protection password."
      : "No reset password is configured yet. Set one in Tournament setup → Reset protection password to unlock the master reset.";
}
async function loadResetPasswordStatus() {
  try {
    const response = await fetch("/api/admin/reset-password", {
      credentials: "same-origin",
    });
    if (!response.ok) return;
    const payload = await response.json();
    resetPasswordInfo = { ...resetPasswordInfo, ...payload };
    resetPasswordLoaded = true;
  } catch {
    return;
  }
  renderResetPasswordPanel();
}
function setMasterResetError(message) {
  const el = $("masterResetError");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}
function renderMasterResetScope() {
  const list = $("masterResetScopeList");
  if (list) list.classList.toggle("factory", masterResetScope === "factory");
  const confirmButton = $("masterResetConfirm");
  if (confirmButton)
    confirmButton.textContent =
      masterResetScope === "factory"
        ? "⟲ Factory reset everything"
        : "⟲ Reset event data";
}
function openMasterReset(scope = "competition") {
  masterResetScope = scope === "factory" ? "factory" : "competition";
  document
    .querySelectorAll('input[name="masterResetScope"]')
    .forEach((radio) => (radio.checked = radio.value === masterResetScope));
  const password = $("masterResetPassword");
  if (password) {
    password.value = "";
    password.type = "password";
  }
  const showButton = $("masterResetShow");
  if (showButton) {
    showButton.textContent = "SHOW";
    showButton.setAttribute("aria-pressed", "false");
  }
  setMasterResetError("");
  renderMasterResetScope();
  const dialog = masterResetDialog();
  if (!dialog) return;
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else dialog.setAttribute("open", "");
  loadResetPasswordStatus();
  setTimeout(() => $("masterResetPassword")?.focus(), 40);
}
function closeMasterReset() {
  const dialog = masterResetDialog();
  if (!dialog) return;
  const password = $("masterResetPassword");
  if (password) password.value = "";
  setMasterResetError("");
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}
$("resetAllData")?.addEventListener("click", () => openMasterReset("competition"));
$("openMasterReset")?.addEventListener("click", () =>
  openMasterReset("competition"),
);
$("openFactoryReset")?.addEventListener("click", () =>
  openMasterReset("factory"),
);
$("masterResetClose")?.addEventListener("click", closeMasterReset);
$("masterResetSettingsLink")?.addEventListener("click", () => {
  closeMasterReset();
  showPage("settings");
  $("resetProtectionPanel")?.scrollIntoView({ behavior: "smooth", block: "center" });
});
$("masterResetCancel")?.addEventListener("click", closeMasterReset);
masterResetDialog()?.addEventListener("click", (event) => {
  if (event.target === masterResetDialog()) closeMasterReset();
});
$("masterResetShow")?.addEventListener("click", () => {
  const input = $("masterResetPassword");
  if (!input) return;
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  const button = $("masterResetShow");
  button.textContent = reveal ? "HIDE" : "SHOW";
  button.setAttribute("aria-pressed", String(reveal));
});
document
  .querySelectorAll('input[name="masterResetScope"]')
  .forEach((radio) =>
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      masterResetScope = radio.value === "factory" ? "factory" : "competition";
      renderMasterResetScope();
    }),
  );
$("masterResetConfirm")?.addEventListener("click", async () => {
  if (masterResetBusy) return;
  const passwordInput = $("masterResetPassword");
  const password = passwordInput ? passwordInput.value : "";
  if (!password)
    return setMasterResetError(
      "Enter the reset protection password to continue.",
    );
  // A freshly opened dashboard may not have the status yet; never refuse the
  // reset on a stale "not configured" answer.
  if (!resetPasswordLoaded) await loadResetPasswordStatus();
  if (!resetPasswordInfo.configured)
    return setMasterResetError(
      "No reset password is configured yet. Set one in Tournament setup → Reset protection password first.",
    );
  if (
    masterResetScope === "factory" &&
    !confirm(
      "Factory reset also erases team registrations and approved rosters. Continue?",
    )
  )
    return;
  const button = $("masterResetConfirm");
  const label = button.textContent;
  masterResetBusy = true;
  button.disabled = true;
  button.textContent = "Resetting…";
  setMasterResetError("");
  socket
    .timeout(20000)
    .emit(
      "tournament:master-reset",
      { password, scope: masterResetScope },
      (err, response) => {
        masterResetBusy = false;
        button.disabled = false;
        button.textContent = label;
        if (err)
          return setMasterResetError(
            "The control server did not answer. Check the connection and try again.",
          );
        if (!response || response.ok === false)
          return setMasterResetError(
            (response && response.error) || "The reset could not be completed.",
          );
        lineupDirty = false;
        pendingMatchTeamIds = null;
        closeMasterReset();
        toast(
          response.scope === "factory"
            ? "Factory reset complete — the event is blank, registrations included."
            : "Event data reset to zero. Team registrations and rosters were kept.",
        );
      },
    );
});
$("saveResetPassword")?.addEventListener("click", async () => {
  const button = $("saveResetPassword");
  const payload = {
    loginPassword: $("resetSetupLoginPassword").value,
    newPassword: $("resetSetupNewPassword").value,
    confirmPassword: $("resetSetupConfirmPassword").value,
  };
  if (payload.newPassword.length < 8)
    return toast("Use a reset password between 8 and 128 characters.");
  if (payload.newPassword !== payload.confirmPassword)
    return toast("The two reset password entries do not match.");
  button.disabled = true;
  try {
    const response = await fetch("/api/admin/reset-password", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      return toast(result.error || "The reset password could not be saved.");
    ["resetSetupLoginPassword", "resetSetupNewPassword", "resetSetupConfirmPassword"].forEach(
      (id) => {
        const field = $(id);
        if (field) field.value = "";
      },
    );
    resetPasswordInfo = { ...resetPasswordInfo, ...result };
    resetPasswordLoaded = true;
    renderResetPasswordPanel();
    toast("Reset password saved. The master reset is now unlocked.");
  } catch {
    toast("The reset password could not be saved. Check the connection.");
  } finally {
    button.disabled = false;
  }
});
loadResetPasswordStatus();
$("copyOverlay").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/overlay`);
    toast("Overlay URL copied.");
  } catch {
    toast(`Overlay URL: ${location.origin}/overlay`);
  }
});

function renderRegistrationSummary() {
  const pending = registrations.filter((r) => r.status === "pending").length;
  $("registrationNavCount").textContent = `${pending} NEW`;
  const approved = registrations.filter((r) => r.status === "approved").length;
  $("regApprovedCount").textContent = approved;
  $("regPendingCount").textContent = pending;
  const cap = state?.registrationSettings?.maxTeams || 96;
  const reserved = state?.reservedRegistrationCount ?? approved + pending;
  $("regCapacityCount").textContent = `${reserved} / ${cap}`;
  $("regCapacityNote").textContent =
    `${Math.max(0, cap - reserved)} slots remaining`;
  $("regOpenState").textContent =
    state?.registrationSettings?.open === false ? "CLOSED" : "OPEN";
  renderRegistrations();
}
function renderRegistrations() {
  const root = $("registrationList");
  if (!root) return;
  const list = [...registrations]
    .filter(
      (r) => registrationFilter === "all" || r.status === registrationFilter,
    )
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  if (!list.length) {
    root.innerHTML = `<div class="empty-state">No ${registrationFilter === "all" ? "team submissions" : registrationFilter + " submissions"} yet. Share the public registration link with participating teams.</div>`;
    return;
  }
  root.innerHTML = list
    .map(
      (r) =>
        `<article class="registration-card"><div class="registration-card-top"><div><div class="registration-title"><span class="registration-code">${safe(String(r.id).slice(0, 8).toUpperCase())}</span><h4>${safe(r.teamName)}</h4><span class="registration-state ${safe(r.status)}">${safe(r.status).toUpperCase()}</span></div><p>${safe(r.college)} · Submitted ${fmtDate(r.submittedAt)}</p></div>${r.assignedTeamId ? `<div class="assigned-slot">TEAM SLOT <b>#${String(r.assignedTeamId).padStart(2, "0")}</b><small>GROUP ${safe(r.assignedGroup)}</small></div>` : ""}</div><div class="registration-details"><div><small>CAPTAIN / CONTACT</small><b>${safe(r.captainName)}</b><a href="mailto:${safe(r.email)}">${safe(r.email)}</a><span>${safe(r.phone)}</span></div><div><small>STARTING LINEUP</small><ul>${(r.playerNames || []).map((n, i) => `<li><b>${safe(n)}</b><small class="registration-player-uid">BGMI UID: ${safe((r.playerUids || [])[i] || "NOT PROVIDED")}</small></li>`).join("")}${r.substitute ? `<li class="sub-player">Sub: ${safe(r.substitute)}</li>` : ""}</ul></div><div><small>GROUP ASSIGNMENT</small>${r.status === "pending" ? `<select data-reg-group="${safe(r.id)}">${["A", "B", "C", "D", "E", "F"].map((g) => `<option value="${g}" ${(r.groupPreference || "A") === g ? "selected" : ""}>Group ${g}</option>`).join("")}</select>` : `<b>Group ${safe(r.assignedGroup || r.groupPreference || "—")}</b>`}</div></div>${r.reason ? `<p class="registration-reason">${safe(r.reason)}</p>` : ""}<div class="registration-actions">${r.status === "pending" ? `<button class="btn btn-primary" data-reg-action="approved" data-reg-id="${safe(r.id)}">✓ Approve & add to tournament</button><button class="btn btn-amber" data-reg-action="waitlisted" data-reg-id="${safe(r.id)}">Waitlist</button><button class="btn btn-danger" data-reg-action="rejected" data-reg-id="${safe(r.id)}">Reject</button>` : r.status === "approved" ? `<span class="approved-note">✓ Team profile synced to group and production roster</span>` : `<button class="btn" data-reg-action="pending" data-reg-id="${safe(r.id)}">Reopen for review</button>`}</div></article>`,
    )
    .join("");
}
document.querySelectorAll("[data-reg-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    registrationFilter = b.dataset.regFilter;
    document
      .querySelectorAll("[data-reg-filter]")
      .forEach((x) => x.classList.toggle("active", x === b));
    renderRegistrations();
  }),
);
$("registrationList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-reg-action]");
  if (!b) return;
  const registrationId = b.dataset.regId;
  const record = registrations.find((r) => r.id === registrationId);
  if (!record) return;
  const decision = b.dataset.regAction;
  if (
    decision === "pending" &&
    !confirm(`Reopen ${record.teamName} for review?`)
  )
    return;
  const group =
    $(`[data-reg-group="${CSS.escape(registrationId)}"]`)?.value ||
    record.groupPreference ||
    "A";
  let reason = "";
  if (decision === "rejected") {
    reason = prompt("Reason for rejection (optional):", "") || "";
    if (!confirm(`Reject ${record.teamName}?`)) return;
  } else if (
    decision === "approved" &&
    !confirm(
      `Approve ${record.teamName} into Group ${group} and sync its roster into tournament controls?`,
    )
  )
    return;
  socket.emit("registration:review", {
    registrationId,
    decision,
    group,
    reason,
  });
});

$("copyRegistrationUrl").addEventListener("click", async () => {
  const url = `${location.origin}/register`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Public team registration link copied.");
  } catch {
    toast(url);
  }
});
$("pingOverlay").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    $("overlayHealth").textContent =
      `Server online · ${d.connectedClients} connected client(s)`;
    $("overlayHealthDot").classList.add("online");
  } catch {
    $("overlayHealth").textContent = "Server health check failed";
    $("overlayHealthDot").classList.remove("online");
  }
});
