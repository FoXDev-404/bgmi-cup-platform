#!/usr/bin/env python3
"""
FLOW sidebar tests — status logic, endpoint gate, privacy, purge marker.

Sections:
  [status]   flow.compute() against hand-built database snapshots (each step's
             state and counts across the lifecycle: empty, pending, duplicates,
             groups, matches, check-in, live, ended, published)
  [endpoint] GET /api/admin/flow-status: 401 logged out, payload shape,
             demo flag, and no PII (emails / phones / UIDs / team names)
  [purge]    the DEMO DATA marker dies with the data a purge removes

Usage:  python tests/test_flow.py                (self-hosted: temp DB on a free port)
        BASE=http://127.0.0.1:8090 python tests/test_flow.py
"""

import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import test_api as T          # noqa: E402  (sets the temp DB env before any import)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import broadcast              # noqa: E402
import flow                   # noqa: E402

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


def dbc():
    c = sqlite3.connect(T.DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    return c


def reset(c):
    """Empty every tournament table; keep settings and overlay defaults."""
    for t in ("event_log", "player_stats", "match_team_results", "matches",
              "change_requests", "notification_queue", "roster_members",
              "registrations", "groups", "audit_log"):
        c.execute("DELETE FROM %s" % t)
    c.execute("UPDATE settings SET value = '16' WHERE key = 'slot_limit'")
    c.execute("UPDATE settings SET value = '0' WHERE key = 'groups_locked'")
    c.execute("UPDATE settings SET value = '' WHERE key = 'schedule_note'")
    c.execute("DELETE FROM settings WHERE key = 'demo_seed'")
    broadcast.set_bsetting(c, "disabled", "[]")
    c.commit()


_seq = [0]


def team(c, status="approved", group=None, phone=None, name=None, tag=None,
         uid=None, email=None):
    """Insert one registration + its captain roster row (direct SQL)."""
    _seq[0] += 1
    n = _seq[0]
    tid = "TST-%04d" % n
    name = name or ("Flow Squad %03d" % n)
    tag = tag or ("FL%02d" % n)
    phone = phone or ("90000000%02d" % n)
    uid = uid or ("70000000%02d" % n)
    email = email or ("flow%03d@example.com" % n)
    c.execute(
        "INSERT INTO registrations (team_id, team_name, team_tag, guild_name, "
        "cap_ign, cap_uid, cap_email, cap_phone, ip, created_at, status) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (tid, name, tag, "Guild " + tag, name + " Cap", uid, email, phone,
         "127.0.0.1", "2026-01-01T00:00:00+00:00", status))
    c.execute(
        "INSERT INTO roster_members (team_id, slot, role, ign, uid) "
        "VALUES (?,?,?,?,?)", (tid, "P1", "IGL", name + " Cap", uid))
    if group is not None:
        c.execute("UPDATE registrations SET group_id = ? WHERE team_id = ?",
                  (group, tid))
    return tid


def group(c, name):
    c.execute("INSERT INTO groups (name, size, locked) VALUES (?, 16, 0)",
              (name,))
    return c.execute("SELECT id FROM groups WHERE name = ?",
                     (name,)).fetchone()["id"]


def match(c, group_name, map_name="Erangel"):
    m = broadcast.create_match(c, group_name, map_name)
    c.commit()
    return m


def set_note(c, text):
    c.execute("UPDATE settings SET value = ? WHERE key = 'schedule_note'",
              (text,))
    c.commit()


def main():
    T.ensure_server()
    print("== BGMI FLOW sidebar tests @ %s ==" % T.BASE)
    c = dbc()

    # ---------- empty database ----------
    print("\n[status: empty database]")
    reset(c)
    s = flow.compute(c)
    st = s["steps"]
    report("empty: review done (nothing pending)", st["review"]["done"])
    report("empty: decide is current", s["current"] == "decide")
    report("empty: groups blocked", st["groups"]["blocked"] == "Approve teams first")
    report("empty: matches blocked", st["matches"]["blocked"] == "Create groups first")
    report("empty: check-in blocked", st["checkin"]["blocked"] == "Create matches first")
    report("empty: start blocked", st["start"]["blocked"] == "Create matches first")
    report("empty: score blocked", st["score"]["blocked"] == "Start a match first")
    report("empty: publish blocked",
           st["publish"]["blocked"] == "No match awaiting verification")
    report("empty: no live match", s["live"] is None and s["next_match"] is None)
    report("empty: 16 steps, announce hidden",
           len(st) == 16 and s["hidden"] == ["announce"] and
           all(k not in st for k in ("announce",)))

    # ---------- pending registrations ----------
    print("\n[status: pending registrations]")
    reset(c)
    for _ in range(3):
        team(c, status="pending")
    c.commit()
    s = flow.compute(c)
    report("pending: review counts 3", s["steps"]["review"]["counts"]["pending"] == 3)
    report("pending: review not done", not s["steps"]["review"]["done"])
    report("pending: current = review", s["current"] == "review")
    report("pending: decide not done", not s["steps"]["decide"]["done"])

    # ---------- duplicates + corrections ----------
    print("\n[status: duplicates and corrections]")
    reset(c)
    a = team(c, phone="9111111111")
    team(c, phone="9111111111")
    team(c, status="needs_changes")
    c.execute("INSERT INTO change_requests (team_id, message, created_at, seen) "
              "VALUES (?,?,?,0)", (a, "fix the tag", "2026-01-01T00:00:00+00:00"))
    c.commit()
    s = flow.compute(c)
    report("dupes: two teams flagged",
           s["steps"]["decide"]["counts"]["dupe_warnings"] == 2)
    report("dupes: decide attention", s["steps"]["decide"]["attention"] is True)
    report("needs_changes counted",
           s["steps"]["decide"]["counts"]["needs_changes"] == 1)
    report("review attention on open request",
           s["steps"]["review"]["attention"] is True)
    report("dupes: current = decide", s["current"] == "decide")

    # ---------- groups / assign / matches ----------
    print("\n[status: groups, assignments, matches]")
    reset(c)
    t1 = team(c)
    t2 = team(c)
    t3 = team(c)
    s = flow.compute(c)
    report("groups: decide done", s["steps"]["decide"]["done"])
    report("groups: current = groups", s["current"] == "groups")
    report("groups: assign blocked",
           s["steps"]["assign"]["blocked"] == "Create groups first")
    ga = group(c, "Group A")
    gb = group(c, "Group B")
    c.execute("UPDATE registrations SET group_id = ? WHERE team_id = ?", (ga, t1))
    c.execute("UPDATE registrations SET group_id = ? WHERE team_id = ?", (ga, t2))
    c.execute("UPDATE registrations SET group_id = ? WHERE team_id = ?", (gb, t3))
    c.commit()
    s = flow.compute(c)
    report("groups: counted", s["steps"]["groups"]["counts"]["groups"] == 2)
    report("groups: assign done 3/3",
           s["steps"]["assign"]["done"] and
           s["steps"]["assign"]["counts"]["assigned"] == 3)
    report("groups: locked flag", s["steps"]["assign"]["counts"]["locked"] is False)
    m1 = match(c, "Group A", "Erangel")
    m2 = match(c, "Group B", "Miramar")
    s = flow.compute(c)
    report("matches: done, 2 scheduled",
           s["steps"]["matches"]["done"] and
           s["steps"]["matches"]["counts"]["scheduled"] == 2)
    report("matches: check-in current", s["current"] == "checkin")
    report("check-in: 0 of 2 for match 1",
           s["next_match"]["n"] == 1 and s["next_match"]["checked"] == 0 and
           s["next_match"]["size"] == 2)
    set_note(c, "Rooms in the #schedule channel")
    s = flow.compute(c)
    report("room: released flag",
           s["steps"]["room"]["done"] and
           s["steps"]["room"]["counts"]["released"] is True)

    # ---------- live match ----------
    print("\n[status: live match]")
    broadcast.set_lineup(c, m1["id"], [t1, t2])
    c.commit()
    s = flow.compute(c)
    report("check-in: 2 of 2 done", s["steps"]["checkin"]["done"])
    report("start: unblocked once 2 squads check in",
           s["steps"]["start"]["blocked"] is None)
    report("start: current = start", s["current"] == "start")
    broadcast.start_match(c, m1["id"])
    c.commit()
    s = flow.compute(c)
    report("live: score is current", s["current"] == "score")
    report("live: chip payload (match 1, 2 in lobby)",
           s["live"] and s["live"]["n"] == 1 and s["live"]["checked"] == 2)
    report("live: start now points at match 2 (waiting on check-in)",
           s["steps"]["start"]["counts"]["match"] == 2 and
           not s["steps"]["start"]["done"] and
           s["steps"]["start"]["blocked"] is not None)
    report("live: score not done", not s["steps"]["score"]["done"])
    report("live: check-in reopens for match 2",
           not s["steps"]["checkin"]["done"] and
           s["steps"]["checkin"]["counts"]["match"] == 2)

    # ---------- end + verify + publish ----------
    print("\n[status: ended, verify, publish]")
    broadcast.end_match(c, m1["id"])
    c.commit()
    c.execute("UPDATE match_team_results SET placement = 1 "
              "WHERE match_id = ? AND team_id = ?", (m1["id"], t1))
    c.execute("UPDATE match_team_results SET placement = 2 "
              "WHERE match_id = ? AND team_id = ?", (m1["id"], t2))
    c.commit()
    s = flow.compute(c)
    report("ended: publish current", s["current"] == "publish")
    report("ended: no publish problem",
           s["steps"]["publish"]["counts"]["problem"] is None)
    report("ended: score done", s["steps"]["score"]["done"])
    report("ended: awaiting list has match 1",
           [x["n"] for x in s["steps"]["publish"]["counts"]["awaiting"]] == [1])
    # break a placement -> attention + reason
    c.execute("UPDATE match_team_results SET placement = NULL "
              "WHERE match_id = ? AND team_id = ?", (m1["id"], t2))
    c.commit()
    s = flow.compute(c)
    report("placement gap: attention",
           s["steps"]["publish"]["attention"] is True)
    report("placement gap: problem text",
           isinstance(s["steps"]["publish"]["counts"]["problem"], str))
    c.execute("UPDATE match_team_results SET placement = 2 "
              "WHERE match_id = ? AND team_id = ?", (m1["id"], t2))
    c.commit()
    broadcast.publish_match(c, m1["id"])
    c.commit()
    s = flow.compute(c)
    report("published: publish done", s["steps"]["publish"]["done"])
    report("published: results done", s["steps"]["results"]["done"])
    report("published: current = check-in (match 2 still pending)",
           s["current"] == "checkin")
    c.execute("DELETE FROM match_team_results WHERE match_id = ?", (m2["id"],))
    c.execute("DELETE FROM matches WHERE id = ?", (m2["id"],))
    c.commit()
    s = flow.compute(c)
    report("all done: no current step", s["current"] is None)
    report("all done: results counted",
           s["steps"]["results"]["counts"]["published"] == 1)

    # ---------- lobby cap + slot limit attention ----------
    print("\n[status: lobby cap and slot limit]")
    reset(c)
    ts = [team(c) for _ in range(17)]
    ga = group(c, "Group A")
    for t in ts:
        c.execute("UPDATE registrations SET group_id = ? WHERE team_id = ?",
                  (ga, t))
    c.commit()
    match(c, "Group A")
    s = flow.compute(c)
    report("lobby size capped at 16", s["next_match"]["size"] == 16)
    c.execute("UPDATE settings SET value = '10' WHERE key = 'slot_limit'")
    c.commit()
    s = flow.compute(c)
    report("over slot limit: decide attention",
           s["steps"]["decide"]["attention"] is True)
    report("over slot limit: approved counted",
           s["steps"]["decide"]["counts"]["approved"] == 17)

    # ---------- overlays ----------
    print("\n[status: overlays]")
    names = list(broadcast.OVERLAY_NAMES)
    broadcast.set_bsetting(c, "disabled", json.dumps(names))
    c.commit()
    s = flow.compute(c)
    report("all overlays disabled: step not done",
           not s["steps"]["overlays"]["done"])
    report("all overlays disabled: current = overlays", s["current"] == "overlays")
    broadcast.set_bsetting(c, "disabled", json.dumps(names[:1]))
    c.commit()
    s = flow.compute(c)
    report("enabled count excludes disabled",
           s["steps"]["overlays"]["counts"]["enabled"] == len(names) - 1)
    broadcast.set_bsetting(c, "disabled", "[]")
    c.commit()

    # ---------- demo marker ----------
    print("\n[status: demo marker]")
    c.execute("INSERT INTO settings (key, value) VALUES ('demo_seed', '1') "
              "ON CONFLICT(key) DO UPDATE SET value = '1'")
    c.commit()
    report("demo flag set", flow.compute(c)["demo"] is True)
    c.execute("DELETE FROM settings WHERE key = 'demo_seed'")
    c.commit()
    report("demo flag cleared", flow.compute(c)["demo"] is False)

    # ---------- endpoint ----------
    print("\n[endpoint: session gate]")
    st, _ = T.http("GET", "/api/admin/flow-status")
    report("401 when logged out", st == 401)
    T.admin_login()
    st, data = T.jhttp("GET", "/api/admin/flow-status", headers=T.ah())
    report("200 with an admin session",
           st == 200 and data.get("ok") is True)
    report("payload: 16 steps", len(data.get("steps", {})) == 16)
    report("payload: 4 phases", len(data.get("phases", [])) == 4)
    report("payload: announce hidden", data.get("hidden") == ["announce"])
    report("payload: every step carries the state fields",
           all({"done", "attention", "blocked", "current", "counts"} <=
               set(x.keys()) for x in data["steps"].values()))
    report("payload: at most one current step",
           sum(1 for x in data["steps"].values() if x["current"]) <= 1)

    print("\n[endpoint: privacy]")
    reset(c)
    canary_uid = "9988776655"
    team(c, name="Canary Squad", tag="CNRY", phone="9876500099",
         uid=canary_uid, email="canary@example.com")
    c.commit()
    st, raw = T.http("GET", "/api/admin/flow-status", headers=T.ah())
    body = raw.decode("utf-8", "replace")
    report("no email in payload", "canary@example.com" not in body)
    report("no phone in payload", "9876500099" not in body)
    report("no UID in payload", canary_uid not in body)
    report("no team name in payload", "Canary Squad" not in body)
    report("no PII field names in payload",
           "cap_email" not in body and "cap_phone" not in body)

    print("\n[endpoint: demo flag]")
    c.execute("INSERT INTO settings (key, value) VALUES ('demo_seed', '1') "
              "ON CONFLICT(key) DO UPDATE SET value = '1'")
    c.commit()
    st, data = T.jhttp("GET", "/api/admin/flow-status", headers=T.ah())
    report("demo flag true over HTTP", data.get("demo") is True)

    # ---------- purge clears the marker ----------
    print("\n[purge]")
    st, data = T.jhttp("POST", "/api/admin/purge",
                       raw=json.dumps({"confirm": "PURGE"}).encode(),
                       ctype="application/json", headers=T.ah())
    report("purge accepted", st == 200 and data.get("ok") is True)
    row = c.execute("SELECT value FROM settings WHERE key = 'demo_seed'").fetchone()
    report("marker cleared by purge", row is None)
    st, data = T.jhttp("GET", "/api/admin/flow-status", headers=T.ah())
    report("after purge: demo false", data.get("demo") is False)
    report("after purge: decide current",
           data.get("ok") is True and data.get("current") == "decide")

    # ---------- summary ----------
    c.close()
    T.drop_fixture()
    print("\n%d passed, %d failed" % (PASS, FAIL))
    if FAILURES:
        print("\nFailures:")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)


if __name__ == "__main__":
    main()
