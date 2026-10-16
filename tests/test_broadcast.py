#!/usr/bin/env python3
"""
Broadcast-section tests for the merged BGMI Cup server.

Covers the scoring engine (placement points, kill points, tie-breakers),
the match lifecycle (create, check-in, start, desk actions, auto-placement,
eliminate, publish rules, publish/unpublish/reset/delete), control-desk
actions incl. undo + duplicate-placement validation, overlay token gating
and rotation, the absence of PII on every public + overlay endpoint, admin
gating of every new route, and the extended purge.

Usage:  python tests/test_broadcast.py       (self-hosted: temp DB/uploads on a free port)
        BASE=http://127.0.0.1:8090 python tests/test_broadcast.py

Reuses the admin fixture helpers from test_api.py (throwaway account,
deleted at the end — no default credentials anywhere). The real
registrations.db is never touched.
"""

import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import test_api as T          # noqa: E402  (shared HTTP + fixture helpers)
import scripts.seed_demo as seed_demo   # noqa: E402
import broadcast              # noqa: E402  (pure engine + state builders)
import server                 # noqa: E402  (temp DB env comes from test_api)

sys.path.insert(0, os.path.join(T.ROOT, "scripts"))

PASS = 0
FAIL = 0
FAILURES = []


class _Conn:
    """Thin context manager: a row-locked sqlite connection to the test DB.

    The engine functions are pure w.r.t. the connection they're handed, so
    the suite exercises them directly against the same isolated database the
    throwaway server uses — never the real registrations.db."""

    def __init__(self):
        self.con = sqlite3.connect(T.DB_PATH, timeout=5)
        self.con.row_factory = sqlite3.Row

    def __enter__(self):
        return self.con

    def __exit__(self, *exc):
        self.con.close()
        return False


def server_conn():
    return _Conn()

# PII probes: the seeded demo captain e-mail domain + phone prefix + any
# e-mail shape. Public/overlay payloads must never contain these.
PII_PROBES = [re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),   # any e-mail
              re.compile(r"98\d{8}"),                    # demo phone prefix
              re.compile(r"cap_(email|phone|uid)", re.I)]


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


def fetch_text(path, headers=None):
    """Raw GET for CSV exports (utf-8-sig tolerant)."""
    req = urllib.request.Request(T.BASE + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode("utf-8-sig")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8-sig", "replace")


def no_pii(text):
    """True when no e-mail / phone / cap_* key appears in the payload."""
    return not any(rx.search(text) for rx in PII_PROBES)


def approved_by_group():
    """{group_name: [team_id, ...]} for every approved + grouped demo team."""
    st, d = j("GET", "/api/admin/registrations?status=approved",
              headers=T.ah())
    out = {}
    for r in d.get("registrations", []):
        g = r.get("group_name") or r.get("group") or ""
        if g:
            out.setdefault(g, []).append(r["team_id"])
    return out


def main():
    T.ensure_server()          # isolated temp DB + throwaway server (or BASE)
    print("== BGMI broadcast tests @ %s ==" % T.BASE)

    # drop leftovers from any crashed run, then seed a clean demo world
    seed_demo.reset(server, broadcast, "full")
    info = seed_demo.seed(server, broadcast, "full", with_results=True)

    # the live fixtures below need a live match, so start one of the two
    # scheduled lobbies directly (the seed already seated its 16-squad lineup)
    with server_conn() as conn:
        broadcast.start_match(conn, info["matches"]["group_a"], "test")
        broadcast.team_kill_delta(conn, info["matches"]["group_a"],
                                  info["group_a"][0], 2, "test")
        conn.commit()

    st, _ = T.admin_login()
    report("admin session established", st == 200, "status=%s" % st)
    _, me = j("GET", "/api/admin/me", headers=T.ah())
    report("session is a broadcast-capable admin", me.get("ok") is True,
           str(me)[:120])

    # ---------- schema + migrations ----------
    print("\n[schema + migrations]")
    st, d = j("GET", "/api/health")
    report("health reports seeded registrations",
           st == 200 and d.get("count", 0) >= 8, str(d)[:120])
    st, d = j("GET", "/api/admin/matches", headers=T.ah())
    matches = d.get("matches", [])
    report("broadcast tables migrated (matches listed)",
           st == 200 and len(matches) >= 2, "status=%s n=%d" % (st, len(matches)))
    seeded = {m["status"]: m for m in matches}
    report("demo seed created one published + one live match",
           "published" in seeded and "live" in seeded,
           str(sorted(seeded)))
    # re-running migrate is a no-op (idempotent)
    with server_conn() as conn:
        broadcast.migrate(conn)
        conn.commit()
    report("migrate is idempotent", True)
    with server_conn() as conn:
        cols = {r["name"] for r in
                conn.execute("PRAGMA table_info(match_team_results)")}
        report("R2-3 adjustment columns exist",
               {"adjustment", "adjustment_reason"} <= cols, str(sorted(cols)))

    # ---------- scoring engine (pure) ----------
    print("\n[scoring engine]")
    with server_conn() as conn:
        rules = broadcast.load_rules(conn)
    report("default placement table 1..8",
           [broadcast.placement_points(p, rules) for p in range(1, 9)]
           == [10, 6, 5, 4, 3, 2, 1, 1],
           str(rules))
    report("default kill point is 1", rules["kill_points"] == 1)
    report("compute_points = placement + kills",
           broadcast.compute_points(3, 2, rules) == 6 + 3,
           str(broadcast.compute_points(3, 2, rules)))
    report("compute_points: 9th+ place earns no placement points",
           broadcast.compute_points(2, 9, rules) == 2)

    # tie-breakers, in spec order: points > wins > placement pts >
    # finish pts > last-match placement
    row = lambda pts, wins, pp, fp, last: {   # noqa: E731
        "points": pts, "wins": wins, "placement_points": pp,
        "finish_points": fp, "last_placement": last}
    base = row(20, 1, 10, 6, 3)
    report("tie-break: more points wins",
           sorted([base, row(21, 0, 8, 9, 8)], key=broadcast.overall_sort_key)
           [0]["points"] == 21)
    report("tie-break: equal points -> more wins",
           sorted([base, row(20, 2, 6, 4, 6)], key=broadcast.overall_sort_key)
           [0]["wins"] == 2)
    report("tie-break: equal points+ wins -> placement points",
           sorted([base, row(20, 1, 12, 1, 9)], key=broadcast.overall_sort_key)
           [0]["placement_points"] == 12)
    report("tie-break: then finish points",
           sorted([base, row(20, 1, 10, 8, 9)], key=broadcast.overall_sort_key)
           [0]["finish_points"] == 8)
    report("tie-break: then last-match placement (earlier better)",
           sorted([base, row(20, 1, 10, 6, 1)], key=broadcast.overall_sort_key)
           [0]["last_placement"] == 1)
    report("tie-break: missing last placement sorts worst",
           sorted([base, row(20, 1, 10, 6, None)],
                  key=broadcast.overall_sort_key)[0]["last_placement"] == 3)

    # ---------- admin gating of the new routes ----------
    print("\n[admin gating]")
    st, _ = T.jhttp("GET", "/api/admin/matches")
    report("GET /api/admin/matches requires a session (401)", st == 401)
    st, _ = j("POST", "/api/admin/matches", {"group": "Group A"})
    report("POST /api/admin/matches requires a session (401)", st == 401)
    st, _ = T.jhttp("GET", "/api/admin/overlay-settings")
    report("GET /api/admin/overlay-settings requires a session (401)", st == 401)
    for page in ("/admin/matches", "/admin/control", "/admin/overlays",
                 "/admin/caster"):
        st, b = T.http("GET", page)
        report("unauthenticated %s serves the login gate" % page,
               st == 200 and b"loginForm" in b, "status=%s" % st)
    # CSRF is enforced on every broadcast write
    st, d = j("POST", "/api/admin/matches", {"group": "Group A"},
              headers={"Cookie": T.SESS_COOKIE})   # no X-Admin-CSRF
    report("broadcast write without CSRF is rejected (403)", st == 403,
           "status=%s body=%s" % (st, d))

    # ---------- published demo standings (source of truth) ----------
    print("\n[published demo standings]")
    st, live = j("GET", "/api/live/state")
    overall = live.get("overallPublished", [])
    report("published match feeds overall standings",
           st == 200 and len(overall) >= 4, "rows=%d" % len(overall))
    if overall:
        report("leader has a positive score and a win",
               overall[0]["points"] > 0 and overall[0].get("wins", 0) >= 1,
               str(overall[0]))
    report("public /api/live/state carries no PII",
           no_pii(json.dumps(live)), "payload leaked PII")
    report("live state exposes the seeded live match",
           (live.get("match") or {}).get("status") == "live",
           str(live.get("match"))[:120])
    st, page = T.http("GET", "/live")
    report("GET /live serves the page", st == 200 and b"Overall points" in page)
    st, page = T.http("GET", "/results")
    report("GET /results serves the page",
           st == 200 and b"Overall standings" in page)
    report("GET /results lists a published match card", b"Match results" in page)

    # ---------- legacy redirects ----------
    # urllib auto-follows redirects, so use a handler that refuses to follow
    # and hands back the raw 301/302 + Location.
    print("\n[legacy redirects]")

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None

    _opener = urllib.request.build_opener(_NoRedirect)

    for old, new in (("/standings", "/results"),
                     ("/operator", "/admin/control"),
                     ("/login", "/admin")):
        try:
            with _opener.open(T.BASE + old, timeout=10) as r:
                st, loc = r.status, r.headers.get("Location", "")
        except urllib.error.HTTPError as e:
            st, loc = e.code, e.headers.get("Location", "")
        report("legacy %s -> %s" % (old, new),
               st in (301, 302) and loc.endswith(new),
               "status=%s loc=%s" % (st, loc))

    # ---------- overlay token gating ----------
    print("\n[overlay token]")
    st, cfg = j("GET", "/api/admin/overlay-settings", headers=T.ah())
    token = cfg.get("token", "")
    report("overlay token issued (32+ chars)", len(token) >= 32, str(len(token)))
    st, d = j("GET", "/api/overlay/state/live")
    report("overlay state without token is 403", st == 403, "status=%s" % st)
    st, d = j("GET", "/api/overlay/state/live?token=bogus")
    report("overlay state with wrong token is 403", st == 403, "status=%s" % st)
    st, d = j("GET",
              "/api/overlay/state/live?token=" + token)
    report("overlay state with valid token is 200",
           st == 200 and d.get("name") == "live"
           and isinstance((d.get("state") or {}).get("teams"), list),
           "status=%s body=%s" % (st, str(d)[:120]))
    report("overlay payload carries no PII", no_pii(json.dumps(d)),
           "payload leaked PII")
    st, d = j("GET", "/api/overlay/state/no-such-scene?token=" + token)
    report("unknown overlay name is 404", st == 404, "status=%s" % st)
    # SSE endpoint streams with the token, refuses without it.
    # A stream never ends, so read just the first chunk with a short socket
    # timeout — a blocking read() would hang until the keepalive window.
    print("\n[sse]")

    def sse_first_bytes(path, timeout=6):
        """Open `path` on a raw socket and read just the first bytes.

        urllib can't be used here: an SSE stream sends neither a
        Content-Length nor chunked encoding, so urlopen() blocks reading the
        body until the connection drops. A raw socket grabs the
        ': connected' prologue and bails immediately."""
        import socket as _sock
        host, port = T.BASE.split("//", 1)[1].split(":")
        s = _sock.create_connection((host, int(port)), timeout=timeout)
        try:
            s.sendall(("GET %s HTTP/1.1\r\nHost: %s:%s\r\n"
                       "Accept: text/event-stream\r\n"
                       "Connection: close\r\n\r\n"
                       % (path, host, port)).encode())
            buf = b""
            # read the headers first
            while b"\r\n\r\n" not in buf and len(buf) < 65536:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
            head, sep, rest = buf.partition(b"\r\n\r\n")
            status = int(head.split(b" ", 2)[1]) if sep and b" " in head else 0
            body = rest
            # for a live stream, keep reading until the ': connected'
            # prologue lands (it can arrive in a separate segment);
            # errors are short JSON, so one headers read is enough there.
            if sep and status == 200 and b"text/event-stream" in head:
                while b"connected" not in body and b": ping" not in body \
                        and len(body) < 65536:
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    body += chunk
            return status, body[:64]
        except Exception as e:      # surfaced by the caller's assertion
            return 0, str(e).encode()
        finally:
            s.close()

    st, body = sse_first_bytes(
        "/api/overlay/stream/live?token=" + token)
    report("overlay SSE stream answers with the token",
           st == 200 and b"connected" in body, "status=%s" % st)
    st, _ = T.http("GET", "/api/overlay/stream/live")
    report("overlay SSE stream refuses without token (403)", st == 403,
           "status=%s" % st)
    # rotation invalidates the old token everywhere at once
    st, d = j("POST", "/api/admin/overlay-settings",
              {"rotateToken": True}, headers=T.ah())
    new_token = d.get("token", "")
    report("token rotates to a different value",
           st == 200 and new_token and new_token != token, str(d)[:120])
    st, _ = j("GET", "/api/overlay/state/live?token=" + token)
    report("old token is dead after rotation", st == 403, "status=%s" % st)
    st, d = j("GET", "/api/overlay/state/live?token=" + new_token)
    report("new token works after rotation", st == 200, "status=%s" % st)
    token = new_token

    # ---------- overlay show/hide + theme ----------
    st, d = j("POST", "/api/admin/overlay-settings",
              {"themeColor": "#ff00aa", "disabled": ["intermission"]},
              headers=T.ah())
    report("theme color + disable switch saved",
           st == 200 and d.get("themeColor") == "#ff00aa", str(d)[:120])
    st, d = j("GET", "/api/overlay/state/intermission?token=" + token)
    report("disabled overlay reports disabled=true",
           st == 200 and d.get("disabled") is True, str(d)[:120])
    st, d = j("POST", "/api/admin/overlay-settings",
              {"themeColor": "#b6ff3e", "disabled": []}, headers=T.ah())
    report("overlay settings restored", st == 200, str(d)[:120])

    # ---------- match lifecycle over HTTP ----------
    print("\n[match lifecycle]")
    groups = approved_by_group()
    gname = sorted(groups)[0]
    squad_ids = groups[gname][:4]
    report("approved squads available for %s" % gname, len(squad_ids) >= 4,
           str(groups))

    st, d = j("POST", "/api/admin/matches",
              {"group": gname, "map": "Erangel", "notes": "bc-test"},
              headers=T.ah())
    state = d.get("state", {})
    mid = (state.get("match") or {}).get("id")
    report("create match", st == 200 and bool(mid), str(d)[:160])
    report("new match starts 'upcoming'",
           (state.get("match") or {}).get("status") == "upcoming")

    # ---- scheduled start time (matches page + /schedule) ----
    st, d = j("POST", "/api/admin/matches/%d/schedule" % mid,
              {"startsAt": "2026-11-14T18:30"}, headers=T.ah())
    report("schedule time saves on the match",
           st == 200
           and d["state"]["match"]["starts_at"] == "2026-11-14T18:30",
           str(d)[:160])
    st, d = j("POST", "/api/admin/matches/%d/schedule" % mid,
              {"startsAt": "tomorrow-ish"}, headers=T.ah())
    report("a malformed schedule time is refused (400)", st == 400,
           str(d)[:120])
    st, d = j("POST", "/api/admin/matches",
              {"group": gname, "startsAt": "14/11/2026"}, headers=T.ah())
    report("create refuses a malformed schedule time (400)", st == 400,
           str(d)[:120])
    mn = (state.get("match") or {}).get("match_number")
    j("POST", "/api/admin/settings",
      {"public_teams": True, "schedule_note": "bc-test plan"}, headers=T.ah())
    st, pub = T.jhttp("GET", "/api/public/schedule")
    pm = next((x for x in (pub.get("matches") or [])
               if x.get("number") == mn), None)
    report("public schedule lists the match and its start time",
           st == 200 and pm is not None
           and pm.get("startsAt") == "2026-11-14T18:30"
           and pm.get("map") == "Erangel", str(pub)[:200])
    report("public schedule payload carries no PII",
           no_pii(json.dumps(pub)), "payload leaked PII")
    j("POST", "/api/admin/settings", {"public_teams": False}, headers=T.ah())

    # start with no squads checked in -> refused
    st, d = j("POST", "/api/admin/matches/%d/status" % mid,
              {"status": "live"}, headers=T.ah())
    report("start with <2 squads is refused", st == 400, str(d)[:120])

    st, d = j("POST", "/api/admin/matches/%d/checkin" % mid,
              {"teamIds": squad_ids}, headers=T.ah())
    report("check-in sets the lineup", st == 200
           and len(d["state"]["teams"]) == len(squad_ids), str(d)[:120])
    # set_lineup filters to eligible squads of the match's group, so an
    # unknown/unapproved id is dropped rather than raising — the lineup must
    # never grow a squad that isn't approved into this group.
    st, d = j("POST", "/api/admin/matches/%d/checkin" % mid,
              {"teamIds": squad_ids + ["CSM-BG-D999"]}, headers=T.ah())
    got = [t["teamId"] for t in d["state"]["teams"]]
    report("check-in drops an unknown squad from the lineup",
           st == 200 and len(got) == len(squad_ids)
           and "CSM-BG-D999" not in got, "status=%s got=%s" % (st, got))
    j("POST", "/api/admin/matches/%d/checkin" % mid,
      {"teamIds": squad_ids}, headers=T.ah())

    st, d = j("GET", "/api/admin/matches/%d" % mid, headers=T.ah())
    preview = d["state"]["teams"] if st == 200 else []
    report("upcoming cards preview the 4 registered starters",
           st == 200 and len(preview) == len(squad_ids)
           and all(len(t["players"]) == 4 for t in preview),
           str([len(t["players"]) for t in preview]))
    report("preview rows are read-only (no player ids yet)",
           all(p["id"] is None for t in preview for p in t["players"])
           and all(p["name"] and p["uid"] for t in preview
                   for p in t["players"]),
           str(preview[0]["players"][:1])[:160] if preview else "no teams")

    st, d = j("POST", "/api/admin/matches/%d/status" % mid,
              {"status": "live"}, headers=T.ah())
    report("start match goes live", st == 200
           and d["state"]["match"]["status"] == "live", str(d)[:160])
    report("start creates player rows for every squad",
           all(t.get("players") and all(p["id"] for p in t["players"])
               for t in d["state"]["teams"]), str(d)[:200])
    # double-start refused
    st, _ = j("POST", "/api/admin/matches/%d/status" % mid,
              {"status": "live"}, headers=T.ah())
    report("double start is refused", st == 400)

    # ---------- control-desk actions ----------
    print("\n[control desk]")
    t0, t1 = squad_ids[0], squad_ids[1]
    st, d = j("POST", "/api/admin/match/%d/team/%s/kills" % (mid, t0),
              {"delta": 3}, headers=T.ah())
    kills0 = next(t["kills"] for t in d["state"]["teams"] if t["teamId"] == t0)
    report("team kill delta accumulates", st == 200 and kills0 == 3,
           "kills=%s" % kills0)
    st, d = j("POST", "/api/admin/match/%d/team/%s/kills" % (mid, t0),
              {"delta": 2}, headers=T.ah())
    kills0b = next(t["kills"] for t in d["state"]["teams"] if t["teamId"] == t0)
    report("kill delta stacks", kills0b == 5, "kills=%s" % kills0b)

    # player-level action
    p = d["state"]["teams"][0]["players"][0]
    st, d = j("POST", "/api/admin/match/%d/player" % mid,
              {"teamId": d["state"]["teams"][0]["teamId"],
               "playerId": p["id"], "field": "damage", "value": 750},
              headers=T.ah())
    dmg = next(x["damage"] for t in d["state"]["teams"]
               for x in t["players"] if x["id"] == p["id"])
    report("player damage set", st == 200 and dmg == 750, "dmg=%s" % dmg)
    st, d = j("POST", "/api/admin/match/%d/player" % mid,
              {"teamId": t0, "playerId": p["id"], "field": "bogus",
               "value": 1}, headers=T.ah())
    report("unknown player field is refused", st == 400)

    # squad wipe -> auto-placement, no duplicates
    st, d = j("POST", "/api/admin/match/%d/team/%s/eliminate" % (mid, t0),
              {}, headers=T.ah())
    report("eliminate marks the squad out", st == 200, str(d)[:160])
    placed = {t["teamId"]: t["placement"] for t in d["state"]["teams"]}
    report("eliminated squad received an auto placement",
           placed.get(t0) not in (None, 0), str(placed))
    others = [p for tid, p in placed.items() if tid != t0 and p]
    report("auto placement never duplicates a position",
           placed[t0] not in others or placed[t0] in (None, 0), str(placed))

    # manual duplicate placement is refused
    st, d = j("POST", "/api/admin/match/%d/team/%s/placement" % (mid, t1),
              {"placement": placed[t0], "manual": True}, headers=T.ah())
    report("duplicate manual placement is refused",
           st == 400, "status=%s body=%s" % (st, str(d)[:160]))
    # a valid manual placement is accepted and pinned (not auto-moved)
    st, d = j("POST", "/api/admin/match/%d/team/%s/placement" % (mid, t1),
              {"placement": 1, "manual": True}, headers=T.ah())
    pinned = next(t for t in d["state"]["teams"] if t["teamId"] == t1)
    report("manual placement is stored and pinned",
           st == 200 and pinned["placement"] == 1
           and pinned.get("placementAuto") is False, str(pinned)[:160])

    # ---------- 4 players per team + per-match swap ----------
    print("\n[4 players + sub swap]")
    st, d = j("GET", "/api/admin/matches/%d" % mid, headers=T.ah())
    counts = [len(t["players"]) for t in d["state"]["teams"]]
    report("desk lists exactly 4 players per squad",
           st == 200 and len(counts) >= 2 and all(n == 4 for n in counts),
           str(counts))
    swap_team = next((t for t in d["state"]["teams"]
                      if any(b.get("kind") == "roster"
                             for b in (t.get("bench") or []))), None)
    report("a live-match squad offers its substitute for a swap",
           swap_team is not None)
    if swap_team:
        out_p = swap_team["players"][0]
        sub = next(b for b in swap_team["bench"] if b["kind"] == "roster")
        st, d = j("POST", "/api/admin/match/%d/team/%s/swap"
                  % (mid, swap_team["teamId"]),
                  {"benchId": out_p["id"], "inKind": "roster", "inId": sub["id"]},
                  headers=T.ah())
        t2 = next(t for t in d["state"]["teams"]
                  if t["teamId"] == swap_team["teamId"])
        names2 = [p["name"] for p in t2["players"]]
        report("swap fields the sub (still exactly 4 on the floor)",
               st == 200 and len(t2["players"]) == 4 and sub["name"] in names2
               and out_p["name"] not in names2,
               "status=%s names=%s" % (st, names2))
        report("swap is in the event log",
               "comes on for" in json.dumps(d["state"]["events"]))
        st, d = j("GET", "/api/admin/audit?teamId=%s" % swap_team["teamId"],
                  headers=T.ah())
        report("swap is in the audit log",
               st == 200 and "match_swap" in json.dumps(d), str(d)[:160])
        st, d = j("GET", "/api/admin/matches/%d" % mid, headers=T.ah())
        other = next(t for t in d["state"]["teams"]
                     if t["teamId"] == swap_team["teamId"])
        out_opt = next((b for b in (other.get("bench") or [])
                        if b["name"] == out_p["name"]), None)
        report("benched player stays available with stats kept",
               out_opt is not None, str(other.get("bench"))[:160])
        st, d = j("POST", "/api/admin/match/%d/team/%s/swap"
                  % (mid, swap_team["teamId"]),
                  {"benchId": other["players"][1]["id"],
                   "inKind": "roster", "inId": sub["id"]}, headers=T.ah())
        report("activating a player who is already on the floor is refused",
               st == 400 and "already" in json.dumps(d).lower(),
               "status=%s body=%s" % (st, str(d)[:160]))
        st, live = j("GET", "/api/live/state")
        lteam = next((t for t in live.get("teams", [])
                      if t.get("teamId") == swap_team["teamId"]), None)
        live_names = [p["name"] for p in (lteam or {}).get("players", [])]
        report("public /live never shows benched players",
               st == 200 and lteam is not None and len(live_names) == 4
               and out_p["name"] not in live_names,
               "status=%s names=%s" % (st, live_names))
        report("public /live has no UIDs",
               "uid" not in json.dumps(live).lower())
        st, cfg = j("GET", "/api/admin/overlay-settings", headers=T.ah())
        tok = (cfg or {}).get("token", "")
        st, ov = j("GET", "/api/overlay/state/live?token=%s" % tok)
        report("overlay payload carries no UIDs",
               st == 200 and "uid" not in json.dumps(ov).lower(),
               "status=%s" % st)
        st, d = j("POST", "/api/admin/match/%d/undo" % mid, {}, headers=T.ah())
        t3 = next(t for t in d["state"]["teams"]
                  if t["teamId"] == swap_team["teamId"])
        names3 = [p["name"] for p in t3["players"]]
        report("undo restores the pre-swap four",
               st == 200 and len(t3["players"]) == 4
               and out_p["name"] in names3 and sub["name"] not in names3,
               "status=%s names=%s" % (st, names3))

    # ---------- R2-3: card actions — auto, adjust, reset ----------
    print("\n[R2-3 card actions]")
    st, d = j("GET", "/api/admin/matches/%d" % mid, headers=T.ah())
    dteams = d["state"]["teams"]
    report("desk payload carries slot + adjustment fields",
           st == 200 and all("slot" in t and "adjustment" in t for t in dteams),
           str(dteams[0])[:140])

    st, d = j("POST", "/api/admin/match/%d/team/%s/auto" % (mid, t1),
              {}, headers=T.ah())
    t1s = next(t for t in d["state"]["teams"] if t["teamId"] == t1)
    report("AUTO hands placement back to the engine",
           st == 200 and t1s.get("placementAuto") is True, str(t1s)[:160])
    report("AUTO shows in the event log",
           "AUTO" in json.dumps(d["state"]["events"]))

    st, d = j("GET", "/api/admin/matches/%d" % mid, headers=T.ah())
    before = next(t for t in d["state"]["teams"] if t["teamId"] == t0)
    st, d = j("POST", "/api/admin/match/%d/team/%s/adjust" % (mid, t0),
              {"delta": 4, "reason": "rule 4.2 late drop"}, headers=T.ah())
    after = next(t for t in d["state"]["teams"] if t["teamId"] == t0)
    report("adjustment adds to PTS and stores the reason",
           st == 200 and after["points"] == before["points"] + 4
           and after["adjustment"] == 4
           and after["adjustmentReason"] == "rule 4.2 late drop",
           str(after)[:170])
    report("adjustment is in the event log",
           "adjustment +4" in json.dumps(d["state"]["events"]))
    st, d = j("GET", "/api/admin/audit?teamId=%s" % t0, headers=T.ah())
    report("adjustment is in the audit log",
           st == 200 and "match_adjust" in json.dumps(d), str(d)[:140])
    st, d = j("POST", "/api/admin/match/%d/team/%s/adjust" % (mid, t0),
              {"delta": 2}, headers=T.ah())
    report("adjustment without a reason is refused",
           st == 400 and "reason" in json.dumps(d).lower(), str(d)[:140])

    default_table = {1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1}
    want = default_table.get(after["placement"], 0) + after["kills"] \
        + after["adjustment"]
    report("PTS = placement + finishes + adjustment",
           after["points"] == want,
           "pts=%s want=%s" % (after["points"], want))

    st, d = j("POST", "/api/admin/match/%d/team/%s/reset" % (mid, t0),
              {}, headers=T.ah())
    reset = next(t for t in d["state"]["teams"] if t["teamId"] == t0)
    report("reset clears placement/finishes/adjustment and revives players",
           st == 200 and reset["kills"] == 0 and reset["adjustment"] == 0
           and not reset["placement"] and reset["alive"] == 4
           and reset["out"] == 0, str(reset)[:180])
    st, d = j("POST", "/api/admin/match/%d/undo" % mid, {}, headers=T.ah())
    back = next(t for t in d["state"]["teams"] if t["teamId"] == t0)
    report("undo restores the pre-reset card (adjustment included)",
           st == 200 and back["kills"] == before["kills"]
           and back["adjustment"] == 4 and back["points"] == before["points"] + 4,
           str(back)[:180])

    # ---------- 4-player DB guard + legacy repair ----------
    print("\n[4-player DB guard]")
    with server_conn() as conn:
        m1 = conn.execute("SELECT id FROM matches WHERE status = 'published' "
                          "ORDER BY match_number LIMIT 1").fetchone()
        tid_rep = conn.execute(
            "SELECT team_id FROM match_team_results WHERE match_id = ? "
            "ORDER BY team_id LIMIT 1", (m1["id"],)).fetchone()["team_id"]
        # simulate a legacy DB predating the triggers: six extra players
        conn.execute("DROP TRIGGER IF EXISTS trg_player_stats_max4_insert")
        conn.execute("DROP TRIGGER IF EXISTS trg_player_stats_max4_update")
        for i in range(6):
            conn.execute(
                "INSERT INTO player_stats (match_id, team_id, player_uid, "
                "player_name, kills, damage, status, active) "
                "VALUES (?,?,?,?,0,0,'out',1)",
                (m1["id"], tid_rep, "REPAIR-%s-%d" % (tid_rep, i),
                 "RepairPlayer%d" % i))
        broadcast._repair_player_actives(conn)
        n_active = conn.execute(
            "SELECT COUNT(*) AS c FROM player_stats WHERE match_id = ? "
            "AND team_id = ? AND active = 1",
            (m1["id"], tid_rep)).fetchone()["c"]
        n_all = conn.execute(
            "SELECT COUNT(*) AS c FROM player_stats WHERE match_id = ? "
            "AND team_id = ?", (m1["id"], tid_rep)).fetchone()["c"]
        conn.executescript(broadcast.TRIGGERS_SQL)   # restore the guards
        conn.commit()
        report("legacy repair benches extras and keeps every row",
               n_active == 4 and n_all >= 10,
               "active=%s rows=%s" % (n_active, n_all))
        try:
            conn.execute(
                "INSERT INTO player_stats (match_id, team_id, player_uid, "
                "player_name, active) VALUES (?,?,?,?,1)",
                (m1["id"], tid_rep, "FIFTH-%s" % tid_rep, "FifthPlayer"))
            conn.commit()
            blocked, guard_msg = False, "insert succeeded"
        except sqlite3.Error as e:
            blocked, guard_msg = True, str(e)
            conn.rollback()
        report("database refuses a 5th active player",
               blocked and "exactly 4" in guard_msg, guard_msg[:120])

    # ---------- undo ----------
    print("\n[undo]")
    st, d = j("POST", "/api/admin/match/%d/team/%s/kills" % (mid, t1),
              {"delta": 4}, headers=T.ah())
    before = next(t["kills"] for t in d["state"]["teams"] if t["teamId"] == t1)
    st, d = j("POST", "/api/admin/match/%d/undo" % mid, {}, headers=T.ah())
    after = next(t["kills"] for t in d["state"]["teams"] if t["teamId"] == t1)
    report("undo reverts the last desk action",
           st == 200 and after == before - 4,
           "before=%s after=%s" % (before, after))

    # ---------- publish rules ----------
    print("\n[publish rules]")
    # not ended yet -> cannot publish
    st, d = j("POST", "/api/admin/matches/%d/publish" % mid, {}, headers=T.ah())
    report("publish before ending is refused", st == 400, str(d)[:160])
    st, d = j("POST", "/api/admin/matches/%d/status" % mid,
              {"status": "awaiting_verification"}, headers=T.ah())
    report("end match -> awaiting verification", st == 200
           and d["state"]["match"]["status"] == "awaiting_verification",
           str(d)[:160])
    # squads still alive / unplaced -> publishing refused
    st, d = j("POST", "/api/admin/matches/%d/publish" % mid, {}, headers=T.ah())
    report("publish with unplaced squads is refused",
           st == 400 and "placement" in json.dumps(d).lower(),
           "status=%s body=%s" % (st, str(d)[:160]))
    # place every remaining squad, then publish
    st, d = j("GET", "/api/admin/matches/%d" % mid, headers=T.ah())
    teams = d["state"]["teams"]
    taken = {t["placement"] for t in teams if t.get("placement")}
    nxt = 1
    for t in teams:
        if not t.get("placement"):
            while nxt in taken:
                nxt += 1
            j("POST", "/api/admin/match/%d/team/%s/placement" % (mid, t["teamId"]),
              {"placement": nxt, "manual": True}, headers=T.ah())
            taken.add(nxt)
    st, d = j("POST", "/api/admin/matches/%d/publish" % mid, {}, headers=T.ah())
    report("publish succeeds once every squad is placed", st == 200
           and d["state"]["match"]["status"] == "published", str(d)[:160])
    report("publish computes points for every squad",
           all(int(t.get("points") or 0) > 0 or t.get("kills", 0) == 0
               for t in d["state"]["teams"]), str(d["state"]["teams"])[:200])

    st, live2 = j("GET", "/api/live/state")
    pub2 = live2.get("overallPublished", [])
    # the re-publish aggregates onto the same squads, so the row count is
    # unchanged — what grows is each squad's played-match total.
    most_played = max([r.get("matches", 0) for r in pub2] or [0])
    report("published match appears in /api/live/state standings",
           len(pub2) >= 4 and most_played >= 2,
           "rows=%d most_played=%d" % (len(pub2), most_played))
    report("post-publish live state carries no PII",
           no_pii(json.dumps(live2)))

    # unpublish -> back to verification; delete refused while published
    st, _ = j("POST", "/api/admin/matches/%d" % mid, {"delete": True},
              headers=T.ah())
    report("deleting a published match is refused", st == 400)
    st, d = j("POST", "/api/admin/matches/%d/unpublish" % mid, {},
              headers=T.ah())
    report("unpublish returns to awaiting verification", st == 200
           and d["state"]["match"]["status"] == "awaiting_verification",
           str(d)[:160])
    # re-publish, then reset, then delete
    j("POST", "/api/admin/matches/%d/publish" % mid, {}, headers=T.ah())
    st, d = j("POST", "/api/admin/matches/%d/reset" % mid, {}, headers=T.ah())
    report("reset clears live inputs and returns to upcoming", st == 200
           and d["state"]["match"]["status"] == "upcoming"
           and all(not t.get("placement") for t in d["state"]["teams"]),
           str(d)[:200])
    st, d = j("POST", "/api/admin/matches/%d" % mid, {"delete": True},
              headers=T.ah())
    report("delete removes the match", st == 200, str(d)[:120])
    st, d = j("GET", "/api/admin/matches/%d" % mid, headers=T.ah())
    report("deleted match is gone (404)", st == 404, "status=%s" % st)

    # ---------- SSE concurrency ----------
    print("\n[sse]")
    st, body = sse_first_bytes("/api/live/stream")
    report("live SSE stream answers", st == 200 and b"connected" in body,
           "status=%s" % st)
    # a burst of subscribers must not wedge the hub (bounded queues, cleanup)
    import threading
    codes = []

    def _hit():
        codes.append(sse_first_bytes("/api/live/stream", timeout=8)[0])

    threads = [threading.Thread(target=_hit) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=8)
    report("8 concurrent SSE subscribers all connect",
           len(codes) == 8 and all(c == 200 for c in codes), str(codes))

    # ---------- scoring rules round-trip ----------
    print("\n[scoring rules]")
    st, d = j("POST", "/api/admin/scoring-rules",
              {"kill_points": 2,
               "placement": {"1": {"points": 12}, "2": {"points": 8}}},
              headers=T.ah())
    report("scoring rules saved", st == 200
           and d["rules"]["kill_points"] == 2
           and d["rules"]["placement"]["1"] == 12, str(d)[:160])
    st, d = j("GET", "/api/admin/scoring-rules", headers=T.ah())
    report("scoring rules round-trip",
           d.get("rules", {}).get("kill_points") == 2, str(d)[:160])
    # the engine reads int keys, so reload from the DB (not the JSON body)
    with server_conn() as conn:
        live_rules = broadcast.load_rules(conn)
    report("custom rules recompute points",
           broadcast.compute_points(3, 2, live_rules) == 8 + 6,
           str(broadcast.compute_points(3, 2, live_rules)))
    # restore defaults for a clean teardown
    j("POST", "/api/admin/scoring-rules", {"kill_points": 1,
                                           "placement": {}}, headers=T.ah())
    report("scoring rules restored to defaults", True)

    # ---------- R2-4: points table + configurable tie-breakers ----------
    print("\n[R2-4 points + tie-breakers]")
    default_placement = {"1": {"points": 10}, "2": {"points": 6},
                         "3": {"points": 5}, "4": {"points": 4},
                         "5": {"points": 3}, "6": {"points": 2},
                         "7": {"points": 1}, "8": {"points": 1}}
    j("POST", "/api/admin/scoring-rules",
      {"kill_points": 1, "placement": default_placement,
       "tiebreakers": ["wins", "placement_points", "finish_points",
                       "last_placement"]}, headers=T.ah())
    with server_conn() as conn:
        live_rules = broadcast.load_rules(conn)
    base_table = {1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1}
    bad = ["P%d=%s" % (p, broadcast.compute_points(0, p, live_rules))
           for p in range(1, 17)
           if broadcast.compute_points(0, p, live_rules) != base_table.get(p, 0)]
    report("all 16 placements score 10/6/5/4/3/2/1/1 then 0",
           not bad, ", ".join(bad) or "P1-P16 ok")
    report("finishes score one point each by default",
           broadcast.compute_points(5, 0, live_rules) == 5)
    report("match points = placement + finishes + adjustment",
           broadcast.compute_points(3, 1, live_rules, 2) == 15)
    report("a negative adjustment floors at zero",
           broadcast.compute_points(0, 9, live_rules, -5) == 0)
    report("default tie-breaker order is wins > placement > finish > last",
           live_rules["tiebreakers"] == ["wins", "placement_points",
                                         "finish_points", "last_placement"],
           str(live_rules["tiebreakers"]))

    base_row = {"points": 20, "wins": 0, "placement_points": 10,
                "finish_points": 6, "last_placement": 5}

    def ranks_higher(changes):
        a = dict(base_row)
        b = dict(base_row)
        b.update(changes)
        return sorted([a, b], key=broadcast.overall_sort_key)[0] is b

    report("tie-breaker: number of 1st places", ranks_higher({"wins": 1}))
    report("tie-breaker: total placement points",
           ranks_higher({"placement_points": 12}))
    report("tie-breaker: total finish points",
           ranks_higher({"finish_points": 9}))
    report("tie-breaker: last-match placement",
           ranks_higher({"last_placement": 2}))
    c = dict(base_row, finish_points=12, placement_points=8)
    b = dict(base_row, finish_points=9)
    first = sorted([b, c], key=lambda r: broadcast.overall_sort_key(
        r, ["finish_points", "placement_points"]))[0]
    report("custom tie-breaker order is honoured", first is c,
           "finish_points=%s" % first["finish_points"])

    # multi-match totals through the same engine (isolated in-memory DB)
    mem = sqlite3.connect(":memory:")
    mem.row_factory = sqlite3.Row
    mem.executescript(broadcast.SCHEMA)
    mem.executescript(
        "CREATE TABLE registrations (team_id TEXT PRIMARY KEY, "
        "team_name TEXT NOT NULL, team_tag TEXT NOT NULL, "
        "logo_path TEXT, group_id INTEGER);"
        "CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT);")
    mem.execute("INSERT INTO registrations (team_id, team_name, team_tag) "
                "VALUES ('QA-A', 'Alpha QA', 'QA-A')")
    mem.execute("INSERT INTO registrations (team_id, team_name, team_tag) "
                "VALUES ('QA-B', 'Bravo QA', 'QA-B')")
    broadcast.migrate(mem)
    for n in (1, 2):
        mem.execute("INSERT INTO matches (match_number, group_name, map, "
                    "status, created_at) VALUES (?, 'QA', 'Erangel', "
                    "'published', ?)", (n, broadcast.now_iso()))
    for row in ((1, "QA-A", 1, 3, 13), (1, "QA-B", 2, 4, 10),
                (2, "QA-A", 2, 1, 7), (2, "QA-B", 1, 0, 10)):
        mem.execute("INSERT INTO match_team_results (match_id, team_id, "
                    "placement, kills, adjustment, points) VALUES "
                    "(?, ?, ?, ?, 0, ?)", row)
    mem.commit()
    qa = broadcast.standings_rows(mem, None, include_live=False)
    by_id = {r["teamId"]: r for r in qa}
    order = [r["teamId"] for r in qa]
    report("multi-match totals sum through one engine",
           by_id["QA-A"]["points"] == 20 and by_id["QA-B"]["points"] == 20
           and by_id["QA-A"]["matches"] == 2 and by_id["QA-A"]["wins"] == 1
           and by_id["QA-B"]["wins"] == 1,
           str({k: (by_id[k]["points"], by_id[k]["matches"])
                for k in ("QA-A", "QA-B")}))
    report("placement + finish points feed the tie-breakers",
           by_id["QA-A"]["placementPoints"] == 16
           and by_id["QA-A"]["finishPoints"] == 4
           and by_id["QA-A"]["lastPlacement"] == 2,
           "pp=%s fp=%s last=%s" % (by_id["QA-A"]["placementPoints"],
                                    by_id["QA-A"]["finishPoints"],
                                    by_id["QA-A"]["lastPlacement"]))
    report("a dead tie resolves on last-match placement",
           order.index("QA-B") < order.index("QA-A"), "order=%s" % order)
    mem.close()

    # API round-trip, audit and the CSV exports
    st, d = j("POST", "/api/admin/scoring-rules",
              {"kill_points": 2, "placement": {},
               "tiebreakers": ["finish_points", "last_placement"]},
              headers=T.ah())
    report("tie-breakers + table save round-trips",
           st == 200 and d["rules"]["tiebreakers"] == ["finish_points",
                                                       "last_placement"]
           and d["rules"]["kill_points"] == 2, str(d)[:160])
    report("changed table re-scores through the engine",
           broadcast.compute_points(5, 0, d["rules"]) == 10)
    st, d = j("POST", "/api/admin/scoring-rules",
              {"kill_points": 1, "placement": {}, "tiebreakers": []},
              headers=T.ah())
    report("an empty tie-breaker list is refused",
           st == 400 and "tie-breaker" in json.dumps(d).lower(), str(d)[:160])
    st, d = j("GET", "/api/admin/audit", headers=T.ah())
    report("scoring-rule changes are audited",
           st == 200 and "scoring_rules" in json.dumps(d), str(d)[:120])
    j("POST", "/api/admin/scoring-rules",
      {"kill_points": 1, "placement": default_placement,
       "tiebreakers": ["wins", "placement_points", "finish_points",
                       "last_placement"]}, headers=T.ah())

    st, csv_text = fetch_text("/api/admin/export/standings.csv", T.ah())
    head = csv_text.splitlines()[0] if csv_text else ""
    report("standings CSV uses the engine's table",
           st == 200 and head.startswith("rank,team_id")
           and "tie_breakers" in head and len(csv_text.splitlines()) >= 3,
           "status=%s head=%s" % (st, head[:90]))
    st, _auth = fetch_text("/api/admin/export/standings.csv")
    report("standings CSV is admin-gated", st in (401, 403), "status=%s" % st)
    st, d = j("GET", "/api/admin/matches", headers=T.ah())
    published = [m for m in d.get("matches", [])
                 if m["status"] == "published"]
    st, csv_text = fetch_text(
        "/api/admin/export/match/%d.csv" % published[0]["id"], T.ah())
    head = csv_text.splitlines()[0] if csv_text else ""
    report("match CSV carries placement, finishes and adjustment",
           st == 200 and head.startswith("placement,team_id")
           and "adjustment_reason" in head
           and len(csv_text.splitlines()) == published[0]["team_count"] + 1,
           "status=%s head=%s" % (st, head[:90]))

    # ---------- pushed stat card (caster desk, kept server-side) ----------
    print("\n[caster push]")
    st, d = j("POST", "/api/admin/overlay-settings",
              {"pushedCard": {"player": "TESTER", "teamName": "T",
                              "teamTag": "T", "kills": 9, "damage": 1234}},
              headers=T.ah())
    report("stat card pushed", st == 200, str(d)[:120])
    st, cfg = j("GET", "/api/admin/overlay-settings", headers=T.ah())
    card = cfg.get("pushedCard") or {}
    report("pushed card round-trips to the caster desk",
           st == 200 and card.get("player") == "TESTER", str(cfg)[:160])
    st, d = j("GET", "/api/overlay/state/mvp?token=" + token)
    report("original mvp scene serves the legacy payload",
           st == 200 and isinstance((d.get("state") or {}).get("playerStats"),
                                    dict),
           str(d)[:160])
    j("POST", "/api/admin/overlay-settings", {"pushedCard": None},
      headers=T.ah())
    report("stat card cleared", True)

    # ---------- purge clears broadcast tables ----------
    print("\n[purge]")
    st, d = j("POST", "/api/admin/purge", {"confirm": "PURGE"},
              headers=T.ah())
    report("purge succeeds", st == 200, str(d)[:160])
    with server_conn() as conn:
        counts = {t: conn.execute("SELECT COUNT(*) AS c FROM %s" % t)
                  .fetchone()["c"]
                  for t in ("registrations", "matches", "match_team_results",
                            "player_stats", "event_log")}
    report("purge clears registrations + every broadcast table",
           all(v == 0 for v in counts.values()), str(counts))
    with server_conn() as conn:
        pairs = {r["key"]: r["value"] for r in conn.execute(
            "SELECT key, value FROM overlay_settings")}
    report("purge reseeds overlay settings with a fresh token",
           bool(pairs.get("token")) and len(pairs["token"]) >= 32,
           str(len(pairs.get("token", ""))))
    st, d = j("GET", "/api/live/state")
    report("post-purge live state is empty but healthy",
           st == 200 and d.get("ok") is True and not d.get("overallPublished"),
           str(d)[:160])

    # ---------- teardown ----------
    print("\n[teardown]")
    seed_demo.reset(server, broadcast, "full")
    with server_conn() as conn:
        left = conn.execute("SELECT COUNT(*) AS c FROM matches") \
            .fetchone()["c"]
    report("teardown leaves no demo matches", left == 0, "left=%d" % left)
    T.drop_fixture()
    report("fixture admin removed", True)

    print("\n== %d passed, %d failed ==" % (PASS, FAIL))
    if FAILURES:
        print("\nFailures:")
        for f in FAILURES:
            print("  - %s" % f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
