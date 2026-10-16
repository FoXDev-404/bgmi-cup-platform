"""Reset + seed the demo database with a 32-team anime-inspired cup.

    python scripts/seed_demo.py                 # seed; re-runnable on demo data
    python scripts/seed_demo.py --reset --yes   # force a reset (non-interactive)
    python scripts/seed_demo.py --scenario mixed
    python scripts/seed_demo.py --with-results

Safety rails
- Before any wipe the database + uploads are archived to
  <db-dir>/backups/pre-reset-YYYYMMDD-HHMM.db (a zip: db/ + uploads/) and the
  archive is verified (CRC + SQLite header).  A failed backup aborts the run.
- If the database holds rows that do NOT look like demo data (demo = emails
  @example.com, legacy @demo.invalid, or the demo_seed setting) the run stops
  and changes nothing until you pass --reset.  --reset asks for a typed RESET
  unless --yes is given.

What a reset keeps: schema, admin users, audit history.  What it rebuilds:
registrations (32 teams, slots 1-32, 4 starters + 1-2 subs on half the squads),
Group A + Group B (16 each, unlocked) assigned from the approved squads, one
scheduled match per group (-with-results also plays + publishes a Group A
opener), default scoring rules, settings defaults except slot_limit 32, fresh
overlay tokens, and the demo marker (settings.demo_seed=1) that powers the
"DEMO DATA" badge.  Purge or --reset removes the marker with the data.

Path selection: --db > BGMI_DB_PATH > BGMI_DB > data/registrations.db.
Uploads: --uploads > BGMI_UPLOADS > <db-dir>/uploads.
"""
import argparse
import itertools
import os
import sqlite3
import struct
import sys
import time
import zipfile
import zlib
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 32 anime-inspired squads: (team name, tag). Names 3-24 chars, tags A-Z0-9.
TEAMS = [
    ("Hidden Leaf", "HLEF"),
    ("Straw Hat Pirates", "SHTP"),
    ("Survey Corps", "SVYC"),
    ("Demon Slayer Corps", "DSCP"),
    ("Soul Reaper Squad", "SRSQ"),
    ("Phantom Thieves", "PHTV"),
    ("Capsule Corporation", "CAPC"),
    ("Fairy Tail Guild", "FTGD"),
    ("Titan Shifter Unit", "TITN"),
    ("Akatsuki Order", "AKTK"),
    ("Espada Arrancar", "ESPD"),
    ("Thousand Sunny", "SUNY"),
    ("Gear Five", "GEAR"),
    ("Thunder Breathing", "THBR"),
    ("Water Hashira", "WHSR"),
    ("Flame Hashira", "FHSR"),
    ("Jaeger Corps", "JGCR"),
    ("ODM Vanguard", "ODMV"),
    ("Chimera Ants", "CMRA"),
    ("Phantom Troupe", "PHTR"),
    ("Zoldyck Assassins", "ZLDY"),
    ("Spiral Energy", "SPLR"),
    ("Mecha Pilots", "MCHA"),
    ("Bebop Bounty", "BEBP"),
    ("Alchemical Order", "ALCH"),
    ("Homunculus Squad", "HMNQ"),
    ("Kira Hunters", "KIRA"),
    ("Death Note Detectives", "DNDT"),
    ("Pirate Emperors", "EMPR"),
    ("Grand Line Captains", "GLCP"),
    ("Marine Admirals", "MRAD"),
    ("Warlord Seven", "WLSD"),
]

# Captain IGNs, one per squad (3-16 chars, the site IGN alphabet).
CAPTAINS = [
    "NARUTO_7", "LUFFY_5G", "LEVI_13", "TANJIRO_9", "ICHIGO_15", "JOKER_A",
    "BULMA_22", "NATSU_DRG", "EREN_104", "ITACHI_7", "ULQI_4", "FRANKY_8",
    "GEAR5_LF", "ZENITSU_9", "GIYU_11", "RENGOKU_9", "MIKASA_8", "ARMIN_104",
    "MERUEM_1", "CHROLLO_7", "KILLUA_3", "SIMON_11", "SHINJI_01", "SPIKE_207",
    "EDWARD_7", "ENVY_09", "L_LAWLIET", "NEAR_01", "SHANKS_9", "KID_11",
    "AOKIJI_9", "MIHAWK_7",
]

# Filler players for P2-P4 + subs.
POOL = [
    "SHADOW", "BLAZE", "VIPER", "ORION", "RAVEN", "ZENITH", "FALCON", "NOVA",
    "GHOST", "TITAN", "AXIOM", "ECHO", "LYNX", "ONYX", "PYRO", "QUASAR",
    "RIFT", "SABLE", "TALON", "UMBRA", "VORTEX", "WRAITH", "XENON", "YUKI",
    "ZEPHYR", "CORVUS", "DRIFT", "EMBER", "FLUX", "GLITCH",
]

SCENARIOS = {
    # tournament-ready: every squad approved, both groups full
    "full": ["approved"] * 32,
    # UI review pass: 20 approved + the rest in every other status
    "mixed": (["approved"] * 20 + ["pending"] * 6 + ["rejected"] * 3 +
              ["waitlisted"] * 2 + ["needs_changes"]),
}

STATUS_NOTES = {
    "approved": "You're in. Group and schedule on your status page.",
    "pending": "",
    "needs_changes": "Captain UID looks mistyped — fix and resubmit.",
    "rejected": "Duplicate roster — two players already on another squad.",
    "waitlisted": "Bracket full for now — you're first in line if a slot opens.",
}

# 5x7 pixel font for the logo tiles (A-Z, 0-9) — "1" = lit pixel.
FONT = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01110", "10001", "10000", "10111", "10001", "10001", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("11111", "00100", "00100", "00100", "00100", "00100", "11111"),
    "J": ("00111", "00010", "00010", "00010", "00010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "11011", "10001"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11111", "00010", "00100", "00010", "00001", "10001", "01110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
}

LOGO_SIZE = 192
LOGO_BG = (12, 13, 16)        # site near-black
LOGO_FG = (182, 255, 62)      # site lime


# ---------------------------------------------------------------------------
# little stdlib PNG writer for the logo tiles
# ---------------------------------------------------------------------------

def _chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data +
            struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def logo_png(tag):
    """Render the tag initials on a dark tile. PNG via struct + zlib only."""
    letters = [FONT[c] for c in tag.upper() if c in FONT][:5]
    if not letters:
        letters = [FONT["X"]]
    unit_w = 5 * len(letters) + (len(letters) - 1)
    unit_h = 7
    scale = max(2, min(10, (LOGO_SIZE - 32) // unit_w, (LOGO_SIZE - 32) // unit_h))
    text_w, text_h = unit_w * scale, unit_h * scale
    x0, y0 = (LOGO_SIZE - text_w) // 2, (LOGO_SIZE - text_h) // 2
    rows = [bytearray(bytes(LOGO_BG) * LOGO_SIZE) for _ in range(LOGO_SIZE)]
    for gi, glyph in enumerate(letters):
        gx = x0 + gi * 6 * scale
        for ry, line in enumerate(glyph):
            for rx, lit in enumerate(line):
                if lit != "1":
                    continue
                for dy in range(scale):
                    y = y0 + ry * scale + dy
                    row = rows[y]
                    for dx in range(scale):
                        off = (gx + rx * scale + dx) * 3
                        row[off:off + 3] = bytes(LOGO_FG)
    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    return (b"\x89PNG\r\n\x1a\n" +
            _chunk(b"IHDR", struct.pack(">IIBBBBB", LOGO_SIZE, LOGO_SIZE,
                                        8, 2, 0, 0, 0)) +
            _chunk(b"IDAT", zlib.compress(raw, 9)) +
            _chunk(b"IEND", b""))


# ---------------------------------------------------------------------------
# backup
# ---------------------------------------------------------------------------

def backup(db_path, uploads_dir):
    """Archive db + uploads to <db-dir>/backups/pre-reset-*.db and verify it.

    The archive is a zip with db/<name> and uploads/<file> members (the .db
    suffix keeps the existing naming convention).  Returns the archive path.
    Raises RuntimeError when the archive cannot be verified.
    """
    bdir = os.path.join(os.path.dirname(db_path), "backups")
    os.makedirs(bdir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    path = os.path.join(bdir, "pre-reset-%s.db" % stamp)
    n = 2
    while os.path.exists(path):
        path = os.path.join(bdir, "pre-reset-%s-%d.db" % (stamp, n))
        n += 1
    tmp = path + ".tmp"
    try:
        src = sqlite3.connect(db_path, timeout=10)
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst)          # consistent snapshot, WAL-safe
        finally:
            dst.close()
            src.close()
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(tmp, "db/" + os.path.basename(db_path))
            if os.path.isdir(uploads_dir):
                for name in sorted(os.listdir(uploads_dir)):
                    full = os.path.join(uploads_dir, name)
                    if os.path.isfile(full):
                        z.write(full, "uploads/" + name)
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            if bad is not None:
                raise RuntimeError("backup member failed CRC: %s" % bad)
            head = z.read("db/" + os.path.basename(db_path))[:16]
            if head != b"SQLite format 3\x00":
                raise RuntimeError("backup db member is not a SQLite file")
    except Exception:
        for p in (tmp, path):
            try:
                os.remove(p)
            except OSError:
                pass
        raise
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return path


# ---------------------------------------------------------------------------
# state + reset helpers (take the already-imported server/broadcast modules)
# ---------------------------------------------------------------------------

def demo_state(conn):
    """(total rows, rows that do NOT look like demo data, marker set)."""
    total = conn.execute(
        "SELECT COUNT(*) AS c FROM registrations").fetchone()["c"]
    offending = 0
    for r in conn.execute("SELECT cap_email FROM registrations"):
        email = (r["cap_email"] or "").lower()
        if not (email.endswith("@example.com") or email.endswith("@demo.invalid")):
            offending += 1
    row = conn.execute(
        "SELECT value FROM settings WHERE key = 'demo_seed'").fetchone()
    return total, offending, bool(row and row["value"] == "1")


def reset(server, broadcast, scenario):
    """Wipe tournament data, restore defaults, fresh overlay token."""
    last = None
    for attempt in range(4):
        try:
            with server.DB_LOCK:
                conn = server.db()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    broadcast.migrate(conn)
                    logos = [r["logo_path"] for r in conn.execute(
                        "SELECT logo_path FROM registrations "
                        "WHERE logo_path IS NOT NULL")]
                    for table in ("event_log", "player_stats",
                                  "match_team_results", "matches",
                                  "overlay_settings", "change_requests",
                                  "notification_queue", "roster_members",
                                  "registrations", "groups"):
                        conn.execute("DELETE FROM " + table)
                    conn.execute("DELETE FROM settings WHERE key = 'demo_seed'")
                    for key, value in server.DEFAULT_SETTINGS.items():
                        server.set_setting(conn, key, value)
                    server.set_setting(conn, "slot_limit", "32")
                    conn.execute("DELETE FROM scoring_rules")
                    for key, value in broadcast.DEFAULT_SCORING_RULES.items():
                        conn.execute(
                            "INSERT INTO scoring_rules (key, value) VALUES (?, ?)",
                            (key, value))
                    broadcast.reseed_settings(conn)
                    server.audit(conn, "seed", None, "seed_reset",
                                 new="scenario " + scenario)
                    conn.commit()
                finally:
                    conn.close()
            # the tx committed and any backup has captured the files by now
            for lp in logos:
                try:
                    os.remove(os.path.join(server.UPLOAD_DIR,
                                           os.path.basename(lp)))
                except OSError:
                    pass
            return
        except sqlite3.OperationalError as e:
            last = e
            if "locked" not in str(e) or attempt == 3:
                raise
            time.sleep(0.8)
    raise last


# ---------------------------------------------------------------------------
# team specs — validated through the same code the register API uses
# ---------------------------------------------------------------------------

def build_specs(server, scenario):
    """Every team, field-validated + roster-validated like POST /api/register."""
    statuses = SCENARIOS[scenario]
    uids = ("4%08d" % (1 + n * 137) for n in itertools.count())
    specs = []
    for i, (name, tag) in enumerate(TEAMS):
        cap_uid = next(uids)
        roster = [{"slot": "P1", "role": "IGL / Captain",
                   "ign": CAPTAINS[i], "uid": cap_uid}]
        for j in (2, 3, 4):
            k = i * 5 + (j - 1)
            roster.append({"slot": "P%d" % j, "role": "Starter",
                           "ign": "%s_%02d" % (POOL[k % len(POOL)],
                                               (k * 13) % 97 + 1),
                           "uid": next(uids)})
        subs = 2 if i % 4 == 0 else (1 if i % 4 == 2 else 0)
        for s in range(subs):
            k = i * 5 + 4 + s
            roster.append({"slot": "S%d" % (s + 1), "role": "Substitute",
                           "ign": "%s_%02d" % (POOL[k % len(POOL)],
                                               (k * 13) % 97 + 1),
                           "uid": next(uids)})
        members = server.validate_roster(roster)
        data = {
            "teamName": server.v_team_name(name),
            "teamTag": server.v_tag(tag),
            "guildName": server.v_guild("Guild " + tag),
            "capIgn": server.v_ign(CAPTAINS[i], "capIgn"),
            "capUid": server.v_uid(cap_uid, "capUid"),
            "capEmail": server.v_email("team%02d@example.com" % (i + 1)),
            "capPhone": server.v_phone("9%09d" % (700000000 + i * 137)),
            "capDiscord": server.v_discord("animecap%02d" % (i + 1)),
        }
        specs.append({"index": i, "tag": tag, "status": statuses[i],
                      "data": data, "members": members})
    return specs


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def parse_args(argv):
    ap = argparse.ArgumentParser(
        description="Reset + seed the demo database (32 anime-inspired teams).")
    ap.add_argument("--db", help="database path (default: BGMI_DB_PATH / "
                                 "BGMI_DB / data/registrations.db)")
    ap.add_argument("--uploads", help="uploads dir (default: BGMI_UPLOADS or "
                                      "<db-dir>/uploads)")
    ap.add_argument("--reset", action="store_true",
                    help="wipe tournament data even when it does not look "
                         "like demo data (typed RESET unless --yes)")
    ap.add_argument("--yes", action="store_true",
                    help="skip the typed RESET confirmation")
    ap.add_argument("--scenario", choices=sorted(SCENARIOS), default="full",
                    help="full = all 32 approved; mixed = 20 approved + other "
                         "statuses (default: full)")
    ap.add_argument("--with-results", action="store_true",
                    help="also play + publish a Group A opener")
    return ap.parse_args(argv)


def _play_opener(conn, broadcast, group, lineup):
    match = broadcast.create_match(conn, group, "Erangel",
                                   "Group stage opener (played)", "seed")
    broadcast.set_lineup(conn, match["id"], lineup)
    broadcast.start_match(conn, match["id"], "seed")
    kills = [8, 6, 5, 4, 3, 3, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0]
    for idx, tid in enumerate(lineup):
        broadcast.team_kill_delta(conn, match["id"], tid,
                                  kills[idx % len(kills)], "seed")
    for place, tid in enumerate(lineup, 1):
        broadcast.set_placement(conn, match["id"], tid, place, True, "seed")
    broadcast.end_match(conn, match["id"], "seed")
    broadcast.publish_match(conn, match["id"], "seed")
    return match["id"]


def seed(server, broadcast, scenario, with_results=False, uploads_dir=None):
    """Insert the 32-team payload into an already-reset database.

    Validates every team through the register API's own validators, uses the
    normal id/code allocators, and returns the created ids so callers (tests)
    can address the rows.  main() wraps this with the backup + rails.
    """
    if uploads_dir is None:
        uploads_dir = server.UPLOAD_DIR
    specs = build_specs(server, scenario)
    now = datetime.now(timezone.utc)
    team_ids, reg_codes, logo_meta = [], [], []
    for spec in specs:
        tid = server.insert_registration(spec["data"], spec["members"],
                                         "seed", None)
        team_ids.append(tid)
        reg_codes.append(spec["data"].get("regCode", ""))
        logo_meta.append((tid, spec["tag"]))

    os.makedirs(uploads_dir, exist_ok=True)
    logo_paths = []
    for tid, tag in logo_meta:
        fname = "%s.png" % tid
        with open(os.path.join(uploads_dir, fname), "wb") as f:
            f.write(logo_png(tag))
        logo_paths.append((tid, "/uploads/" + fname))

    with server.DB_LOCK:
        conn = server.db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            for (tid, path) in logo_paths:
                conn.execute("UPDATE registrations SET logo_path = ? "
                             "WHERE team_id = ?", (path, tid))
            conn.commit()
        finally:
            conn.close()

    # statuses, groups, demo marker
    approved_ids = [tid for tid, s in zip(team_ids, specs)
                    if s["status"] == "approved"]
    half = len(approved_ids) // 2 if len(approved_ids) < 32 else 16
    group_a, group_b = approved_ids[:half], approved_ids[half:]
    with server.DB_LOCK:
        conn = server.db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            for spec, tid in zip(specs, team_ids):
                created = now - timedelta(minutes=(32 - spec["index"]) * 111)
                if spec["status"] == "pending":
                    decided_at, decided_by = None, None
                else:
                    decided_at = created + timedelta(hours=1)
                    decided_by = "seed"
                conn.execute(
                    "UPDATE registrations SET created_at = ?, status = ?, "
                    "status_note = ?, decided_at = ?, decided_by = ?, "
                    "updated_at = ? WHERE team_id = ?",
                    (created.isoformat(), spec["status"],
                     STATUS_NOTES[spec["status"]],
                     decided_at.isoformat() if decided_at else None,
                     decided_by, (decided_at or created).isoformat(), tid))
            cur = conn.execute(
                "INSERT INTO groups (name, size, locked) VALUES ('Group A', 16, 0)")
            gid_a = cur.lastrowid
            cur = conn.execute(
                "INSERT INTO groups (name, size, locked) VALUES ('Group B', 16, 0)")
            gid_b = cur.lastrowid
            for tid in group_a:
                conn.execute("UPDATE registrations SET group_id = ? "
                             "WHERE team_id = ?", (gid_a, tid))
            for tid in group_b:
                conn.execute("UPDATE registrations SET group_id = ? "
                             "WHERE team_id = ?", (gid_b, tid))
            server.set_setting(conn, "demo_seed", "1")
            conn.commit()
        finally:
            conn.close()

    # schedule: one upcoming match per group (+ optional played opener)
    matches = {}
    with server.DB_LOCK:
        conn = server.db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if with_results:
                matches["opener"] = _play_opener(conn, broadcast, "Group A",
                                                 group_a[:16])
            m_a = broadcast.create_match(conn, "Group A", "Erangel",
                                         "Group stage - scheduled", "seed")
            broadcast.set_lineup(conn, m_a["id"], group_a[:16])
            matches["group_a"] = m_a["id"]
            m_b = broadcast.create_match(conn, "Group B", "Miramar",
                                         "Group stage - scheduled", "seed")
            broadcast.set_lineup(conn, m_b["id"], group_b[:16])
            matches["group_b"] = m_b["id"]
            conn.commit()
        finally:
            conn.close()

    return {"team_ids": team_ids, "approved": approved_ids,
            "group_a": group_a, "group_b": group_b, "matches": matches,
            "reg_codes": reg_codes, "logos": len(logo_paths),
            "scenario": scenario}


def main(argv=None):
    args = parse_args(argv)
    db_path = os.path.abspath(
        args.db or os.environ.get("BGMI_DB_PATH") or
        os.environ.get("BGMI_DB") or
        os.path.join(ROOT, "data", "registrations.db"))
    uploads_dir = os.path.abspath(
        args.uploads or os.environ.get("BGMI_UPLOADS") or
        os.path.join(os.path.dirname(db_path), "uploads"))
    os.environ["BGMI_DB"] = db_path
    os.environ["BGMI_UPLOADS"] = uploads_dir
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    import server
    import broadcast

    existed = os.path.exists(db_path)
    server.init_db()

    total = offending = 0
    conn = server.db()
    try:
        total, offending, marker = demo_state(conn)
    finally:
        conn.close()

    real = total > 0 and offending > 0
    if real and not args.reset:
        print("STOP: %d of %d registrations look like REAL data "
              "(not @example.com / @demo.invalid)." % (offending, total))
        print("Nothing was changed. Review the database, then re-run with "
              "--reset to archive it to backups/ first and re-seed.")
        return 1
    if total > 0 and (real or args.reset) and not args.yes:
        if not sys.stdin.isatty():
            print("Refusing to wipe a database without confirmation in a "
                  "non-interactive shell. Re-run with --yes when you are sure.")
            return 2
        answer = input("This wipes every team and re-seeds demo data. "
                       "Type RESET to continue: ")
        if answer.strip() != "RESET":
            print("Aborted - nothing was changed.")
            return 2

    # validate every team up front: bad data must never cost the database
    try:
        specs = build_specs(server, args.scenario)
    except server.ValidationError as e:
        print("Seed data failed validation: %s" % e.message)
        return 4

    backup_path = None
    if existed and total > 0:
        try:
            backup_path = backup(db_path, uploads_dir)
        except Exception as e:
            print("Backup failed (%s) - nothing was changed." % e)
            return 3
        print("Backup: %s (verified)" % backup_path)

    reset(server, broadcast, args.scenario)
    try:
        info = seed(server, broadcast, args.scenario, args.with_results,
                    uploads_dir)
    except server.ValidationError as e:
        print("Team failed validation: %s" % e.message)
        return 4
    team_ids, reg_codes = info["team_ids"], info["reg_codes"]
    group_a, group_b = info["group_a"], info["group_b"]

    # report
    conn = server.db()
    try:
        def one(sql, *p):
            return conn.execute(sql, p).fetchone()[0]
        approved = one("SELECT COUNT(*) FROM registrations WHERE status = 'approved'")
        roster = one("SELECT COUNT(*) FROM roster_members")
        subs = one("SELECT COUNT(*) FROM roster_members WHERE slot LIKE 'S%'")
        groups = one("SELECT COUNT(*) FROM groups")
        matches = one("SELECT COUNT(*) FROM matches")
        published = one("SELECT COUNT(*) FROM matches WHERE status = 'published'")
    finally:
        conn.close()
    print("Seed complete - scenario '%s'%s."
          % (args.scenario, " + results" if args.with_results else ""))
    print("  DB:      %s" % db_path)
    print("  Backup:  %s" % (backup_path or "none (fresh database)"))
    print("  Teams:   %d (%d approved, %d roster rows incl. %d subs)"
          % (len(team_ids), approved, roster, subs))
    print("  Groups:  %d (Group A %d, Group B %d, unlocked)"
          % (groups, len(group_a), len(group_b)))
    print("  Matches: %d total, %d published, %d upcoming"
          % (matches, published, matches - published))
    print("  Logos:   %d PNG tiles in %s" % (info["logos"], uploads_dir))
    print("  Reg codes: %s .. %s" % (reg_codes[0], reg_codes[-1]))
    print("  DEMO DATA badge is on (settings.demo_seed); purge removes it.")
    print("  Next:    python server.py  (admin login via scripts/create_admin.py)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
