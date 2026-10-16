#!/usr/bin/env python3
"""
Seed tests — backup-first reset, the 32-team payload, scenarios and safety.

Every case runs scripts/seed_demo.py as a subprocess against a private temp
database, so the live dev/demo databases are never touched.

Sections:
  [seed full]   fresh seed: 32 approved anime squads, rosters, logos, groups,
                one scheduled match per group, settings + scoring defaults
  [re-run]      running again wipes + reseeds and archives a verified backup
  [results]     --with-results publishes a Group A opener
  [mixed]       --scenario mixed spreads statuses, groups carry the approved
  [rails]       real-looking data stops a plain run; --reset --yes archives it
                first; reset keeps admins and restores scoring defaults
  [legacy]      @demo.invalid rows are accepted as demo data (legacy marker)
  [env]         BGMI_DB_PATH is honoured

Usage:  python tests/test_seed.py
"""

import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "seed_demo.py")

PASS = 0
FAIL = 0
FAILURES = []


def report(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  PASS  %s" % name)
    else:
        FAIL += 1
        FAILURES.append(name + (" :: " + detail if detail else ""))
        print("  FAIL  %s  %s" % (name, detail))


def run_seed(*args, db=None, uploads=None, env_extra=None, stdin=None):
    env = os.environ.copy()
    for key in ("BGMI_DB", "BGMI_DB_PATH", "BGMI_UPLOADS"):
        env.pop(key, None)
    env["PYTHONIOENCODING"] = "utf-8"
    cmd = [sys.executable, SCRIPT]
    if db:
        cmd += ["--db", db]
    if uploads:
        cmd += ["--uploads", uploads]
    cmd += list(args)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(cmd, capture_output=True, text=True, env=env,
                          cwd=ROOT, input=stdin, timeout=180)


def connect(path):
    c = sqlite3.connect(path, timeout=15)
    c.row_factory = sqlite3.Row
    return c


def scalar(c, sql, *p):
    return c.execute(sql, p).fetchone()[0]


def tail(p):
    text = (p.stdout or "") + (p.stderr or "")
    return text.strip().splitlines()[-1][:160] if text.strip() else "(no output)"


TMP = tempfile.mkdtemp(prefix="bgmi-seed-")
BASE = os.path.join(TMP, "db1")
DB1, UP1 = BASE + ".db", os.path.join(TMP, "up1")
DB2, UP2 = os.path.join(TMP, "db2.db"), os.path.join(TMP, "up2")
DB3, UP3 = os.path.join(TMP, "db3.db"), os.path.join(TMP, "up3")
DB4, UP4 = os.path.join(TMP, "db4.db"), os.path.join(TMP, "up4")
DB5, UP5 = os.path.join(TMP, "db5.db"), os.path.join(TMP, "up5")

try:
    # ------------------------------------------------------------------ full
    print("\n[seed full]")
    p = run_seed(db=DB1, uploads=UP1)
    report("fresh seed exits 0", p.returncode == 0, tail(p))
    c = connect(DB1)
    try:
        total = scalar(c, "SELECT COUNT(*) FROM registrations")
        approved = scalar(c, "SELECT COUNT(*) FROM registrations "
                             "WHERE status = 'approved'")
        report("32 registrations, all approved", total == 32 and approved == 32,
               "%d total / %d approved" % (total, approved))
        report("names / tags / emails / phones all unique",
               all(scalar(c, "SELECT COUNT(DISTINCT %s) FROM registrations" % col) == 32
                   for col in ("team_name", "team_tag", "cap_email", "cap_phone")))
        codes = [r["reg_code"] for r in c.execute(
            "SELECT reg_code FROM registrations ORDER BY reg_code")]
        expected = ["BGMI26-%04d" % n for n in range(1, 33)]
        report("reg codes are the allocator sequence", codes == expected,
               codes[:3] and codes[0] + ".." + codes[-1])
        report("team ids use the normal allocator format",
               scalar(c, "SELECT COUNT(*) FROM registrations "
                         "WHERE team_id LIKE 'CSM-BG-____'") == 32)
        report("demo emails + marker",
               scalar(c, "SELECT COUNT(*) FROM registrations "
                         "WHERE cap_email LIKE '%@example.com'") == 32 and
               scalar(c, "SELECT value FROM settings WHERE key = 'demo_seed'") == "1")
        report("slot limit 32, other settings at defaults",
               scalar(c, "SELECT value FROM settings WHERE key = 'slot_limit'") == "32" and
               scalar(c, "SELECT value FROM settings WHERE key = 'public_teams'") == "0" and
               scalar(c, "SELECT value FROM settings WHERE key = 'schedule_note'") == "")
        rules = {r["key"]: r["value"] for r in c.execute(
            "SELECT key, value FROM scoring_rules")}
        report("scoring rules back at defaults (10,6,5,4,3,2,1,1 / 1)",
               rules.get("kill_points") == "1" and
               rules.get("placement_1") == "10" and rules.get("placement_2") == "6" and
               rules.get("placement_8") == "1" and len(rules) == 10)
        four = scalar(c, "SELECT COUNT(*) FROM (SELECT team_id FROM roster_members "
                         "WHERE slot LIKE 'P%' GROUP BY team_id HAVING COUNT(*) = 4)")
        report("every squad fields 4 starters on P1..P4", four == 32, str(four))
        with_subs = scalar(c, "SELECT COUNT(*) FROM (SELECT team_id FROM roster_members "
                              "WHERE slot LIKE 'S%' GROUP BY team_id)")
        subs = scalar(c, "SELECT COUNT(*) FROM roster_members WHERE slot LIKE 'S%'")
        report("about half the squads carry 1-2 subs",
               with_subs == 16 and 16 <= subs <= 32, "%d squads / %d subs"
               % (with_subs, subs))
        report("roster uids globally unique and well formed",
               scalar(c, "SELECT COUNT(DISTINCT uid) FROM roster_members") ==
               scalar(c, "SELECT COUNT(*) FROM roster_members") and
               scalar(c, "SELECT MIN(LENGTH(uid)) FROM roster_members") >= 6 and
               scalar(c, "SELECT MAX(LENGTH(uid)) FROM roster_members") <= 12)
        report("captain uid matches the P1 roster row",
               scalar(c, "SELECT COUNT(*) FROM registrations r JOIN roster_members m "
                         "ON m.team_id = r.team_id AND m.slot = 'P1' "
                         "AND m.uid = r.cap_uid") == 32)
        groups = [dict(r) for r in c.execute(
            "SELECT name, size, locked FROM groups ORDER BY name")]
        report("Group A + Group B (16, unlocked) exist",
               len(groups) == 2 and groups[0]["name"] == "Group A"
               and groups[0]["size"] == 16 and groups[0]["locked"] == 0
               and groups[1]["name"] == "Group B")
        assigned = scalar(c, "SELECT COUNT(*) FROM registrations "
                             "WHERE status = 'approved' AND group_id IS NOT NULL")
        report("16 + 16 squads assigned", assigned == 32, str(assigned))
        per_group = [r[0] for r in c.execute(
            "SELECT COUNT(*) FROM registrations r JOIN groups g ON g.id = r.group_id "
            "GROUP BY g.name")]
        report("groups split evenly", sorted(per_group) == [16, 16], str(per_group))
        matches = [dict(r) for r in c.execute(
            "SELECT group_name, status FROM matches")]
        report("one scheduled match per group",
               len(matches) == 2 and all(m["status"] == "upcoming" for m in matches)
               and sorted(m["group_name"] for m in matches) == ["Group A", "Group B"],
               str(matches))
        lineups = [r[0] for r in c.execute(
            "SELECT COUNT(*) FROM match_team_results GROUP BY match_id")]
        report("16-squad lineups on both lobbies",
               sorted(lineups) == [16, 16], str(lineups))
    finally:
        c.close()

    logos = [f for f in os.listdir(UP1) if f.endswith(".png")]
    ok_png = True
    for f in logos:
        raw = open(os.path.join(UP1, f), "rb").read()
        if (len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n" or
                raw[12:16] != b"IHDR" or
                struct.unpack(">II", raw[16:24]) != (192, 192)):
            ok_png = False
            break
    report("32 stdlib PNG logo tiles (192x192)", len(logos) == 32 and ok_png,
           "%d files" % len(logos))
    c = connect(DB1)
    try:
        missing = scalar(c, "SELECT COUNT(*) FROM registrations "
                            "WHERE logo_path IS NULL")
        report("every team points at its logo file", missing == 0, str(missing))
    finally:
        c.close()

    # ---------------------------------------------------------------- re-run
    print("\n[re-run]")
    p = run_seed(db=DB1, uploads=UP1)
    report("second run exits 0 (re-runnable)", p.returncode == 0, tail(p))
    c = connect(DB1)
    try:
        report("still exactly 32 approved",
               scalar(c, "SELECT COUNT(*) FROM registrations WHERE status='approved'") == 32)
    finally:
        c.close()
    backs = sorted(f for f in os.listdir(os.path.join(TMP, "backups"))
                   if f.endswith(".db")) if os.path.isdir(os.path.join(TMP, "backups")) else []
    report("one verified backup archived before the wipe", len(backs) == 1, str(backs))
    if backs:
        zp = os.path.join(TMP, "backups", backs[0])
        with zipfile.ZipFile(zp) as z:
            names = z.namelist()
            db_members = [n for n in names if n.startswith("db/")]
            up_members = [n for n in names if n.startswith("uploads/")]
            head = z.read(db_members[0])[:16] if db_members else b""
        report("backup zip holds the DB + uploads",
               len(db_members) == 1 and len(up_members) == 32 and
               head == b"SQLite format 3\x00",
               "%d uploads" % len(up_members))

    # --------------------------------------------------------------- results
    print("\n[results]")
    p = run_seed("--with-results", db=DB2, uploads=UP2)
    report("--with-results exits 0", p.returncode == 0, tail(p))
    c = connect(DB2)
    try:
        statuses = {r["status"]: r["c"] for r in c.execute(
            "SELECT status, COUNT(*) AS c FROM matches GROUP BY status")}
        report("3 matches: opener published + 2 upcoming",
               statuses == {"published": 1, "upcoming": 2}, str(statuses))
        pub = c.execute("SELECT id, group_name FROM matches "
                        "WHERE status = 'published'").fetchone()
        report("opener is Group A", pub and pub["group_name"] == "Group A")
        places = [r[0] for r in c.execute(
            "SELECT placement FROM match_team_results WHERE match_id = ? "
            "ORDER BY placement", (pub["id"],))]
        kills = scalar(c, "SELECT SUM(kills) FROM match_team_results "
                          "WHERE match_id = ?", pub["id"])
        report("opener has placements 1..16 and kills recorded",
               places == list(range(1, 17)) and kills == 37, "%s / %s" % (len(places), kills))
    finally:
        c.close()

    # ----------------------------------------------------------------- mixed
    print("\n[mixed]")
    p = run_seed("--scenario", "mixed", db=DB3, uploads=UP3)
    report("mixed scenario exits 0", p.returncode == 0, tail(p))
    c = connect(DB3)
    try:
        by_status = {r["status"]: r["c"] for r in c.execute(
            "SELECT status, COUNT(*) AS c FROM registrations GROUP BY status")}
        report("20 approved + pending/needs_changes/rejected/waitlisted",
               by_status == {"approved": 20, "pending": 6, "needs_changes": 1,
                             "rejected": 3, "waitlisted": 2}, str(by_status))
        assigned = scalar(c, "SELECT COUNT(*) FROM registrations "
                             "WHERE status = 'approved' AND group_id IS NOT NULL")
        report("approved squads sit in the two groups",
               assigned == 20 and
               scalar(c, "SELECT COUNT(DISTINCT group_id) FROM registrations "
                         "WHERE group_id IS NOT NULL") == 2)
        report("still one scheduled match per group",
               scalar(c, "SELECT COUNT(*) FROM matches WHERE status = 'upcoming'") == 2)
        report("decided rows carry notes, pending does not",
               scalar(c, "SELECT COUNT(*) FROM registrations WHERE status = 'pending' "
                         "AND status_note = ''") == 6 and
               scalar(c, "SELECT COUNT(*) FROM registrations "
                         "WHERE status IN ('needs_changes','rejected','waitlisted') "
                         "AND status_note <> ''") == 6)
    finally:
        c.close()

    # ----------------------------------------------------------------- rails
    print("\n[rails]")
    c = connect(DB3)
    try:
        victim = c.execute("SELECT team_id FROM registrations "
                           "ORDER BY team_id LIMIT 1").fetchone()["team_id"]
        c.execute("UPDATE registrations SET cap_email = 'real@realmail.com' "
                  "WHERE team_id = ?", (victim,))
        c.execute("INSERT INTO admin_users (username, pass_hash, pass_salt, "
                  "created_at) VALUES ('keeper', 'h', 's', '2026-01-01T00:00:00')")
        c.execute("UPDATE scoring_rules SET value = '9' WHERE key = 'kill_points'")
        c.commit()
    finally:
        c.close()
    p = run_seed(db=DB3, uploads=UP3)
    report("real-looking row stops a plain run (exit 1, nothing changed)",
           p.returncode == 1 and
           scalar(connect(DB3), "SELECT COUNT(*) FROM registrations "
                                "WHERE cap_email = 'real@realmail.com'") == 1,
           "rc=%d %s" % (p.returncode, tail(p)))
    p = run_seed("--reset", db=DB3, uploads=UP3, stdin="no\n")
    report("--reset without --yes refuses in a non-interactive shell (exit 2)",
           p.returncode == 2 and
           scalar(connect(DB3), "SELECT COUNT(*) FROM registrations "
                                "WHERE cap_email = 'real@realmail.com'") == 1,
           "rc=%d" % p.returncode)
    p = run_seed("--reset", "--yes", db=DB3, uploads=UP3)
    report("--reset --yes reseeds", p.returncode == 0 and
           scalar(connect(DB3), "SELECT COUNT(*) FROM registrations "
                                "WHERE status = 'approved'") == 32, tail(p))
    c = connect(DB3)
    try:
        report("reset keeps admins", scalar(c, "SELECT COUNT(*) FROM admin_users "
                                               "WHERE username = 'keeper'") == 1)
        report("reset restores scoring defaults",
               scalar(c, "SELECT value FROM scoring_rules WHERE key = 'kill_points'") == "1")
    finally:
        c.close()
    backs = sorted(f for f in os.listdir(os.path.join(TMP, "backups"))
                   if f.endswith(".db"))
    report("the reset run archived the pre-wipe data first", len(backs) == 2,
           str(backs))
    mine = None
    for name in backs:
        with zipfile.ZipFile(os.path.join(TMP, "backups", name)) as z:
            if "db/" + os.path.basename(DB3) in z.namelist():
                mine = os.path.join(TMP, "backups", name)
    if mine:
        with zipfile.ZipFile(mine) as z:
            member = [n for n in z.namelist() if n.startswith("db/")][0]
            blob = z.read(member)
        snap = os.path.join(TMP, "snapshot.db")
        with open(snap, "wb") as f:
            f.write(blob)
        c = connect(snap)
        try:
            kept = scalar(c, "SELECT COUNT(*) FROM registrations "
                             "WHERE cap_email = 'real@realmail.com'")
        finally:
            c.close()
        os.remove(snap)
        report("backup snapshot contains the row the wipe removed", kept == 1)

    # ---------------------------------------------------------------- legacy
    print("\n[legacy]")
    p = run_seed(db=DB4, uploads=UP4)
    c = connect(DB4)
    try:
        c.execute("UPDATE registrations SET cap_email = "
                  "REPLACE(cap_email, '@example.com', '@demo.invalid')")
        c.commit()
    finally:
        c.close()
    p = run_seed(db=DB4, uploads=UP4)
    report("legacy @demo.invalid rows reseed without stopping",
           p.returncode == 0 and
           scalar(connect(DB4), "SELECT COUNT(*) FROM registrations") == 32, tail(p))

    # ------------------------------------------------------------------- env
    print("\n[env]")
    p = run_seed(uploads=UP5, env_extra={"BGMI_DB_PATH": DB5})
    report("BGMI_DB_PATH picks the database", p.returncode == 0 and
           os.path.exists(DB5) and
           scalar(connect(DB5), "SELECT COUNT(*) FROM registrations") == 32,
           tail(p))
finally:
    if FAIL:
        print("\n(temp files kept for inspection: %s)" % TMP)
    else:
        shutil.rmtree(TMP, ignore_errors=True)

print("\n== seed: %d passed, %d failed ==" % (PASS, FAIL))
for line in FAILURES:
    print("  - " + line)
sys.exit(1 if FAIL else 0)
