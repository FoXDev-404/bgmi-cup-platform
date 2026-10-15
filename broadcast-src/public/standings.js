const socket = io({ auth: { role: "spectator" } });
const $ = (id) => document.getElementById(id);
let latest = null;
function initials(value = "") {
  return (
    String(value)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((x) => x[0] || "")
      .join("")
      .toUpperCase() || "?"
  );
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function teamLogo(team) {
  const box = el("span", "public-team-logo");
  if (team.logo) {
    const img = el("img");
    img.src = team.logo;
    img.alt = "";
    img.onerror = () => {
      img.remove();
      box.textContent = initials(team.name);
    };
    box.append(img);
  } else box.textContent = initials(team.name);
  return box;
}
function setConnection(connected) {
  $("connectionBadge").classList.toggle("connected", connected);
  $("connectionBadge").innerHTML =
    `<i></i> ${connected ? "LIVE SYNC" : "RECONNECTING"}`;
}
socket.on("connect", () => setConnection(true));
socket.on("disconnect", () => setConnection(false));
socket.on("connect_error", () => setConnection(false));
socket.on("spectator:update", render);
fetch("/api/public/standings", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then(render)
  .catch(() => {});
function render(data) {
  latest = data;
  $("eventTitle").innerHTML = "";
  const title = String(
    data.tournamentName || "BGMI COLLEGE CHAMPIONSHIP",
  ).trim();
  const words = title.split(/\s+/);
  const pivot = Math.max(1, Math.ceil(words.length / 2));
  const first = words.slice(0, pivot).join(" ");
  const second = words.slice(pivot).join(" ") || "CHAMPIONSHIP";
  $("eventTitle").append(document.createTextNode(first + " "));
  const em = el("em", "", second);
  $("eventTitle").append(el("br"));
  $("eventTitle").append(em);
  $("eventSubtitle").textContent =
    `${data.organizer || "Tournament Operations"} · ${data.format || "Competitive Series"} · Results update automatically.`;
  $("currentMatchPill").textContent =
    `MATCH ${String(data.currentMatch || 1).padStart(2, "0")}`;
  $("currentGroupPill").textContent = `GROUP ${data.currentGroup || "A"}`;
  $("currentMapPill").textContent = String(
    data.currentMap || "ERANGEL",
  ).toUpperCase();
  $("matchStatusPill").textContent = String(data.matchStatus || "upcoming")
    .replaceAll("-", " ")
    .toUpperCase();
  $("metricTeams").textContent = (data.teams || []).filter(
    (t) => t.registered,
  ).length;
  $("metricMatches").textContent =
    Number(data.completedMatches) || (data.recentMatches || []).length;
  $("metricBroadcast").textContent = String(data.broadcastState || "pre-show")
    .replaceAll("-", " ")
    .toUpperCase();
  const teams = [...(data.teams || [])].sort(
    (a, b) =>
      (Number(b.overallPoints) || 0) - (Number(a.overallPoints) || 0) ||
      (Number(b.overallFinishes) || 0) - (Number(a.overallFinishes) || 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const body = $("overallRows");
  body.replaceChildren();
  teams.forEach((team, i) => {
    const tr = el("tr", "stagger-in");
    tr.style.animationDelay = `${Math.min(i, 12) * 18}ms`;
    const rank = el(
      "td",
      `rank-number ${i === 0 ? "top-one" : i === 1 ? "top-two" : i === 2 ? "top-three" : ""}`,
      String(i + 1).padStart(2, "0"),
    );
    const teamTd = el("td");
    const wrap = el("div", "public-team");
    wrap.append(teamLogo(team), el("b", "", team.name));
    teamTd.append(wrap);
    const group = el("td");
    group.append(el("span", "group-tag", `G${team.group || "A"}`));
    tr.append(
      rank,
      teamTd,
      group,
      el("td", "", team.overallWins || 0),
      el("td", "", team.overallMatches || 0),
      el("td", "", team.overallFinishes || 0),
      el("td", "", team.overallPlacementPoints || 0),
      el("td", "", team.overallPoints || 0),
    );
    body.append(tr);
  });
  if (!teams.length) body.append(emptyRow(8, "No teams registered yet."));
  const leaders = (data.overallFraggers || [])
    .filter((p) => (Number(p.kills) || 0) > 0)
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 10);
  const fraggerRoot = $("fraggerList");
  fraggerRoot.replaceChildren();
  leaders.forEach((p, i) => {
    const row = el("div", "fragger-item");
    const rank = el("span", "fragger-rank", String(i + 1).padStart(2, "0"));
    const avatar = el("span", "fragger-avatar");
    if (p.avatarUrl) {
      const img = el("img");
      img.src = p.avatarUrl;
      img.alt = "";
      img.onerror = () => {
        img.remove();
        avatar.textContent = initials(p.playerName);
      };
      avatar.append(img);
    } else avatar.textContent = initials(p.playerName);
    const info = el("div", "fragger-info");
    info.append(
      el("b", "", p.playerName),
      el("small", "", `${p.teamName} · GROUP ${p.group || "—"}`),
    );
    const val = el("span", "fragger-value", p.kills);
    val.append(el("small", "", "FIN."));
    row.append(rank, avatar, info, val);
    fraggerRoot.append(row);
  });
  if (!leaders.length)
    fraggerRoot.append(
      el(
        "div",
        "empty-message",
        "Player finishes will appear here after the operators record them.",
      ),
    );
  const leader = leaders[0];
  $("metricLeader").textContent = leader?.playerName || "—";
  $("metricLeaderSub").textContent = leader
    ? `${leader.kills} FINISHES · ${leader.teamName}`
    : "OVERALL FINISHES";
  const spot = $("spotlightAvatar");
  spot.replaceChildren();
  if (leader?.avatarUrl) {
    const img = el("img");
    img.src = leader.avatarUrl;
    img.alt = "";
    img.onerror = () => {
      img.remove();
      spot.textContent = initials(leader.playerName);
    };
    spot.append(img);
  } else spot.textContent = initials(leader?.playerName || "MVP");
  $("spotlightName").textContent = leader?.playerName || "AWAITING DATA";
  $("spotlightTeam").textContent = leader?.teamName || "OVERALL MVP";
  $("spotlightKills").textContent = leader?.kills || 0;
  $("liveMatchSubtitle").textContent =
    `MATCH ${String(data.currentMatch || 1).padStart(2, "0")} · GROUP ${data.currentGroup || "A"} · ${String(data.currentMap || "ERANGEL").toUpperCase()}`;
  $("liveStateTag").textContent = String(data.matchStatus || "upcoming")
    .replaceAll("-", " ")
    .toUpperCase();
  const live = $("liveRows");
  live.replaceChildren();
  const current = data.currentTeams || [];
  current.forEach((t, i) => {
    const tr = el("tr", "stagger-in");
    tr.style.animationDelay = `${Math.min(i, 12) * 20}ms`;
    tr.append(el("td", "", String(i + 1).padStart(2, "0")));
    const td = el("td");
    const wrap = el("div", "public-team");
    wrap.append(teamLogo(t), el("b", "", t.name));
    td.append(wrap);
    const status = el("td");
    const bar = el("span", "status-count");
    for (let n = 0; n < 4; n++) {
      const mark = el(
        "i",
        n < (t.statusCounts?.alive || 0)
          ? ""
          : n < (t.statusCounts?.alive || 0) + (t.statusCounts?.knocked || 0)
            ? "knocked"
            : "eliminated",
      );
      bar.append(mark);
    }
    status.append(bar);
    tr.append(
      td,
      status,
      el("td", "", t.kills || 0),
      el("td", "", t.placement ? `#${t.placement}` : "—"),
      el("td", "", t.matchPoints || 0),
    );
    live.append(tr);
  });
  if (!current.length)
    live.append(emptyRow(6, "Match lineup will appear here."));
  const recent = $("recentMatches");
  recent.replaceChildren();
  (data.recentMatches || []).slice(0, 6).forEach((m) => {
    const card = el("div", "recent-match");
    const head = el("div", "recent-match-head");
    head.append(
      el(
        "b",
        "",
        `MATCH ${String(m.matchNumber || 0).padStart(2, "0")} · GROUP ${m.group || "—"}`,
      ),
      el("span", "", String(m.map || "ERANGEL").toUpperCase()),
    );
    const winner =
      (m.results || []).find((r) => Number(r.placement) === 1) ||
      (m.results || [])[0];
    const line = el("div", "recent-winner");
    if (winner) {
      line.append(
        document.createTextNode("TOP SQUAD  "),
        el("strong", "", winner.teamName),
        document.createTextNode(
          ` · ${winner.matchPoints || 0} PTS · ${winner.kills || 0} FIN`,
        ),
      );
    } else line.textContent = "Results published";
    card.append(head, line);
    recent.append(card);
  });
  if (!(data.recentMatches || []).length)
    recent.append(
      el("div", "empty-message", "Finalized matches will appear here."),
    );
}
function emptyRow(colspan, text) {
  const tr = el("tr");
  const td = el("td", "empty-cell", text);
  td.colSpan = colspan;
  tr.append(td);
  return tr;
}
