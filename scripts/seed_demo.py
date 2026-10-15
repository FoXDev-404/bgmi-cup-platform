"""Seed ~20 demo registrations in mixed statuses (for UI testing).

    python scripts/seed_demo.py           # create demo data
    python scripts/seed_demo.py --clean   # remove everything demo

Demo rows are identifiable: team ids CSM-BG-Dxxx, codes BGMI26-9xxx,
emails @demo.invalid. The real Fearless Esports entry is never touched.
"""
import os
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

NAMES = [
    "Pixel Raiders", "Drop Zone Kings", "Loot Goblins", "Blue Zone Bandits",
    "Pan Gang", "Circle Campers", "Spray And Pray", "Headshot Hotel",
    "Pochinki Post", "No Scope Nation", "Bootcamp Bullies", "Air Drop Aces",
    "Prone Patrol", "Grenade Guild", "Miramar Mustangs", "Sanhok Snakes",
    "Vikendi Vikings", "Erangel Elite", "Rozhok Rangers", "School Squad",
]
TAGS = ["PXRA", "DZKG", "LOOT", "BZBN", "PANG", "CIRC", "SPRY", "HSHT",
        "PCHK", "NSCP", "BTBL", "ADAC", "PRNP", "GRNG", "MIRM", "SNHK",
        "VKVN", "EREL", "RZHK", "SCHL"]
STATUSES = (["approved"] * 8 + ["pending"] * 6 + ["rejected"] * 3 +
            ["waitlisted"] * 2 + ["needs_changes"])
NOTES = {
    "rejected": "Duplicate roster — two players already on another squad.",
    "needs_changes": "Captain UID looks mistyped (7 digits). Fix and resubmit.",
    "waitlisted": "Bracket full for now — you're first in line if a slot opens.",
    "approved": "You're in. Group and schedule on your status page.",
    "pending": "",
}
ROLES = ["IGL / Captain", "Starter", "Starter", "Starter"]
FIRST = ["RAVI", "ARJUN", "KABIR", "DEV", "VIKRAM", "SAM", "ROHAN", "KARAN",
         "AMIR", "NEEL", "ZAYN", "OM", "IVA", "THEJ", "VIHAAN"]
LAST = ["OP", "YT", "X", "GG", "47", "777", "999", "PRO", "BOSS", "SR"]


def uid(n):
    return str(900000000 + n * 137)


def ign(n):
    return "%s%s%s" % (FIRST[n % len(FIRST)], random.choice(LAST), n % 100)


def main(clean=None):
    if clean is None:
        clean = "--clean" in sys.argv
    # idempotent — works on a brand-new DB too (no manual init needed)
    server.init_db()
    now = datetime.now(timezone.utc)
    with server.DB_LOCK:
        conn = server.db()
        try:
            if clean:
                n = conn.execute(
                    "SELECT COUNT(*) AS c FROM registrations "
                    "WHERE reg_code LIKE 'BGMI26-9%'").fetchone()["c"]
                conn.execute("DELETE FROM change_requests WHERE team_id IN "
                             "(SELECT team_id FROM registrations "
                             "WHERE reg_code LIKE 'BGMI26-9%')")
                conn.execute("DELETE FROM roster_members WHERE team_id IN "
                             "(SELECT team_id FROM registrations "
                             "WHERE reg_code LIKE 'BGMI26-9%')")
                # demo broadcast rows: match stats first, then matches
                # (only matches seeded here — identified by demo notes)
                import broadcast
                broadcast.migrate(conn)
                conn.execute("DELETE FROM player_stats WHERE match_id IN "
                             "(SELECT id FROM matches "
                             "WHERE notes LIKE 'Demo match%')")
                conn.execute("DELETE FROM match_team_results WHERE match_id IN "
                             "(SELECT id FROM matches "
                             "WHERE notes LIKE 'Demo match%')")
                conn.execute("DELETE FROM event_log WHERE match_id IN "
                             "(SELECT id FROM matches "
                             "WHERE notes LIKE 'Demo match%')")
                conn.execute("DELETE FROM matches "
                             "WHERE notes LIKE 'Demo match%'")
                conn.execute("DELETE FROM registrations "
                             "WHERE reg_code LIKE 'BGMI26-9%'")
                conn.execute("DELETE FROM groups WHERE name IN "
                             "('Group A','Group B','Group C','Group D')")
                conn.commit()
                print("Removed %d demo registrations, demo groups and "
                      "demo matches." % n)
                return 0

            existing = conn.execute(
                "SELECT COUNT(*) AS c FROM registrations "
                "WHERE reg_code LIKE 'BGMI26-9%'").fetchone()["c"]
            if existing:
                print("Demo data already present (%d rows). "
                      "Run with --clean first." % existing)
                return 1

            random.seed(26)
            group_ids = []
            for i, size in enumerate((4, 4, 4)):
                name = "Group " + "ABC"[i]
                cur = conn.execute("INSERT INTO groups (name, size) VALUES (?,?)",
                                   (name, size))
                group_ids.append(cur.lastrowid)

            approved_left = 8
            for i in range(20):
                tid = "CSM-BG-D%03d" % (i + 1)
                code = "BGMI26-%d" % (9001 + i)
                status = STATUSES[i]
                created = (now - timedelta(days=20 - i // 2,
                                           hours=i)).isoformat()
                # demo conflict: teams 3 and 4 share a captain phone
                phone = "9811122%03d" % (200 if i in (3, 4) else i)
                email = "cap%d@demo.invalid" % i
                logo = None
                conn.execute(
                    """INSERT INTO registrations
                       (team_id, team_name, team_tag, guild_name, logo_path,
                        cap_ign, cap_uid, cap_email, cap_phone, cap_discord,
                        ip, created_at, reg_code, status, status_note,
                        decided_at, decided_by, updated_at, schedule_note,
                        group_id, admin_note)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (tid, NAMES[i], TAGS[i], "Guild %s" % TAGS[i][:3], logo,
                     ign(i), uid(i), email, phone, "@democap%d" % i,
                     "127.0.0.1", created, code, status, NOTES[status],
                     created if status != "pending" else None,
                     "seed" if status != "pending" else None, created,
                     "" if status != "approved" else
                     ("Erangel 4PM IST" if i % 2 else ""),
                     (group_ids[i // 4] if status == "approved"
                      and approved_left > 0 else None),
                     ""))
                if status == "approved" and approved_left > 0:
                    approved_left -= 1
                members = [(tid, "P%d" % (j + 1), ROLES[j], ign(i * 4 + j),
                            uid(i * 4 + j + 100)) for j in range(4)]
                if i % 3 == 0:
                    members.append((tid, "S1", "Substitute", ign(i * 7 + 3),
                                    uid(i * 7 + 900)))
                conn.executemany(
                    "INSERT INTO roster_members (team_id, slot, role, ign, uid) "
                    "VALUES (?,?,?,?,?)", members)

            # a pending team with an open change request (queue badge demo)
            pend = conn.execute(
                "SELECT team_id FROM registrations "
                "WHERE reg_code = 'BGMI26-9012'").fetchone()
            if pend:
                conn.execute(
                    "INSERT INTO change_requests (team_id, message, created_at) "
                    "VALUES (?,?,?)",
                    (pend["team_id"], "Demo request: our P3 IGN changed to "
                                      "NEWIGN. UID is the same.",
                     now.isoformat()))

            # ---- broadcast section: 2 demo matches + overlay settings ----
            import broadcast
            broadcast.migrate(conn)
            broadcast.set_bsetting(conn, "sponsor_text",
                                   "Presented by Demo Studios")
            broadcast.set_bsetting(conn, "theme_color", "#b6ff3e")
            groups = [r["name"] for r in conn.execute(
                "SELECT name FROM groups ORDER BY name")]
            approved = [r["team_id"] for r in conn.execute(
                "SELECT team_id FROM registrations "
                "WHERE status = 'approved' AND group_id IS NOT NULL "
                "ORDER BY team_id")]
            if len(groups) >= 2 and len(approved) >= 8:
                g_a = groups[0]
                lineup_a = [t for t in approved if
                            conn.execute("SELECT g.name AS n FROM registrations "
                                         "r LEFT JOIN groups g ON g.id = "
                                         "r.group_id WHERE r.team_id = ?",
                                         (t,)).fetchone()["n"] == g_a][:4]
                if len(lineup_a) >= 2:
                    # Match 1: finished + published (counts in standings)
                    m1 = broadcast.create_match(conn, g_a, "Erangel",
                                                "Demo match one", "seed")
                    broadcast.set_lineup(conn, m1["id"], lineup_a)
                    broadcast.start_match(conn, m1["id"], "seed")
                    kills = (5, 3, 1, 0)
                    for tid, k in zip(lineup_a, kills):
                        broadcast.team_kill_delta(conn, m1["id"], tid, k, "seed")
                        rows = conn.execute(
                            "SELECT id FROM player_stats WHERE match_id = ? "
                            "AND team_id = ? ORDER BY id", (m1["id"], tid)).fetchall()
                        for i, p in enumerate(rows):
                            if i < k:      # spread kills over the roster
                                broadcast.player_action(conn, m1["id"], tid, p["id"],
                                                        "kill", 1, "seed")
                    for place, tid in enumerate(lineup_a, 1):
                        broadcast.set_placement(conn, m1["id"], tid, place,
                                                True, "seed")
                    broadcast.end_match(conn, m1["id"], "seed")
                    broadcast.publish_match(conn, m1["id"], "seed")

                # Match 2: still live on the desk (drives /live + overlays)
                g_b = groups[1] if len(groups) > 1 else g_a
                lineup_b = [t for t in approved if t not in lineup_a][:4]
                if len(lineup_b) >= 2:
                    m2 = broadcast.create_match(conn, g_b, "Miramar",
                                                "Demo match two", "seed")
                    broadcast.set_lineup(conn, m2["id"], lineup_b)
                    broadcast.start_match(conn, m2["id"], "seed")
                    broadcast.team_kill_delta(conn, m2["id"], lineup_b[0], 2, "seed")

            conn.commit()
            print("Seeded 20 demo registrations (BGMI26-9001..9020), "
                  "3 groups, 8 approved, demo matches + overlay settings.")
            return 0
        finally:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
