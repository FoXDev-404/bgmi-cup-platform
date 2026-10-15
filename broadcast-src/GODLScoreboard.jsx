import { useState } from "react";
import "./GODLScoreboard.css";

const STARTING_PLAYERS = [
  { id: 1, name: "GODL9power", uid: "5324177447", damage: 0, status: "alive" },
  { id: 2, name: "GODLManya", uid: "5246992569", damage: 0, status: "alive" },
  { id: 3, name: "GODLADMINO", uid: "6425933398", damage: 0, status: "alive" },
  { id: 4, name: "GODLNAKUL", uid: "6682980610", damage: 0, status: "alive" },
];

function Icon({ name, size = 26 }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 48 48",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": true,
    focusable: "false",
  };

  switch (name) {
    case "play":
      return <svg {...common}><path d="M14 8.5c0-1.3 1.4-2.1 2.5-1.4L39 21.7c1.1.7 1.1 2.3 0 3L16.5 40.3c-1.1.7-2.5-.1-2.5-1.4Z" fill="currentColor" /></svg>;
    case "user":
      return <svg {...common}><circle cx="24" cy="14" r="9" fill="currentColor" /><path d="M8 41c.8-9.1 6.7-14 16-14s15.2 4.9 16 14v2H8Z" fill="currentColor" /></svg>;
    case "skull":
      return <svg {...common}><path d="M24 4C13 4 6 12 6 22c0 6 3 10 8 13v7h6v-5h8v5h6v-7c5-3 8-7 8-13C42 12 35 4 24 4Z" fill="currentColor" /><circle cx="17" cy="23" r="4" fill="#E30D2A" /><circle cx="31" cy="23" r="4" fill="#E30D2A" /><path d="M24 27 21 32h6Z" fill="#E30D2A" /></svg>;
    case "gear":
      return <svg {...common}><path d="m42 27-4-3v-3l4-3-4-7-5 1-2-2-1-5h-8l-1 5-3 2-4-1-4 7 4 3v3l-4 3 4 7 5-1 2 2 1 5h8l1-5 3-2 4 1 4-7Z" fill="currentColor" /><circle cx="24" cy="22.5" r="7" fill="#041626" /></svg>;
    case "chevron":
      return <svg {...common}><path d="m11 18 13 13 13-13" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "star":
      return <svg {...common}><path d="m24 3 6.2 12.6 13.9 2-10.1 9.8 2.4 13.8L24 34.7l-12.4 6.5L14 27.4 3.9 17.6l13.9-2Z" fill="currentColor" /></svg>;
    case "flag":
      return <svg {...common}><path d="M9 43V5" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /><path d="M11 7h25l-5.5 8L36 23H11Z" fill="currentColor" /></svg>;
    default:
      return null;
  }
}

function OutlineButton({ className = "", children, ...props }) {
  return <button className={`outline-button ${className}`} {...props}>{children}</button>;
}

export default function GODLScoreboard() {
  const [finishes, setFinishes] = useState(8);
  const [placement, setPlacement] = useState(0);
  const [autoScoring, setAutoScoring] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlightActive, setHighlightActive] = useState(true);
  const [players, setPlayers] = useState(STARTING_PLAYERS);

  const updatePlayer = (id, updater) => {
    setPlayers(current => current.map(player => player.id === id ? updater(player) : player));
  };

  const changeDamage = (id, amount) => {
    updatePlayer(id, player => ({ ...player, damage: Math.max(0, player.damage + amount) }));
  };

  const setPlayerStatus = (id, status) => {
    updatePlayer(id, player => ({ ...player, status }));
  };

  const addFinish = () => setFinishes(value => value + 1);
  const changePlacement = amount => setPlacement(value => Math.max(0, value + amount));

  return (
    <main className="scoreboard-stage">
      <section className="scoreboard-shell" aria-label="GODL live match scoring panel">
        <header className="team-header">
          <div className="team-identity">
            <div className="squad-number">01</div>
            <div className="team-mark">G</div>
            <div className="team-title">
              <h1>GODL</h1>
              <p>Group A</p>
            </div>
          </div>

          <div className="team-stats">
            <div className="stat stat-finishes">
              <Icon name="star" size={22} />
              <span className="stat-label">FIN</span>
              <strong>{finishes}</strong>
            </div>
            <div className="stat stat-place">
              <Icon name="flag" size={22} />
              <span className="stat-label">PLACE</span>
              <strong>{placement || "—"}</strong>
            </div>
            <div className="stat stat-points">
              <Icon name="star" size={22} />
              <span className="stat-label">PTS</span>
              <strong>{finishes}</strong>
            </div>
          </div>

          <OutlineButton
            className={`collapse-button ${collapsed ? "is-collapsed" : ""}`}
            onClick={() => setCollapsed(value => !value)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand scoring panel" : "Collapse scoring panel"}
            title={collapsed ? "Expand panel" : "Collapse panel"}
          >
            <Icon name="chevron" size={36} />
          </OutlineButton>
        </header>

        {!collapsed && (
          <div className="scoreboard-body">
            <div className="scoring-controls">
              <button className="finish-button" onClick={addFinish}>
                <span className="plus-sign">＋</span> FINISH
              </button>

              <OutlineButton className="placement-step" onClick={() => changePlacement(-1)} aria-label="Decrease placement">−</OutlineButton>

              <div className="placement-control" aria-label="Placement control">
                <span>PLACE</span>
                <output aria-live="polite">{placement}</output>
                <OutlineButton className="placement-plus" onClick={() => changePlacement(1)} aria-label="Increase placement">＋</OutlineButton>
              </div>

              <button
                className={`auto-button ${autoScoring ? "is-on" : ""}`}
                onClick={() => setAutoScoring(value => !value)}
                aria-pressed={autoScoring}
              >
                {autoScoring ? "AUTO" : "MANUAL"}
              </button>

              <div className="settings-wrap">
                <OutlineButton className="settings-button" onClick={() => setSettingsOpen(value => !value)} aria-label="Scoring settings" aria-expanded={settingsOpen}>
                  <Icon name="gear" size={34} />
                </OutlineButton>
                {settingsOpen && (
                  <div className="settings-popover">
                    <label>
                      <input type="checkbox" checked={highlightActive} onChange={event => setHighlightActive(event.target.checked)} />
                      Highlight active players
                    </label>
                    <p>Auto scoring: <strong>{autoScoring ? "Enabled" : "Disabled"}</strong></p>
                  </div>
                )}
              </div>
            </div>

            <div className="player-list">
              {players.map(player => (
                <article className={`player-row ${highlightActive && player.status === "alive" ? "active-player" : ""}`} key={player.id}>
                  <div className="player-number">{String(player.id).padStart(2, "0")}</div>

                  <div className="player-identity">
                    <strong>{player.name}</strong>
                    <span>UID {player.uid}</span>
                  </div>

                  <div className="damage-controls">
                    <span className="damage-label">DMG</span>
                    <output className="damage-value" aria-label={`${player.name} damage`}>{player.damage}</output>
                    <OutlineButton className="damage-step" onClick={() => changeDamage(player.id, -1)} aria-label={`Decrease ${player.name} damage`}>−</OutlineButton>
                    <OutlineButton className="damage-step" onClick={() => changeDamage(player.id, 1)} aria-label={`Increase ${player.name} damage`}>＋</OutlineButton>
                  </div>

                  <div className="player-actions" role="group" aria-label={`${player.name} status`}>
                    <OutlineButton
                      className={`status-button status-alive ${player.status === "alive" ? "selected" : ""}`}
                      onClick={() => setPlayerStatus(player.id, "alive")}
                      aria-pressed={player.status === "alive"}
                      aria-label={`Mark ${player.name} alive`}
                      title="Alive"
                    ><Icon name="play" size={34} /></OutlineButton>
                    <OutlineButton
                      className={`status-button status-knock ${player.status === "knock" ? "selected" : ""}`}
                      onClick={() => setPlayerStatus(player.id, "knock")}
                      aria-pressed={player.status === "knock"}
                      aria-label={`Mark ${player.name} knocked`}
                      title="Knock"
                    ><Icon name="user" size={34} /></OutlineButton>
                    <OutlineButton
                      className={`status-button status-elim ${player.status === "eliminated" ? "selected" : ""}`}
                      onClick={() => setPlayerStatus(player.id, "eliminated")}
                      aria-pressed={player.status === "eliminated"}
                      aria-label={`Mark ${player.name} eliminated`}
                      title="Eliminated"
                    ><Icon name="skull" size={36} /></OutlineButton>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
