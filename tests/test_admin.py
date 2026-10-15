#!/usr/bin/env python3
"""
Approval-workflow tests for the BGMI Cup registration server.

Covers: public /status + privacy, the full admin lifecycle (login, queue,
edit + audit, status actions, slot limit, groups, exports, purge guard) and
teardown that leaves the database exactly as it found it.

Usage:  python tests/test_admin.py            (self-hosted: temp DB/uploads on a free port)
        BASE=http://127.0.0.1:8090 python tests/test_admin.py

Reuses the admin fixture helpers from test_api.py (throwaway account,
deleted at the end — no default credentials anywhere).
"""

import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import test_api as T          # noqa: E402  (shared HTTP + fixture helpers)
import scripts.seed_demo as seed_demo   # noqa: E402

sys.path.insert(0, os.path.join(T.ROOT, "scripts"))

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


def j(method, path, body=None, headers=None):
    return T.jhttp(method, path, headers=headers,
                   raw=None if body is None else json.dumps(body).encode(),
                   ctype="application/json")


def lookup(code, hint):
    """One public /status lookup (rate limit: 5/min — budgeted in main)."""
    return j("POST", "/api/status/lookup", {"regCode": code, "hint": hint})


def main():
    T.ensure_server()          # isolated temp DB + throwaway server (or BASE)
    print("== BGMI approval-workflow tests @ %s ==" % T.BASE)

    # drop leftovers from any crashed run BEFORE capturing the baseline
    seed_demo.main(clean=True)
    baseline_teams = T.jhttp("GET", "/api/health")[1].get("count", -1)

    # ---------- pages ----------
    print("\n[public pages]")
    st, b = T.http("GET", "/status")
    report("GET /status serves the page", st == 200 and b"lookupForm" in b)
    st, b = T.http("GET", "/teams")
    report("GET /teams serves the page", st == 200 and b"tmGrid" in b)
    st, data = T.jhttp("GET", "/api/public/approved")
    report("public feed hidden while disabled", st == 404)

    # ---------- seed demo data (direct SQL, no HTTP) ----------
    print("\n[seed]")
    rc = seed_demo.main(clean=False)
    report("demo data seeded", rc == 0)
    st, b = T.jhttp("GET", "/api/health")
    report("health reflects seeded count", b.get("count", -1) - baseline_teams == 20,
           "count=%s baseline=%s" % (b.get("count"), baseline_teams))

    # ---------- register one fresh team (rate budget: 1 call) ----------
    print("\n[register -> pending]")
    p = T.squad()
    st, data = T.post_reg(p)
    ok = st in (200, 201) and data.get("status") == "pending"
    report("new registration is pending", ok, "status=%s body=%s" % (st, data))
    tid = data.get("teamId", "")
    code = data.get("regCode", "")
    report("reg code BGMI26-NNNN", code.startswith("BGMI26-") and code[7:].isdigit(),
           code)
    report("reg code echoed in response", bool(code))
    T.CREATED.append(tid)           # belt & braces — suite also deletes below

    # ---------- public status lookup (budget: 5/min then 429) ----------
    print("\n[status lookup]")
    st, d = lookup(code, p["capPhone"])
    report("correct phone finds the team",
           st == 200 and d.get("found") and d.get("status") == "pending",
           "status=%s body=%s" % (st, d))
    report("lookup shows team name + label",
           d.get("teamName") == p["teamName"] and d.get("statusLabel") == "Pending review")
    st, d = lookup(code, "9800000000")
    wrong_phone_err = d.get("error", "")
    report("wrong phone -> generic miss",
           st == 404 and d.get("found") is False and wrong_phone_err,
           "status=%s" % st)
    st, d = lookup("BGMI26-9999", p["capPhone"])
    report("wrong code -> same generic miss",
           st == 404 and d.get("found") is False and d.get("error") == wrong_phone_err,
           "status=%s" % st)
    st, d = lookup(code, p["capEmail"])
    report("correct email finds the team",
           st == 200 and d.get("found"), "status=%s" % st)

    st, d = j("POST", "/api/status/request-change",
              {"regCode": code, "hint": p["capPhone"],
               "message": "Our P3 IGN changed to NEWIGN, UID unchanged."})
    report("request-change accepted", st == 200 and d.get("ok"), "status=%s" % st)

    st, d = lookup(code, p["capPhone"])
    report("6th lookup in a minute -> 429", st == 429, "status=%s" % st)
    print("  .. waiting 61s for the public lookup bucket to refill ..")
    time.sleep(61)

    # ---------- admin gate ----------
    print("\n[admin gate]")
    st, b = T.http("GET", "/admin")
    report("logged out: /admin shows login", st == 200 and b"loginForm" in b)
    st, d = j("GET", "/api/admin/registrations")
    report("queue without session -> 401", st == 401, "status=%s" % st)
    st, d = j("GET", "/api/admin/audit")
    report("audit without session -> 401", st == 401, "status=%s" % st)
    st, d = j("GET", "/api/admin/export/approved.csv")
    report("export without session -> 401", st == 401, "status=%s" % st)

    user, pw, _ = T.ensure_admin()
    st, body, _ = T.http_h(
        "POST", "/api/admin/login",
        raw=json.dumps({"username": user, "password": "wrong-pass-xyz"}).encode(),
        ctype="application/json")
    report("wrong password -> 401", st == 401, "status=%s" % st)
    st, d = T.admin_login()
    report("login ok", st == 200 and d.get("ok") and bool(T.SESS_CSRF))

    # ---------- queue ----------
    print("\n[queue]")
    st, d = j("GET", "/api/admin/registrations", headers=T.ah())
    report("queue loads with session", st == 200 and
           len(d["registrations"]) == baseline_teams + 21,
           "n=%s" % len(d.get("registrations", [])))
    counts = d.get("counts", {})
    report("counts per status present",
           set(counts) >= {"pending", "approved", "rejected", "waitlisted", "needs_changes"})
    report("slot limit reported", d.get("slot_limit") == 16, str(d.get("slot_limit")))
    ours = [r for r in d["registrations"] if r["team_id"] == tid]
    report("our team visible + pending",
           ours and ours[0]["status"] == "pending")
    report("request-change badge shows on our team",
           ours and ours[0].get("open_requests") == 1,
           str(ours[0].get("open_requests") if ours else None))
    conflicts = d.get("conflicts", {})
    report("duplicate phone pair flagged",
           any(c.get("phone") for c in conflicts.values()),
           str(list(conflicts.items())[:2]))

    st, d2 = j("GET", "/api/admin/registrations?q=%s" % p["teamTag"],
               headers=T.ah())
    report("search narrows to our team",
           st == 200 and [r["team_id"] for r in d2["registrations"]] == [tid],
           str([r["team_id"] for r in d2.get("registrations", [])]))
    st, d3 = j("GET", "/api/admin/registrations?status=pending", headers=T.ah())
    report("status filter returns only pending",
           st == 200 and all(r["status"] == "pending" for r in d3["registrations"])
           and len(d3["registrations"]) < 21)
    st, d4 = j("GET", "/api/admin/registrations?sort=name", headers=T.ah())
    names = [r["team_name"].lower() for r in d4.get("registrations", [])]
    report("sort by name works", st == 200 and names == sorted(names))

    # ---------- edit + audit ----------
    print("\n[edit + audit]")
    st, d = j("PUT", "/api/admin/registrations/" + tid,
              {"capUid": "12"}, headers=T.ah())
    report("short uid edit rejected", st == 400 and d.get("field") == "capUid",
           "status=%s body=%s" % (st, d))
    st, d = j("PUT", "/api/admin/registrations/" + tid,
              {"teamTag": "PXRA"}, headers=T.ah())
    report("duplicate tag edit rejected", st in (400, 409),
           "status=%s body=%s" % (st, d))
    st, d = j("PUT", "/api/admin/registrations/" + tid,
              {"roster": [{"slot": "P1", "role": "IGL / Captain",
                           "ign": p["capIgn"], "uid": "11111111"},
                          {"slot": "P2", "role": "Starter", "ign": "DupGuy",
                           "uid": "22222222"},
                          {"slot": "P3", "role": "Starter", "ign": "DupGuy",
                           "uid": "22222222"},
                          {"slot": "P4", "role": "Starter", "ign": "Solo",
                           "uid": "33333333"}]},
              headers=T.ah())
    report("roster with duplicate uid rejected", st == 400,
           "status=%s body=%s" % (st, d))

    new_name = "Audit Probe " + T.rnd(3)
    st, d = j("PUT", "/api/admin/registrations/" + tid,
              {"teamName": new_name, "capEmail": "moved@demo.invalid"},
              headers=T.ah())
    report("valid edit saves", st == 200 and d["registration"]["team_name"] == new_name,
           "status=%s" % st)
    st, ad = j("GET", "/api/admin/audit?teamId=" + tid, headers=T.ah())
    rows = ad.get("audit", [])
    name_rows = [a for a in rows if a.get("field") == "team_name"]
    report("audit logs the rename old->new",
           name_rows and name_rows[0]["old_value"] == p["teamName"]
           and name_rows[0]["new_value"] == new_name
           and name_rows[0]["admin"] == user)
    email_rows = [a for a in rows if a.get("field") == "cap_email"]
    report("audit masks PII values",
           email_rows and email_rows[0]["new_value"] == "(changed)"
           and "moved@demo.invalid" not in json.dumps(rows),
           str(email_rows[:1]))

    # ---------- status actions ----------
    print("\n[status actions + slot limit]")
    st, d = j("POST", "/api/admin/registrations/%s/status" % tid,
              {"status": "approved", "note": "Slot confirmed - group posted"},
              headers=T.ah())
    report("approve works", st == 200 and d["registration"]["status"] == "approved",
           "status=%s body=%s" % (st, d))
    report("decided_by recorded", d["registration"].get("decided_by") == user)
    report("status note stored",
           d["registration"].get("status_note") == "Slot confirmed - group posted")

    # pending demo team id (seed order: 8 approved then pending)
    st, d = j("GET", "/api/admin/registrations?status=pending", headers=T.ah())
    pend = [r["team_id"] for r in d["registrations"] if r["team_id"] != tid]
    st, d = j("GET", "/api/admin/settings", headers=T.ah())
    st, dq = j("GET", "/api/admin/registrations", headers=T.ah())
    approved_now = dq.get("counts", {}).get("approved", 0)
    st, d = j("POST", "/api/admin/settings", {"slot_limit": approved_now},
              headers=T.ah())
    st, d = j("POST", "/api/admin/registrations/%s/status" % pend[0],
              {"status": "approved"}, headers=T.ah())
    report("approve past slot limit blocked",
           st == 400 and d.get("field") == "slotLimit",
           "status=%s body=%s" % (st, d))
    st, d = j("POST", "/api/admin/registrations/%s/status" % pend[0],
              {"status": "approved", "override": True}, headers=T.ah())
    report("override approves past the limit", st == 200,
           "status=%s body=%s" % (st, d))
    j("POST", "/api/admin/settings", {"slot_limit": 16}, headers=T.ah())
    report("slot limit restored", True)

    st, d = j("POST", "/api/admin/registrations/%s/status" % pend[1],
              {"status": "needs_changes", "note": "Fix P3 IGN typo."},
              headers=T.ah())
    report("needs-changes stores note",
           st == 200 and d["registration"]["status"] == "needs_changes"
           and d["registration"]["status_note"] == "Fix P3 IGN typo.",
           "status=%s" % st)

    st, d = j("POST", "/api/admin/bulk-status",
              {"teamIds": pend[2:4], "status": "rejected",
               "note": "Duplicate roster."}, headers=T.ah())
    report("bulk reject succeeds",
           st == 200 and len(d.get("done", [])) == 2 and not d.get("errors"),
           "status=%s body=%s" % (st, d))

    # waitlisting an approved+grouped demo team must clear its group
    st, d = j("GET", "/api/admin/registrations?status=approved", headers=T.ah())
    grouped = [r for r in d["registrations"]
               if r.get("group_id") and r["team_id"] != tid]
    if grouped:
        victim = grouped[0]["team_id"]
        st, d = j("POST", "/api/admin/registrations/%s/status" % victim,
                  {"status": "waitlisted"}, headers=T.ah())
        report("leaving approved clears the group",
               st == 200 and not d["registration"].get("group_id"),
               "body=%s" % d)
    else:
        report("leaving approved clears the group", False, "no grouped demo team")

    # ---------- schedule note ----------
    st, d = j("PUT", "/api/admin/registrations/" + tid,
              {"scheduleNote": "Erangel 4PM IST, lobby 3:50"},
              headers=T.ah())
    report("schedule note saves", st == 200, "status=%s" % st)

    # ---------- groups ----------
    print("\n[groups]")
    st, d = j("POST", "/api/admin/groups",
              {"name": "Group TEST", "size": 1}, headers=T.ah())
    gid = d.get("groupId")
    report("create group", st == 200 and gid, "status=%s body=%s" % (st, d))

    st, d = j("POST", "/api/admin/groups/%s/assign" % gid,
              {"teamId": tid}, headers=T.ah())
    report("assign approved team to group", st == 200, "status=%s body=%s" % (st, d))

    st, d = j("PUT", "/api/admin/groups/%d" % gid, {"locked": True},
              headers=T.ah())
    report("lock group", st == 200, "status=%s body=%s" % (st, d))
    st, d = j("PUT", "/api/admin/groups/%d" % gid, {"name": "Renamed"},
              headers=T.ah())
    report("rename locked group refused", st == 403, "status=%s body=%s" % (st, d))
    st, d = j("PUT", "/api/admin/groups/%d" % gid, {"locked": False},
              headers=T.ah())
    report("unlock group", st == 200, "status=%s body=%s" % (st, d))

    st, d = j("POST", "/api/admin/groups/%s/assign" % gid,
              {"teamId": pend[5]}, headers=T.ah())
    report("assign pending team refused", st == 400, "status=%s" % st)

    st, ad = j("GET", "/api/admin/groups", headers=T.ah())
    free = [t["team_id"] for t in ad["unassigned"] if t["team_id"] != tid]
    st, d = j("POST", "/api/admin/groups/%s/assign" % gid,
              {"teamId": free[0]}, headers=T.ah())
    report("full group refuses another team",
           st == 400 and "full" in d.get("error", ""),
           "status=%s body=%s" % (st, d))

    st, d = j("POST", "/api/admin/groups/auto",
              {"count": 2, "size": 4}, headers=T.ah())
    report("auto-distribute runs", st == 200, "status=%s body=%s" % (st, d))
    st, d = j("POST", "/api/admin/groups/auto",
              {"count": 2, "size": 4}, headers=T.ah())
    report("auto-distribute re-runs", st == 200)

    st, d = j("POST", "/api/admin/settings", {"groups_locked": True}, headers=T.ah())
    st, d2 = j("POST", "/api/admin/groups", {"name": "Group X", "size": 4},
               headers=T.ah())
    report("global lock blocks group creation", st == 403, "status=%s" % st)
    st, d = j("POST", "/api/admin/settings", {"groups_locked": False}, headers=T.ah())

    st, ad = j("GET", "/api/admin/groups", headers=T.ah())
    ours_grouped = [g for g in ad["groups"] if any(t["team_id"] == tid for t in g["teams"])]
    report("our team landed in a group after auto",
           bool(ours_grouped), str([(g["name"], g["count"]) for g in ad["groups"]]))

    st, d = j("POST", "/api/admin/groups/0/assign", {"teamId": tid}, headers=T.ah())
    report("unassign via group 0", st == 200, "status=%s" % st)

    st, ad = j("GET", "/api/admin/groups", headers=T.ah())
    for g in ad["groups"]:
        j("DELETE", "/api/admin/groups/%s" % g["id"], headers=T.ah())
    st, ad = j("GET", "/api/admin/groups", headers=T.ah())
    report("all groups deletable", st == 200 and ad["groups"] == [],
           str(ad.get("groups")))

    # ---------- exports ----------
    print("\n[exports]")
    st, body = T.http("GET", "/api/admin/export/approved.csv", headers=T.ah())
    report("approved CSV downloads", st == 200 and b"reg_code" in body,
           "status=%s" % st)
    st, body = T.http("GET", "/api/admin/export/groups.csv", headers=T.ah())
    report("groups CSV downloads", st == 200 and b"team_name" in body,
           "status=%s" % st)

    # ---------- export audit ----------
    print("\n[export audit]")
    T.http("GET", "/api/admin/export/approved.csv", headers=T.ah())
    T.http("GET", "/api/admin/export/groups.csv", headers=T.ah())
    st, d = j("GET", "/api/admin/audit?limit=300", headers=T.ah())
    acts = [e.get("action") for e in (d.get("audit") or [])]
    report("CSV exports are recorded in the audit log",
           st == 200 and acts.count("export") >= 2,
           "actions=%s" % acts[:12])

    # ---------- public feed toggle ----------
    print("\n[public teams feed]")
    st, d = j("POST", "/api/admin/settings", {"public_teams": True}, headers=T.ah())
    st, d = T.jhttp("GET", "/api/public/approved")
    ok = st == 200 and d.get("ok")
    if ok:
        keys = set()
        for t in d["teams"]:
            keys |= set(t)
        ok = keys <= {"team_name", "team_tag", "logo_path", "group_name"}
    report("feed exposes names/tags/logos/groups only", ok,
           "status=%s body=%s" % (st, d if not ok else "keys-ok"))
    j("POST", "/api/admin/settings", {"public_teams": False}, headers=T.ah())
    st, d = T.jhttp("GET", "/api/public/approved")
    report("feed hidden again after toggle off", st == 404)

    # ---------- purge guard ----------
    print("\n[purge guard]")
    st, h = T.jhttp("GET", "/api/health")
    pre_purge = h.get("count")
    st, d = j("POST", "/api/admin/purge", {"confirm": "nope"}, headers=T.ah())
    report("purge needs the exact word", st == 400, "status=%s" % st)
    st, h = T.jhttp("GET", "/api/health")
    report("nothing purged", h.get("count") == pre_purge,
           "count=%s pre=%s" % (h.get("count"), pre_purge))

    # ---------- final team-side check (post-approval) ----------
    print("\n[status page after approval]")
    st, d = lookup(code, p["capPhone"])
    report("team sees approved state",
           st == 200 and d.get("status") == "approved", "status=%s body=%s" % (st, d))
    report("note visible to the team", d.get("note") == "Slot confirmed - group posted")
    report("schedule visible when set", d.get("schedule") == "Erangel 4PM IST, lobby 3:50")

    # ---------- dashboard extras ----------
    print("\n[dashboard]")
    st, d = j("GET", "/api/admin/registrations", headers=T.ah())
    report("queue reports remaining slots",
           st == 200 and isinstance(d.get("remaining"), int)
           and d["remaining"] >= 0, "remaining=%s" % d.get("remaining"))
    nd = d.get("notify")
    report("queue embeds notification counts",
           isinstance(nd, dict) and {"pending", "failed"} <= set(nd),
           "notify=%s" % nd)
    st, s = j("GET", "/api/admin/settings", headers=T.ah())
    report("settings expose the schedule fields",
           st == 200 and "timezone" in s and "schedule_note" in s,
           "keys=%s" % sorted(s))

    # ---------- public schedule (settings-driven) ----------
    print("\n[public schedule]")
    st, d = T.jhttp("GET", "/api/public/schedule")
    report("schedule hidden while the public feed is off",
           st == 404, "status=%s" % st)
    st, d = j("POST", "/api/admin/settings",
              {"timezone": "Asia/Kolkata",
               "schedule_note": "10:00 check-in - 12:00 Round 1 (Erangel)",
               "public_teams": True}, headers=T.ah())
    report("schedule settings save", st == 200 and d.get("ok"),
           "status=%s body=%s" % (st, d))
    st, d = T.jhttp("GET", "/api/public/schedule")
    report("public schedule serves note + timezone + updatedAt",
           st == 200 and d.get("ok")
           and "check-in" in (d.get("schedule") or "")
           and d.get("timezone") == "Asia/Kolkata"
           and bool(d.get("updatedAt")),
           "body=%s" % d)
    j("POST", "/api/admin/settings", {"public_teams": False}, headers=T.ah())
    st, d = T.jhttp("GET", "/api/public/schedule")
    report("schedule hidden again after the toggle",
           st == 404, "status=%s" % st)
    j("POST", "/api/admin/settings",
      {"timezone": "Asia/Kolkata", "schedule_note": ""}, headers=T.ah())

    # ---------- notification queue ----------
    print("\n[notification queue]")
    j("POST", "/api/admin/registrations/%s/status" % tid,
      {"status": "waitlisted", "note": "queue probe"}, headers=T.ah())
    st, d = j("GET", "/api/admin/notifications", headers=T.ah())
    c = d.get("counts") or {}
    report("status change leaves a queued job",
           st == 200 and (c.get("pending", 0) + c.get("skipped", 0)) >= 1,
           "counts=%s" % c)
    allowed_fail_keys = {"id", "team_id", "kind", "attempts", "last_error",
                         "created_at", "reg_code", "team_name"}
    report("failure details expose no address fields",
           isinstance(d.get("failures"), list) and
           all(set(f) <= allowed_fail_keys for f in d["failures"]),
           "failures=%s" % str(d.get("failures"))[:120])
    st, r = j("POST", "/api/admin/notifications/retry", {}, headers=T.ah())
    report("retry endpoint answers with a requeued count",
           st == 200 and "requeued" in r, "body=%s" % r)

    # ---------- auto-distribute: preview, then apply, then preserve ----------
    print("\n[auto-distribute preview]")
    st, g_before = j("GET", "/api/admin/groups", headers=T.ah())
    st, d = j("POST", "/api/admin/groups/auto",
              {"count": 2, "size": 4, "preview": True}, headers=T.ah())
    report("preview returns a plan",
           st == 200 and d.get("preview") is True
           and isinstance(d.get("plan"), list) and d.get("plan"),
           "status=%s body=%s" % (st, d))
    st, g_after = j("GET", "/api/admin/groups", headers=T.ah())
    report("preview writes nothing (groups unchanged)",
           g_before == g_after, "before=%s after=%s"
           % (g_before.get("groups"), g_after.get("groups")))
    st, d = j("POST", "/api/admin/groups/auto",
              {"count": 2, "size": 4}, headers=T.ah())
    report("apply distributes the unplaced teams",
           st == 200 and d.get("ok"), "body=%s" % d)
    first_moved = d.get("moved", -1)
    st, d2 = j("POST", "/api/admin/groups/auto",
               {"count": 2, "size": 4}, headers=T.ah())
    report("re-run preserves existing placements (moved=0)",
           st == 200 and d2.get("moved") == 0,
           "moved=%s first_run=%s" % (d2.get("moved"), first_moved))

    # ---------- same-origin checks on admin writes ----------
    print("\n[same-origin checks]")
    st, d = j("POST", "/api/admin/settings", {"slot_limit": 16},
              headers=T.ah({"Origin": "http://evil.example"}))
    report("cross-site Origin rejected", st == 403,
           "status=%s body=%s" % (st, d))
    st, d = j("POST", "/api/admin/settings", {"slot_limit": 16},
              headers=T.ah({"Referer": "http://evil.example/steal"}))
    report("cross-site Referer rejected", st == 403,
           "status=%s body=%s" % (st, d))
    st, d = j("POST", "/api/admin/settings", {"slot_limit": 16},
              headers=T.ah({"Origin": T.BASE}))
    report("same-origin write accepted", st == 200 and d.get("ok"),
           "status=%s body=%s" % (st, d))

    # ---------- keep-alive: rejected writes must not poison the socket ----------
    print("\n[keep-alive connection hygiene]")
    import http.client as _hc
    import urllib.parse as _up
    _u = _up.urlsplit(T.BASE)
    _body = json.dumps({"teamIds": ["CSM-BG-NONE"],
                        "status": "approved"}).encode()

    conn = _hc.HTTPConnection(_u.hostname, _u.port, timeout=10)
    try:
        statuses = []
        for _ in range(3):
            conn.request("POST", "/api/admin/bulk-status", _body,
                         {"Content-Type": "application/json"})
            r = conn.getresponse()
            statuses.append(r.status)
            r.read()
        report("3x rejected write (no session) on one socket stay 401s",
               statuses == [401, 401, 401], "statuses=%s" % statuses)
    finally:
        conn.close()

    conn = _hc.HTTPConnection(_u.hostname, _u.port, timeout=10)
    try:
        statuses = []
        for csrf_hdr in (None, None, T.SESS_CSRF):
            hdrs = {"Content-Type": "application/json",
                    "Cookie": T.SESS_COOKIE}
            if csrf_hdr:
                hdrs["X-Admin-CSRF"] = csrf_hdr
            conn.request("POST", "/api/admin/settings",
                         json.dumps({"slot_limit": 16}).encode(), hdrs)
            r = conn.getresponse()
            statuses.append(r.status)
            r.read()
        report("bad-CSRF writes then a good write on one socket",
               statuses == [403, 403, 200], "statuses=%s" % statuses)
    finally:
        conn.close()

    # ---------- session lifetime: idle timeout + absolute expiry ----------
    print("\n[session security]")
    import hashlib as _hl
    import sqlite3 as _sq
    from datetime import datetime as _dt, timezone as _tz
    import server as _srv
    raw_sess = T.SESS_COOKIE.split("=", 1)[1]
    sid = _hl.sha256(raw_sess.encode()).hexdigest()
    admin_id = None
    con = _sq.connect(T.DB_PATH, timeout=5)
    con.row_factory = _sq.Row
    try:
        srow = con.execute(
            "SELECT admin_id FROM admin_sessions WHERE id_hash = ?",
            (sid,)).fetchone()
        admin_id = srow["admin_id"] if srow else None
        report("logged-in session row found for aging",
               admin_id is not None)
        if admin_id is not None:
            stale = _dt.fromtimestamp(
                time.time() - _srv.SESSION_IDLE_TTL - 60, _tz.utc).isoformat()
            con.execute(
                "UPDATE admin_sessions SET last_seen = ? WHERE id_hash = ?",
                (stale, sid))
            con.commit()
    finally:
        con.close()
    st, d = j("GET", "/api/admin/settings", headers=T.ah())
    report("idle-expired session rejected with 401", st == 401,
           "status=%s" % st)

    if admin_id is None:
        report("fresh session works without a new login", False, "no admin_id")
    else:
        # mint a fresh session directly — zero IP-login budget spent
        new_raw, new_csrf = _srv.session_create(admin_id)
        T.SESS_COOKIE = "bgmi_admin=" + new_raw
        T.SESS_CSRF = new_csrf
        st, d = j("GET", "/api/admin/settings", headers=T.ah())
        report("fresh session works without a new login",
               st == 200 and d.get("ok"), "status=%s" % st)

        exp_raw, _ = _srv.session_create(admin_id)
        exp_sid = _hl.sha256(exp_raw.encode()).hexdigest()
        con = _sq.connect(T.DB_PATH, timeout=5)
        try:
            con.execute(
                "UPDATE admin_sessions SET expires_at = ? WHERE id_hash = ?",
                (_dt.fromtimestamp(time.time() - 60, _tz.utc).isoformat(),
                 exp_sid))
            con.commit()
        finally:
            con.close()
        st, d = j("GET", "/api/admin/settings",
                  headers={"Cookie": "bgmi_admin=" + exp_raw})
        report("absolute-expired session rejected with 401", st == 401,
               "status=%s" % st)

    # ---------- login throttling (last: spends the IP login budget) -------
    print("\n[login throttle]")
    probe = "zz_probe_" + T.rnd(6).lower()
    st, d = j("POST", "/api/admin/login",
              {"username": probe, "password": "wrong-password-0"})
    msg_known = d.get("error", "")
    st0, d0 = j("POST", "/api/admin/login",
                {"username": "zz_ghost_" + T.rnd(6).lower(),
                 "password": "wrong-password-0"})
    msg_ghost = d0.get("error", "")
    report("unknown user and wrong password give the same 401 body",
           st == 401 and st0 == 401 and msg_known == msg_ghost and msg_known,
           "known=%r ghost=%r" % (msg_known, msg_ghost))
    seen = None
    for i in range(5):                        # probe attempts 2..6
        st, d = j("POST", "/api/admin/login",
                  {"username": probe, "password": "wrong-password-%d" % i})
        if st == 429:
            seen = d.get("error", "")
            break
    report("per-account throttle 429s after 5 failures",
           seen is not None and "this account" in seen, "err=%r" % seen)
    st, d = j("POST", "/api/admin/login",
              {"username": probe, "password": "wrong-password-9"})
    report("account stays throttled on the next attempt",
           st == 429 and "this account" in d.get("error", ""),
           "status=%s" % st)

    # ---------- teardown: leave the DB exactly as found ----------
    print("\n[teardown]")
    j("DELETE", "/api/admin/registrations/" + tid, headers=T.ah())
    j("POST", "/api/admin/settings",
      {"slot_limit": 16, "public_teams": False, "groups_locked": False},
      headers=T.ah())
    seed_demo.main(clean=True)
    T.jhttp("POST", "/api/admin/logout", headers=T.ah(), raw=b"{}",
            ctype="application/json")
    T.drop_fixture()
    st, h = T.jhttp("GET", "/api/health")
    report("database back to baseline",
           h.get("count") == baseline_teams,
           "count=%s baseline=%s" % (h.get("count"), baseline_teams))

    print("\n== %d passed, %d failed ==" % (PASS, FAIL))
    if FAILURES:
        print("Failures:")
        for f in FAILURES:
            print("  - " + f)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
