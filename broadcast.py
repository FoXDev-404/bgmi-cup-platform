#!/usr/bin/env python3
"""
BGMI broadcast engine — matches, scoring, live state and the SSE hub.

Ported from the Node broadcast section (see broadcast-src/server.js) into the
registration site's stack: pure Python stdlib on top of the same SQLite
database. Approved teams, groups, rosters and logos come from the
registrations tables — the broadcast side owns NO team or player table of its
own; match_team_results/player_stats only reference registrations.team_id and
roster UIDs.

Public payloads built here (live_state/overlay_state) never contain a phone
number, e-mail or player UID — desk actions reference player_stats.id instead
of the UID, and UIDs stay inside the database for cross-match aggregation.

Run migrations via migrate(conn); server.py calls it from init_db().
"""

import json
import queue
import re
import secrets
import threading
import time
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAPS = ("Erangel", "Miramar", "Sanhok", "Livik", "Vikendi")
PLAYER_STATUSES = ("alive", "knocked", "out")
MATCH_STATUSES = ("upcoming", "live", "awaiting_verification", "published")

OVERLAY_NAMES = ("live-leaderboard", "teams-alive", "team-status-strip",
                 "elimination-popup", "match-results", "overall-standings",
                 "team-intro", "chicken-dinner", "mvp-card", "break-screen",
                 "sponsor-bug")

# B's defaults (server.js:60,77) — placement 1..8, everything below = 0.
DEFAULT_PLACEMENT_POINTS = {1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1}
DEFAULT_KILL_POINT = 1

DEFAULT_OVERLAY_SETTINGS = {
    "token": "",                 # secret URL token, rotatable
    "theme_color": "#b6ff3e",    # site lime
    "logo_path": "",
    "sponsor_text": "",
    "intro_team": "",            # team_id pinned on the team-intro overlay
    "pushed_card": "",           # JSON card pushed from the caster desk
}

DEFAULT_SCORING_RULES = dict(
    [("kill_points", str(DEFAULT_KILL_POINT))] +
    [("placement_%d" % p, str(pts))
     for p, pts in DEFAULT_PLACEMENT_POINTS.items()])


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_number  INTEGER NOT NULL UNIQUE,
  group_name    TEXT NOT NULL,
  map           TEXT NOT NULL DEFAULT 'Erangel',
  status        TEXT NOT NULL DEFAULT 'upcoming',
  sequence      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  ended_at      TEXT,
  published_at  TEXT,
  notes         TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS match_team_results (
  match_id       INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id        TEXT NOT NULL REFERENCES registrations(team_id) ON DELETE CASCADE,
  placement      INTEGER,
  placement_auto INTEGER NOT NULL DEFAULT 1,
  kills          INTEGER NOT NULL DEFAULT 0,
  points         INTEGER NOT NULL DEFAULT 0,
  eliminated_at  INTEGER,
  PRIMARY KEY (match_id, team_id)
);
CREATE TABLE IF NOT EXISTS player_stats (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id        INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id         TEXT NOT NULL,
  player_uid      TEXT NOT NULL,
  player_name     TEXT NOT NULL,
  kills           INTEGER NOT NULL DEFAULT 0,
  damage          INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'alive',
  auto_eliminated INTEGER NOT NULL DEFAULT 0,
  UNIQUE (match_id, player_uid)
);
CREATE INDEX IF NOT EXISTS idx_player_stats_match ON player_stats(match_id);
CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  match_id    INTEGER,
  type        TEXT NOT NULL,
  team_id     TEXT,
  description TEXT NOT NULL DEFAULT '',
  payload     TEXT,
  undone      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_match ON event_log(match_id);
CREATE TABLE IF NOT EXISTS scoring_rules (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS overlay_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def migrate(conn):
    """Idempotent broadcast migration. Never drops or rewrites existing data.
    Caller holds server.DB_LOCK and commits."""
    conn.executescript(SCHEMA)
    for k, v in DEFAULT_SCORING_RULES.items():
        conn.execute("INSERT OR IGNORE INTO scoring_rules (key, value) "
                     "VALUES (?, ?)", (k, v))
    for k, v in DEFAULT_OVERLAY_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO overlay_settings (key, value) "
                     "VALUES (?, ?)", (k, v))
    row = conn.execute("SELECT value FROM overlay_settings "
                       "WHERE key = 'token'").fetchone()
    if row is not None and not row["value"]:
        conn.execute("UPDATE overlay_settings SET value = ? WHERE key = 'token'",
                     (secrets.token_urlsafe(24),))


def reseed_settings(conn):
    """Re-create overlay defaults after a purge (fresh token).
    Only touches overlay_settings; safe inside an open transaction."""
    for k, v in DEFAULT_OVERLAY_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO overlay_settings (key, value) "
                     "VALUES (?, ?)", (k, v))
    conn.execute("UPDATE overlay_settings SET value = ? WHERE key = 'token'",
                 (secrets.token_urlsafe(24),))


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------

def get_bsetting(conn, key, default=""):
    row = conn.execute("SELECT value FROM overlay_settings WHERE key = ?",
                       (key,)).fetchone()
    return row["value"] if row else default


def set_bsetting(conn, key, value):
    conn.execute("INSERT INTO overlay_settings (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, str(value)))


def get_rule(conn, key, default=""):
    row = conn.execute("SELECT value FROM scoring_rules WHERE key = ?",
                       (key,)).fetchone()
    return row["value"] if row else default


def set_rule(conn, key, value):
    conn.execute("INSERT INTO scoring_rules (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, str(value)))


def load_rules(conn):
    """Scoring rules as a dict: {kill_points:int, placement:{pos:int}}."""
    kill = _clamp_int(get_rule(conn, "kill_points",
                               str(DEFAULT_KILL_POINT)), 0, 10)
    placement = {}
    for pos in range(1, 9):
        placement[pos] = _clamp_int(
            get_rule(conn, "placement_%d" % pos,
                     str(DEFAULT_PLACEMENT_POINTS[pos])), 0, 100)
    return {"kill_points": kill, "placement": placement}


def save_rules(conn, data):
    kill = _clamp_int(data.get("kill_points"), 0, 10)
    set_rule(conn, "kill_points", str(kill))
    for pos in range(1, 9):
        raw = (data.get("placement") or {}).get(str(pos), {}).get("points") \
            if isinstance(data.get("placement"), dict) else None
        if raw is None and isinstance(data.get("placement"), dict):
            raw = (data.get("placement") or {}).get(str(pos))
        val = _clamp_int(raw, 0, 100)
        set_rule(conn, "placement_%d" % pos, str(val))


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _clamp_int(value, lo, hi):
    try:
        v = int(float(value))
    except (TypeError, ValueError):
        v = lo
    return max(lo, min(hi, v))


def _clamp_str(value, limit):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def check_overlay_token(conn, token):
    """Constant-time compare against the stored overlay token."""
    import hmac as _hmac
    stored = get_bsetting(conn, "token", "")
    if not stored or not token:
        return False
    return _hmac.compare_digest(stored, str(token))


# ---------------------------------------------------------------------------
# Scoring core (ported from B's placementPoints/recalculate) — pure functions
# ---------------------------------------------------------------------------

def placement_points(position, rules):
    return int(rules["placement"].get(int(position or 0), 0))


def compute_points(kills, placement, rules):
    """matchPoints = kills * kill_points + placement_points (B recalculate)."""
    return max(0, int(kills)) * max(0, rules["kill_points"]) + \
        placement_points(placement, rules)


def squad_wiped(players):
    return bool(players) and all(p["status"] == "out" for p in players)


def apply_squad_wipe(players):
    """B's applySquadWipe: no living member means knocked players bleed out.
    Returns number of players cascaded into 'out', or -1 when a revive undid
    the auto-eliminations."""
    if not players:
        return 0
    if any(p["status"] == "alive" for p in players):
        undone = 0
        for p in players:
            if p.get("auto_eliminated"):
                p["status"] = "knocked"
                p["auto_eliminated"] = False
                undone += 1
        return -1 if undone else 0
    cascaded = 0
    for p in players:
        if p["status"] in ("knocked", "alive"):
            p["status"] = "out"
            p["auto_eliminated"] = True
            cascaded += 1
    return cascaded


def sync_auto_placements(teams, sequence):
    """B's syncAutoPlacements: placements are a permutation of 1..N, so two
    squads can never share a position. Wiped squads take free positions
    deepest-first in elimination order; operator-pinned (placement_auto=False)
    squads are never moved; a lone survivor takes the best free position.
    Mutates team dicts; returns the new elimination sequence counter."""
    active = [t for t in teams if t]
    if not active:
        return sequence
    total = len(active)
    sequence = max(0, int(sequence or 0))

    automatic = [t for t in active if t.get("placement_auto", True)]
    for team in automatic:
        wiped = squad_wiped(team.get("_players") or [])
        if not wiped:
            team["eliminated_at"] = None
            continue
        if not (team.get("eliminated_at") or 0) > 0:
            sequence += 1
            team["eliminated_at"] = sequence

    taken = set()
    for team in active:
        if not team.get("placement_auto", True):
            p = int(team.get("placement") or 0)
            if 1 <= p <= total:
                taken.add(p)
            else:
                team["placement"] = 0

    free = [pos for pos in range(total, 0, -1) if pos not in taken]
    for team in automatic:
        team["placement"] = 0
    wiped_sorted = sorted((t for t in automatic if (t.get("eliminated_at") or 0) > 0),
                          key=lambda t: t["eliminated_at"])
    for team in wiped_sorted:
        if free:
            team["placement"] = free.pop(0)
    still = [t for t in automatic if not squad_wiped(t.get("_players") or [])]
    if len(still) == 1 and free:
        still[0]["placement"] = free[-1]
    return sequence


def overall_sort_key(row):
    """Tie-breakers (spec): total points, wins, placement points, kills,
    then last-match placement (earlier is better; missing = worst)."""
    last = row.get("last_placement")
    return (-int(row.get("points") or 0),
            -int(row.get("wins") or 0),
            -int(row.get("placement_points") or 0),
            -int(row.get("kills") or 0),
            int(last) if last else 10 ** 6)


# ---------------------------------------------------------------------------
# Matches — CRUD and lifecycle (caller holds server.DB_LOCK)
# ---------------------------------------------------------------------------

def next_match_number(conn):
    row = conn.execute("SELECT MAX(match_number) AS m FROM matches").fetchone()
    return int(row["m"] or 0) + 1


def get_match(conn, match_id):
    row = conn.execute("SELECT * FROM matches WHERE id = ?",
                       (int(match_id),)).fetchone()
    return dict(row) if row else None


def list_matches(conn):
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM matches ORDER BY match_number")]
    for m in rows:
        m["team_count"] = conn.execute(
            "SELECT COUNT(*) AS c FROM match_team_results "
            "WHERE match_id = ?", (m["id"],)).fetchone()["c"]
        m["placed_count"] = conn.execute(
            "SELECT COUNT(*) AS c FROM match_team_results "
            "WHERE match_id = ? AND placement IS NOT NULL AND placement > 0",
            (m["id"],)).fetchone()["c"]
    return rows


def eligible_teams(conn, group_name):
    """Approved teams of a group — the only squads a match can contain."""
    return [dict(r) for r in conn.execute(
        "SELECT r.team_id, r.team_name, r.team_tag, r.logo_path, g.name AS group_name "
        "FROM registrations r JOIN groups g ON g.id = r.group_id "
        "WHERE r.status = 'approved' AND g.name = ? "
        "ORDER BY r.team_name", (group_name,))]


def create_match(conn, group_name, map_name="Erangel", notes="", who=""):
    group_name = _clamp_str(group_name, 20)
    if not group_name:
        raise ValueError("Pick a group for the match.")
    map_name = _clamp_str(map_name, 24) or "Erangel"
    if map_name not in MAPS:
        raise ValueError("Unknown map. Choose from: %s" % ", ".join(MAPS))
    number = next_match_number(conn)
    conn.execute(
        "INSERT INTO matches (match_number, group_name, map, status, "
        "created_at, notes) VALUES (?, ?, ?, 'upcoming', ?, ?)",
        (number, group_name, map_name, now_iso(), _clamp_str(notes, 300)))
    match_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    _log_event(conn, match_id, "create", None,
               "Match %d created — Group %s on %s" % (number, group_name, map_name))
    return get_match(conn, match_id)


def set_lineup(conn, match_id, team_ids):
    """Check-in: which approved squads of the match's group are in the lobby.
    Only allowed before the match starts. Max 16 (a BGMI lobby)."""
    match = get_match(conn, match_id)
    if not match:
        raise ValueError("Match not found.")
    if match["status"] != "upcoming":
        raise ValueError("The lineup is locked once the match has started.")
    eligible = {t["team_id"]: t for t in eligible_teams(conn, match["group_name"])}
    wanted = []
    for tid in team_ids or []:
        tid = str(tid)[:16]
        if tid in eligible and tid not in wanted:
            wanted.append(tid)
    if len(wanted) > 16:
        raise ValueError("A lobby holds at most 16 squads.")
    conn.execute("DELETE FROM match_team_results WHERE match_id = ?",
                 (int(match_id),))
    for tid in wanted:
        conn.execute(
            "INSERT INTO match_team_results (match_id, team_id) VALUES (?, ?)",
            (int(match_id), tid))
    return wanted


def ensure_player_rows(conn, match_id, team_id):
    """Create player_stats rows for a team's 4 starters (P1..P4) once."""
    rows = conn.execute(
        "SELECT ign, uid FROM roster_members WHERE team_id = ? "
        "AND role != 'sub' ORDER BY slot LIMIT 4", (team_id,)).fetchall()
    for r in rows:
        conn.execute(
            "INSERT OR IGNORE INTO player_stats "
            "(match_id, team_id, player_uid, player_name) VALUES (?,?,?,?)",
            (int(match_id), team_id, r["uid"], r["ign"]))


def start_match(conn, match_id, who=""):
    match = get_match(conn, match_id)
    if not match:
        raise ValueError("Match not found.")
    if match["status"] != "upcoming":
        raise ValueError("Only an upcoming match can start.")
    n = conn.execute("SELECT COUNT(*) AS c FROM match_team_results "
                     "WHERE match_id = ?", (int(match_id),)).fetchone()["c"]
    if n < 2:
        raise ValueError("Check in at least 2 squads before starting.")
    for r in conn.execute("SELECT team_id FROM match_team_results "
                          "WHERE match_id = ?", (int(match_id),)):
        ensure_player_rows(conn, match_id, r["team_id"])
    conn.execute("UPDATE matches SET status = 'live', started_at = ? "
                 "WHERE id = ?", (now_iso(), int(match_id)))
    _log_event(conn, match_id, "start", None,
               "Match %d is LIVE — %d squads in the lobby"
               % (match["match_number"], n))
    return get_match(conn, match_id)


def end_match(conn, match_id, who=""):
    match = get_match(conn, match_id)
    if not match:
        raise ValueError("Match not found.")
    if match["status"] != "live":
        raise ValueError("Only a live match can end.")
    conn.execute("UPDATE matches SET status = 'awaiting_verification', "
                 "ended_at = ? WHERE id = ?", (now_iso(), int(match_id)))
    _log_event(conn, match_id, "end", None,
               "Match %d ended — verify placements to publish"
               % match["match_number"])
    return get_match(conn, match_id)


def publishable_problem(conn, match_id):
    """None when the match is ready to publish, else the reason."""
    match = get_match(conn, match_id)
    if not match:
        return "Match not found."
    if match["status"] != "awaiting_verification":
        return "End the match first, then publish."
    rows = [dict(r) for r in conn.execute(
        "SELECT team_id, placement FROM match_team_results "
        "WHERE match_id = ?", (int(match_id),))]
    if len(rows) < 2:
        return "A match needs at least 2 squads."
    total = len(rows)
    placed = [int(r["placement"] or 0) for r in rows]
    missing = [r["team_id"] for r in rows if not (1 <= int(r["placement"] or 0) <= total)]
    if missing:
        return "Every squad needs a placement (1-%d) before publishing." % total
    if len(set(placed)) != len(placed):
        dupes = sorted({p for p in placed if placed.count(p) > 1})
        return "Placement %s is claimed by more than one squad." % \
            ", ".join(str(d) for d in dupes)
    return None


def publish_match(conn, match_id, who=""):
    problem = publishable_problem(conn, match_id)
    if problem:
        raise ValueError(problem)
    match = get_match(conn, match_id)
    rules = load_rules(conn)
    for r in conn.execute("SELECT * FROM match_team_results "
                          "WHERE match_id = ?", (int(match_id),)):
        pts = compute_points(r["kills"], r["placement"], rules)
        conn.execute("UPDATE match_team_results SET points = ? "
                     "WHERE match_id = ? AND team_id = ?",
                     (pts, int(match_id), r["team_id"]))
    conn.execute("UPDATE matches SET status = 'published', published_at = ? "
                 "WHERE id = ?", (now_iso(), int(match_id)))
    _log_event(conn, match_id, "publish", None,
               "Match %d results published" % match["match_number"])
    return get_match(conn, match_id)


def unpublish_match(conn, match_id, who=""):
    match = get_match(conn, match_id)
    if not match:
        raise ValueError("Match not found.")
    if match["status"] != "published":
        raise ValueError("Only a published match can be unpublished.")
    conn.execute("UPDATE matches SET status = 'awaiting_verification', "
                 "published_at = NULL WHERE id = ?", (int(match_id),))
    _log_event(conn, match_id, "unpublish", None,
               "Match %d unpublished for correction" % match["match_number"])
    return get_match(conn, match_id)


def reset_match(conn, match_id, who=""):
    """Return a match to 'upcoming' and wipe its live inputs (results rows
    are kept as checked-in lineup)."""
    match = get_match(conn, match_id)
    if not match:
        raise ValueError("Match not found.")
    conn.execute(
        "UPDATE matches SET status = 'upcoming', started_at = NULL, "
        "ended_at = NULL, published_at = NULL, sequence = 0 WHERE id = ?",
        (int(match_id),))
    conn.execute("UPDATE match_team_results SET placement = NULL, "
                 "placement_auto = 1, kills = 0, points = 0, "
                 "eliminated_at = NULL WHERE match_id = ?", (int(match_id),))
    conn.execute("UPDATE player_stats SET kills = 0, damage = 0, "
                 "status = 'alive', auto_eliminated = 0 "
                 "WHERE match_id = ?", (int(match_id),))
    _log_event(conn, match_id, "reset", None,
               "Match %d inputs reset" % match["match_number"])
    return get_match(conn, match_id)


def delete_match(conn, match_id, who=""):
    match = get_match(conn, match_id)
    if not match:
        raise ValueError("Match not found.")
    if match["status"] == "published":
        raise ValueError("Unpublish the match before deleting it.")
    conn.execute("DELETE FROM matches WHERE id = ?", (int(match_id),))


# ---------------------------------------------------------------------------
# Event log + undo
# ---------------------------------------------------------------------------

def _log_event(conn, match_id, type_, team_id, description, payload=None):
    conn.execute(
        "INSERT INTO event_log (at, match_id, type, team_id, description, "
        "payload) VALUES (?,?,?,?,?,?)",
        (now_iso(), int(match_id) if match_id else None, type_, team_id,
         _clamp_str(description, 200),
         json.dumps(payload) if payload else None))


def _snapshot(conn, match_id, team_id):
    """Undo payload: the team row plus every player row of this match."""
    team = conn.execute(
        "SELECT * FROM match_team_results WHERE match_id = ? AND team_id = ?",
        (int(match_id), team_id)).fetchone()
    players = conn.execute(
        "SELECT * FROM player_stats WHERE match_id = ? AND team_id = ?",
        (int(match_id), team_id)).fetchall()
    return {"team": dict(team) if team else None,
            "players": [dict(p) for p in players]}


def undo_last(conn, match_id, who=""):
    """Revert the most recent not-yet-undone action on this match."""
    row = conn.execute(
        "SELECT * FROM event_log WHERE match_id = ? AND undone = 0 "
        "AND type NOT IN ('undo') ORDER BY id DESC LIMIT 1",
        (int(match_id),)).fetchone()
    if not row:
        raise ValueError("Nothing left to undo on this match.")
    payload = json.loads(row["payload"]) if row["payload"] else None
    if not payload or not payload.get("team"):
        conn.execute("UPDATE event_log SET undone = 1 WHERE id = ?",
                     (row["id"],))
        raise ValueError("That action cannot be undone.")
    team = payload["team"]
    conn.execute(
        "UPDATE match_team_results SET placement = ?, placement_auto = ?, "
        "kills = ?, points = ?, eliminated_at = ? "
        "WHERE match_id = ? AND team_id = ?",
        (team["placement"], team["placement_auto"], team["kills"],
         team["points"], team["eliminated_at"], int(match_id),
         team["team_id"]))
    for p in payload["players"]:
        conn.execute(
            "UPDATE player_stats SET kills = ?, damage = ?, status = ?, "
            "auto_eliminated = ? WHERE match_id = ? AND player_uid = ?",
            (p["kills"], p["damage"], p["status"], p["auto_eliminated"],
             int(match_id), p["player_uid"]))
    conn.execute("UPDATE event_log SET undone = 1 WHERE id = ?", (row["id"],))
    _log_event(conn, match_id, "undo", row["team_id"],
               "Undid: %s" % (row["description"] or row["type"]))
    _resync(conn, match_id)


# ---------------------------------------------------------------------------
# Live desk actions (caller holds server.DB_LOCK)
# ---------------------------------------------------------------------------

def _match_teams_rows(conn, match_id):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM match_team_results WHERE match_id = ?",
        (int(match_id),))]


def _team_players(conn, match_id, team_id):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM player_stats WHERE match_id = ? AND team_id = ? "
        "ORDER BY id", (int(match_id), team_id))]


def _team_name(conn, team_id):
    row = conn.execute("SELECT team_name, team_tag FROM registrations "
                       "WHERE team_id = ?", (team_id,)).fetchone()
    return (row["team_name"], row["team_tag"]) if row else ("?", "")


def _resync(conn, match_id):
    """Re-run squad-wipe cascade + auto placement + points for a match."""
    match = get_match(conn, match_id)
    if not match:
        return
    rules = load_rules(conn)
    team_rows = _match_teams_rows(conn, match_id)
    view = []
    for t in team_rows:
        players = _team_players(conn, match_id, t["team_id"])
        apply_squad_wipe(players)
        for p in players:
            conn.execute(
                "UPDATE player_stats SET status = ?, auto_eliminated = ? "
                "WHERE id = ?", (p["status"], p["auto_eliminated"], p["id"]))
        row = dict(t)
        row["_players"] = players
        view.append(row)
    sequence = sync_auto_placements(view, match["sequence"])
    if sequence != match["sequence"]:
        conn.execute("UPDATE matches SET sequence = ? WHERE id = ?",
                     (sequence, int(match_id)))
    for row in view:
        pts = compute_points(row["kills"], row["placement"], rules)
        conn.execute(
            "UPDATE match_team_results SET placement = ?, eliminated_at = ?, "
            "points = ? WHERE match_id = ? AND team_id = ?",
            (row["placement"], row["eliminated_at"], pts,
             int(match_id), row["team_id"]))


def _require_team(conn, match_id, team_id):
    row = conn.execute(
        "SELECT * FROM match_team_results WHERE match_id = ? AND team_id = ?",
        (int(match_id), team_id)).fetchone()
    if not row:
        raise ValueError("That squad is not in this match.")
    return dict(row)


def team_kill_delta(conn, match_id, team_id, delta, who=""):
    match = get_match(conn, match_id)
    if not match or match["status"] not in ("live", "awaiting_verification"):
        raise ValueError("The match is not live.")
    team = _require_team(conn, match_id, team_id)
    snap = _snapshot(conn, match_id, team_id)
    delta = _clamp_int(delta, -50, 50)
    kills = max(0, int(team["kills"]) + delta)
    conn.execute("UPDATE match_team_results SET kills = ? "
                 "WHERE match_id = ? AND team_id = ?",
                 (kills, int(match_id), team_id))
    name, _ = _team_name(conn, team_id)
    _log_event(conn, match_id, "kill", team_id,
               "%s team kills: %d (+%d)" % (name, kills, delta), snap)
    _resync(conn, match_id)


def player_action(conn, match_id, team_id, player_id, field, value, who=""):
    """field: 'kill' (delta), 'damage' (absolute), 'status' (alive|knocked|out)."""
    match = get_match(conn, match_id)
    if not match or match["status"] not in ("live", "awaiting_verification"):
        raise ValueError("The match is not live.")
    _require_team(conn, match_id, team_id)
    p = conn.execute("SELECT * FROM player_stats WHERE id = ? AND match_id = ?",
                     (int(player_id), int(match_id))).fetchone()
    if not p:
        raise ValueError("Player not found in this match.")
    snap = _snapshot(conn, match_id, team_id)
    name = p["player_name"]
    tname, _ = _team_name(conn, team_id)
    if field == "kill":
        kills = max(0, int(p["kills"]) + _clamp_int(value, -50, 50))
        conn.execute("UPDATE player_stats SET kills = ? WHERE id = ?",
                     (kills, p["id"]))
        desc = "%s (%s) frags: %d" % (name, tname, kills)
    elif field == "damage":
        dmg = max(0, min(50000, _clamp_int(value, 0, 50000)))
        conn.execute("UPDATE player_stats SET damage = ? WHERE id = ?",
                     (dmg, p["id"]))
        desc = "%s (%s) damage: %d" % (name, tname, dmg)
    elif field == "status":
        status = str(value)
        if status not in PLAYER_STATUSES:
            raise ValueError("Unknown player status.")
        conn.execute("UPDATE player_stats SET status = ?, auto_eliminated = 0 "
                     "WHERE id = ?", (status, p["id"]))
        desc = "%s (%s) is %s" % (name, tname, status)
    else:
        raise ValueError("Unknown player field.")
    _log_event(conn, match_id, "player", team_id, desc, snap)
    _resync(conn, match_id)


def eliminate_team(conn, match_id, team_id, who=""):
    """One-click squad wipe: everyone out; auto-placement assigns the next
    free position. Suggests nothing typed — sync_auto_placements decides."""
    match = get_match(conn, match_id)
    if not match or match["status"] not in ("live", "awaiting_verification"):
        raise ValueError("The match is not live.")
    team = _require_team(conn, match_id, team_id)
    snap = _snapshot(conn, match_id, team_id)
    for p in _team_players(conn, match_id, team_id):
        if p["status"] != "out":
            conn.execute("UPDATE player_stats SET status = 'out', "
                         "auto_eliminated = 1 WHERE id = ?", (p["id"],))
    _resync(conn, match_id)
    placed = conn.execute(
        "SELECT placement FROM match_team_results WHERE match_id = ? "
        "AND team_id = ?", (int(match_id), team_id)).fetchone()["placement"]
    name, _ = _team_name(conn, team_id)
    _log_event(conn, match_id, "eliminate", team_id,
               "%s eliminated — %s place" % (name, ordinal(placed)), snap)


def set_placement(conn, match_id, team_id, placement, manual=True, who=""):
    match = get_match(conn, match_id)
    if not match or match["status"] not in ("live", "awaiting_verification"):
        raise ValueError("The match is not live.")
    _require_team(conn, match_id, team_id)
    rows = _match_teams_rows(conn, match_id)
    total = len(rows)
    placement = _clamp_int(placement, 0, total)
    if manual and placement > 0:
        for r in rows:
            if r["team_id"] != team_id and int(r["placement"] or 0) == placement:
                other, _ = _team_name(conn, r["team_id"])
                raise ValueError("Place %d already belongs to %s."
                                 % (placement, other))
    snap = _snapshot(conn, match_id, team_id)
    conn.execute(
        "UPDATE match_team_results SET placement = ?, placement_auto = ? "
        "WHERE match_id = ? AND team_id = ?",
        (placement, 1 if not manual else 0, int(match_id), team_id))
    name, _ = _team_name(conn, team_id)
    _log_event(conn, match_id, "placement", team_id,
               "%s pinned to %s place" % (name, ordinal(placement) if placement
                                          else "no"), snap)
    _resync(conn, match_id)


def ordinal(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "?"
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return "%d%s" % (n, suffix)


# ---------------------------------------------------------------------------
# Aggregations (no PII ever leaves these builders)
# ---------------------------------------------------------------------------

def team_public_row(conn, team_id, group_name=None):
    row = conn.execute(
        "SELECT team_id, team_name, team_tag, logo_path FROM registrations "
        "WHERE team_id = ?", (team_id,)).fetchone()
    if not row:
        return {"teamId": team_id, "teamName": "?", "teamTag": "?",
                "logo": "", "group": group_name or ""}
    group = group_name
    if group is None:
        g = conn.execute(
            "SELECT g.name AS n FROM registrations r "
            "LEFT JOIN groups g ON g.id = r.group_id WHERE r.team_id = ?",
            (team_id,)).fetchone()
        group = g["n"] if g and g["n"] else ""
    return {"teamId": team_id, "teamName": row["team_name"],
            "teamTag": row["team_tag"], "logo": row["logo_path"] or "",
            "group": group or ""}


def match_state(conn, match_id):
    """Full desk payload for one match (admin only; still no PII)."""
    match = get_match(conn, match_id)
    if not match:
        return None
    rules = load_rules(conn)
    teams = []
    alive_total = 0
    for r in _match_teams_rows(conn, match_id):
        pub = team_public_row(conn, r["team_id"], match["group_name"])
        players = []
        alive = knocked = out = 0
        for p in _team_players(conn, match_id, r["team_id"]):
            players.append({"id": p["id"], "name": p["player_name"],
                            "kills": p["kills"], "damage": p["damage"],
                            "status": p["status"]})
            if p["status"] == "alive":
                alive += 1
            elif p["status"] == "knocked":
                knocked += 1
            else:
                out += 1
        if alive or knocked:
            alive_total += 1
        teams.append(dict(pub, kills=r["kills"],
                          placement=r["placement"],
                          placementAuto=bool(r["placement_auto"]),
                          points=compute_points(r["kills"], r["placement"],
                                                rules),
                          eliminatedAt=r["eliminated_at"],
                          players=players,
                          alive=alive, knocked=knocked, out=out))
    teams.sort(key=lambda t: (-t["points"],
                              t["placement"] or 10 ** 6, -t["kills"],
                              t["teamName"]))
    problem = publishable_problem(conn, match_id) \
        if match["status"] == "awaiting_verification" else None
    return {"match": {k: match[k] for k in
                      ("id", "match_number", "group_name", "map", "status",
                       "created_at", "started_at", "ended_at", "published_at",
                       "notes")},
            "rules": rules, "teams": teams, "teamsAlive": alive_total,
            "publishProblem": problem,
            "events": event_rows(conn, match_id, 40)}


def event_rows(conn, match_id=None, limit=30):
    q = ("SELECT id, at, match_id, type, team_id, description, undone "
         "FROM event_log ")
    args = []
    if match_id:
        q += "WHERE match_id = ? "
        args.append(int(match_id))
    q += "ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    out = []
    for r in conn.execute(q, args):
        d = dict(r)
        d["at"] = d["at"][:19].replace("T", " ")
        if d["match_id"]:
            m = conn.execute("SELECT match_number FROM matches WHERE id = ?",
                             (d["match_id"],)).fetchone()
            d["matchNumber"] = m["match_number"] if m else None
        else:
            d["matchNumber"] = None
        del d["match_id"]
        del d["team_id"]
        out.append(d)
    return out


def standings_rows(conn, group_name=None, include_live=False):
    """Overall standings from published matches (optionally + the live one).
    Tie-breakers: points, wins, placement points, kills, last placement."""
    rules = load_rules(conn)
    statuses = ("m.status = 'published'",)
    if include_live:
        statuses = ("m.status IN ('published', 'live', 'awaiting_verification')",)
    q = ("SELECT mtr.team_id, mtr.placement, mtr.kills, mtr.points, m.id "
         "FROM match_team_results mtr JOIN matches m ON m.id = mtr.match_id "
         "WHERE " + statuses[0])
    if group_name:
        q += " AND m.group_name = ?"
    q += " ORDER BY m.match_number"
    args = [group_name] if group_name else []
    totals = {}
    for r in conn.execute(q, args):
        t = totals.setdefault(r["team_id"], {
            "points": 0, "kills": 0, "matches": 0, "wins": 0,
            "placement_points": 0, "last_placement": None})
        t["points"] += int(r["points"] or 0)
        t["kills"] += int(r["kills"] or 0)
        t["matches"] += 1
        if int(r["placement"] or 0) == 1:
            t["wins"] += 1
        t["placement_points"] += placement_points(r["placement"], rules)
        t["last_placement"] = int(r["placement"]) if r["placement"] else None
    rows = []
    for team_id, t in totals.items():
        pub = team_public_row(conn, team_id)
        if group_name and pub["group"] != group_name:
            continue
        rows.append(dict(pub, points=t["points"], kills=t["kills"],
                         matches=t["matches"], wins=t["wins"],
                         placementPoints=t["placement_points"],
                         lastPlacement=t["last_placement"]))
    rows.sort(key=overall_sort_key)
    for i, row in enumerate(rows, 1):
        row["rank"] = i
    return rows


def group_tables(conn, include_live=False):
    groups = [dict(r) for r in conn.execute(
        "SELECT id, name FROM groups ORDER BY name")]
    out = []
    for g in groups:
        rows = standings_rows(conn, g["name"], include_live)
        if rows:
            out.append({"group": g["name"], "rows": rows})
    return out


def live_match(conn):
    """The match the desk is driving: the live one, else the newest."""
    m = conn.execute("SELECT * FROM matches WHERE status = 'live' "
                     "ORDER BY match_number DESC LIMIT 1").fetchone()
    if not m:
        m = conn.execute("SELECT * FROM matches "
                         "ORDER BY match_number DESC LIMIT 1").fetchone()
    return dict(m) if m else None


def current_teams_state(conn, match):
    if not match:
        return []
    teams = []
    for r in _match_teams_rows(conn, match["id"]):
        pub = team_public_row(conn, r["team_id"], match["group_name"])
        players = _team_players(conn, match["id"], r["team_id"])
        alive = sum(1 for p in players if p["status"] == "alive")
        knocked = sum(1 for p in players if p["status"] == "knocked")
        outn = sum(1 for p in players if p["status"] == "out")
        teams.append(dict(pub, kills=r["kills"], placement=r["placement"],
                          points=r["points"], alive=alive, knocked=knocked,
                          out=outn,
                          players=[{"name": p["player_name"],
                                    "status": p["status"],
                                    "kills": p["kills"],
                                    "damage": p["damage"]}
                                   for p in players]))
    teams.sort(key=lambda t: (-t["points"],
                              t["placement"] or 10 ** 6, -t["kills"],
                              t["teamName"]))
    return teams


def player_leaders(conn, limit=20, include_live=False):
    """Top fraggers by UID aggregation across matches. No UIDs in output."""
    q = ("SELECT ps.player_uid, ps.player_name, SUM(ps.kills) AS kills, "
         "SUM(ps.damage) AS damage, COUNT(DISTINCT ps.match_id) AS matches, "
         "mtr.team_id "
         "FROM player_stats ps "
         "JOIN matches m ON m.id = ps.match_id "
         "LEFT JOIN match_team_results mtr ON mtr.match_id = ps.match_id "
         "AND mtr.team_id = ps.team_id "
         "WHERE m.status " +
         ("IN ('published', 'live', 'awaiting_verification')"
          if include_live else "= 'published'") +
         " GROUP BY ps.player_uid, ps.player_name "
          "ORDER BY kills DESC, damage DESC LIMIT ?")
    rows = []
    for r in conn.execute(q, [int(limit)]):
        pub = team_public_row(conn, r["team_id"]) if r["team_id"] else {}
        rows.append({"player": r["player_name"],
                     "teamName": pub.get("teamName", "?"),
                     "teamTag": pub.get("teamTag", "?"),
                     "logo": pub.get("logo", ""),
                     "group": pub.get("group", ""),
                     "kills": int(r["kills"] or 0),
                     "damage": int(r["damage"] or 0),
                     "matches": int(r["matches"] or 0)})
    return rows


def match_mvp(conn, match):
    """Top fragger of a match (tie: damage)."""
    if not match:
        return None
    rows = [dict(r) for r in conn.execute(
        "SELECT player_name, team_id, kills, damage FROM player_stats "
        "WHERE match_id = ? ORDER BY kills DESC, damage DESC LIMIT 1",
        (match["id"],))]
    if not rows or int(rows[0]["kills"] or 0) <= 0:
        return None
    r = rows[0]
    pub = team_public_row(conn, r["team_id"])
    return {"player": r["player_name"], "kills": int(r["kills"]),
            "damage": int(r["damage"]), "teamName": pub["teamName"],
            "teamTag": pub["teamTag"], "logo": pub["logo"],
            "group": pub["group"]}


def recent_matches(conn, limit=6):
    out = []
    for m in conn.execute(
            "SELECT * FROM matches WHERE status = 'published' "
            "ORDER BY match_number DESC LIMIT ?", (int(limit),)):
        match = dict(m)
        results = []
        for r in conn.execute(
                "SELECT * FROM match_team_results WHERE match_id = ? "
                "ORDER BY placement", (match["id"],)):
            pub = team_public_row(conn, r["team_id"], match["group_name"])
            results.append(dict(pub, kills=r["kills"],
                                placement=r["placement"], points=r["points"]))
        out.append({"matchNumber": match["match_number"],
                    "group": match["group_name"], "map": match["map"],
                    "publishedAt": match["published_at"],
                    "results": results})
    return out


def pushed_card(conn):
    raw = get_bsetting(conn, "pushed_card", "")
    if not raw:
        return None
    try:
        card = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(card, dict):
        return None
    if time.time() - float(card.get("at") or 0) > 90:
        return None      # stale cards fade out on their own
    card.pop("at", None)
    return card


# ---------------------------------------------------------------------------
# Public state builders
# ---------------------------------------------------------------------------

def live_state(conn):
    """Sanitized live payload for /live, /results and overlays.
    Contains team names/tags/logos/groups and player IGNs only — never
    e-mail, phone or UID."""
    match = live_match(conn)
    current = match_state(conn, match["id"]) if match else None
    groups = group_tables(conn, include_live=True)
    overall = standings_rows(conn, None, include_live=True)
    published = standings_rows(conn, None, include_live=False)
    leaders = player_leaders(conn, 10, include_live=True)
    return {
        "ok": True,
        "match": current["match"] if current else None,
        "teams": current["teams"] if current else [],
        "teamsAlive": current["teamsAlive"] if current else 0,
        "groups": groups,
        "overall": overall,
        "overallPublished": published,
        "leaders": leaders,
        "recentMatches": recent_matches(conn, 6),
        "events": event_rows(conn, None, 25),
        "rules": load_rules(conn),
        "sponsor": get_bsetting(conn, "sponsor_text", ""),
        "updatedAt": now_iso(),
    }


def overlay_state(conn, name):
    """Per-overlay payload (token-gated). Same PII guarantees as live_state."""
    if name not in OVERLAY_NAMES:
        return None
    match = live_match(conn)
    teams = current_teams_state(conn, match)
    live = match["status"] == "live" if match else False
    overall = standings_rows(conn, None, include_live=True)
    published = standings_rows(conn, None, include_live=False)
    recents = recent_matches(conn, 1)
    last = recents[0] if recents else None
    events = event_rows(conn, None, 12)
    winner = None
    mvp = None
    if last and last["results"]:
        winner = last["results"][0]
        mvp = match_mvp(conn, {"id": conn.execute(
            "SELECT id FROM matches WHERE match_number = ?",
            (last["matchNumber"],)).fetchone()["id"]})
    intro_team = get_bsetting(conn, "intro_team", "")
    intro = None
    if intro_team:
        pub = team_public_row(conn, intro_team)
        if pub["teamName"] != "?":
            roster = [r["ign"] for r in conn.execute(
                "SELECT ign FROM roster_members WHERE team_id = ? "
                "AND role != 'sub' ORDER BY slot LIMIT 4", (intro_team,))]
            intro = dict(pub, roster=roster)
    data = {
        "live-leaderboard": {"match": _pub_match(match), "teams": teams,
                             "live": live},
        "teams-alive": {"match": _pub_match(match), "live": live,
                        "teamsAlive": sum(1 for t in teams
                                          if t["alive"] or t["knocked"]),
                        "teams": [{"teamName": t["teamName"],
                                   "teamTag": t["teamTag"],
                                   "logo": t["logo"],
                                   "alive": t["alive"],
                                   "knocked": t["knocked"],
                                   "out": t["out"]}
                                  for t in teams]},
        "team-status-strip": {"match": _pub_match(match), "live": live,
                              "teams": [{"teamTag": t["teamTag"],
                                         "teamName": t["teamName"],
                                         "logo": t["logo"],
                                         "alive": t["alive"],
                                         "knocked": t["knocked"],
                                         "out": t["out"]}
                                        for t in teams]},
        "elimination-popup": {"match": _pub_match(match), "live": live,
                              "lastElimination": next(
                                  (e for e in event_rows(conn, None, 40)
                                   if e["type"] == "eliminate"
                                   and not e["undone"]), None)},
        "match-results": {"match": last, "results": last["results"] if last else []},
        "overall-standings": {"rows": overall[:16], "groups":
                              group_tables(conn, include_live=True)},
        "team-intro": {"team": intro},
        "chicken-dinner": {"match": last, "winner": winner, "mvp": mvp},
        "mvp-card": {"card": pushed_card(conn) or mvp,
                     "mode": "caster" if pushed_card(conn) else "auto"},
        "break-screen": {"sponsor": get_bsetting(conn, "sponsor_text", ""),
                         "schedule": None, "match": _pub_match(match)},
        "sponsor-bug": {"sponsor": get_bsetting(conn, "sponsor_text", ""),
                        "logo": get_bsetting(conn, "logo_path", "")},
    }[name]
    return {"name": name,
            "themeColor": get_bsetting(conn, "theme_color", "#b6ff3e"),
            "logo": get_bsetting(conn, "logo_path", ""),
            "sponsor": get_bsetting(conn, "sponsor_text", ""),
            "data": data, "updatedAt": now_iso()}


def _pub_match(match):
    if not match:
        return None
    return {"id": match["id"], "number": match["match_number"],
            "group": match["group_name"], "map": match["map"],
            "status": match["status"], "startedAt": match["started_at"]}


# ---------------------------------------------------------------------------
# SSE hub — one publish fans out to every subscriber of a topic
# ---------------------------------------------------------------------------

class EventHub:
    """Tiny broker for Server-Sent Events. Each subscriber gets its own
    queue; publishing never blocks a request thread. Queues are bounded —
    a stuck client is skipped rather than allowed to grow memory."""

    def __init__(self, maxsize=32):
        self._lock = threading.Lock()
        self._subs = {}          # topic -> {token: Queue}
        self._maxsize = maxsize

    def subscribe(self, topic):
        q = queue.Queue(maxsize=self._maxsize)
        token = secrets.token_hex(8)
        with self._lock:
            self._subs.setdefault(topic, {})[token] = q
        return topic, token, q

    def unsubscribe(self, topic, token):
        with self._lock:
            subs = self._subs.get(topic)
            if subs:
                subs.pop(token, None)
                if not subs:
                    self._subs.pop(topic, None)

    def publish(self, topic, payload):
        with self._lock:
            subs = list(self._subs.get(topic, {}).values())
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass     # slow consumer catches up via its next poll/snapshot

    def subscribers(self):
        with self._lock:
            return sum(len(s) for s in self._subs.values())


HUB = EventHub()


def publish_update(kind="state"):
    """Fan out a change signal; clients refetch their state endpoint."""
    payload = {"type": kind, "at": now_iso()}
    HUB.publish("live", payload)
    HUB.publish("overlay", payload)
    HUB.publish("admin", payload)
