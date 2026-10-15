#!/usr/bin/env python3
"""
End-to-end API tests for the BGMI Cup registration server.

Usage:  python tests/test_api.py                     (self-hosted, isolated — see below)
        BASE=http://127.0.0.1:8080 python tests/test_api.py   (target a running server)

Isolation: with no BASE set, the suite boots its own throwaway server on a
free port with a temporary database and uploads folder, then removes them on
exit.  Nothing in that mode can touch the real registrations.db, and every
run starts from a freshly initialized database (clean rate-limit buckets and
default settings).  Setting BASE keeps the original workflow: tests hit an
already-running server and operate on its configured database.
"""

import atexit
import base64
import io
import json
import os
import random
import shutil
import socket
import string
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

EXTERNAL = bool(os.environ.get("BASE"))
if not EXTERNAL:
    # temp paths must exist before anything imports `server`, which reads
    # BGMI_DB / BGMI_UPLOADS at import time (test_admin imports seed_demo
    # -> server right after importing this module)
    TMP_ROOT = tempfile.mkdtemp(prefix="bgmi_test_")
    os.environ["BGMI_DB"] = os.path.join(TMP_ROOT, "test.db")
    os.environ["BGMI_UPLOADS"] = os.path.join(TMP_ROOT, "uploads")
    # The suite itself posts ~40 registrations; give it headroom so its own
    # traffic never trips the public limiter.  The limiter stays on (600/hour
    # here) and its engagement is still exercised explicitly via
    # BGMI_RATE_LIMIT_TEST=1, which is left at the default 30.
    if not os.environ.get("BGMI_RATE_LIMIT_TEST"):
        os.environ.setdefault("BGMI_RATE_LIMIT", "600")

BASE = os.environ.get("BASE", "")          # auto mode: set by ensure_server()

# the token auth retired by the approval workflow — asserted dead below
OLD_TOKEN = "zhlTKCAw25b-evtGDiu2_wYf"

PASS = 0
FAIL = 0
FAILURES = []

DB_PATH = os.environ.get("BGMI_DB", os.path.join(ROOT, "data", "registrations.db"))
UPLOADS_DIR = os.environ.get("BGMI_UPLOADS", os.path.join(ROOT, "data", "uploads"))

_SERVER_PROC = None


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _stop_server():
    if _SERVER_PROC and _SERVER_PROC.poll() is None:
        _SERVER_PROC.terminate()
        try:
            _SERVER_PROC.wait(timeout=5)
        except Exception:
            _SERVER_PROC.kill()
    if not EXTERNAL:
        shutil.rmtree(TMP_ROOT, ignore_errors=True)


def ensure_server():
    """Auto mode: boot the isolated test server once and return its base URL.
    External mode (BASE set): returns BASE untouched."""
    global BASE, _SERVER_PROC
    if EXTERNAL or BASE:
        return BASE
    port = _free_port()
    env = dict(os.environ)
    env["PORT"] = str(port)
    env["HOST"] = "127.0.0.1"
    env["BGMI_NOTIFY_POLL"] = "3600"       # keep the worker quiet in tests
    log = open(os.path.join(TMP_ROOT, "server.log"), "w")
    _SERVER_PROC = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "server.py")],
        env=env, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    base = "http://127.0.0.1:%d" % port
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=2) as r:
                if r.status == 200:
                    BASE = base
                    atexit.register(_stop_server)
                    return BASE
        except Exception:
            time.sleep(0.2)
    raise SystemExit("test server did not start (see %s)"
                     % os.path.join(TMP_ROOT, "server.log"))

SESS_COOKIE = ""
SESS_CSRF = ""
FIXTURE_USER = ""
FIXTURE_PW = ""


def report(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  PASS  %s" % name)
    else:
        FAIL += 1
        FAILURES.append(name + (" :: " + detail if detail else ""))
        print("  FAIL  %s  %s" % (name, detail))


def http(method, path, data=None, headers=None, raw=None, ctype=None):
    url = BASE + path
    body = raw
    if data is not None and raw is None:
        body = urllib.parse.urlencode(data).encode()
        ctype = ctype or "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()


def jhttp(method, path, data=None, headers=None, raw=None, ctype=None):
    status, body = http(method, path, data, headers, raw=raw, ctype=ctype)
    try:
        return status, json.loads(body)
    except Exception:
        return status, {"_raw": body[:200].decode("utf-8", "replace")}


import urllib.parse  # noqa: E402  (used inside http())


def csrf():
    _, data = jhttp("GET", "/api/csrf")
    return data.get("token", "")


def rnd(n=6):
    return "".join(random.choice(string.ascii_uppercase + string.digits)
                   for _ in range(n))


def http_h(method, path, data=None, headers=None, raw=None, ctype=None):
    """Like http() but also returns the response headers (for Set-Cookie)."""
    url = BASE + path
    body = raw
    if data is not None and raw is None:
        body = urllib.parse.urlencode(data).encode()
        ctype = ctype or "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)
    except Exception as e:
        return 0, str(e).encode(), {}


# ---- admin session fixture ------------------------------------------------
# Uses BGMI_ADMIN_USER/PASSWORD when provided; otherwise provisions a unique
# throwaway account (random password, deleted at the end of the run) so the
# suite never depends on a committed default credential.


def _db_admin_upsert(user, pw):
    import sqlite3
    import server            # shared scrypt hashing, same project
    h, s = server.hash_password(pw)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        row = conn.execute("SELECT id FROM admin_users WHERE username = ?",
                           (user,)).fetchone()
        if row:
            conn.execute("UPDATE admin_users SET pass_hash = ?, pass_salt = ? "
                         "WHERE id = ?", (h, s, row[0]))
        else:
            conn.execute(
                "INSERT INTO admin_users (username, pass_hash, pass_salt, "
                "created_at) VALUES (?,?,?,?)", (user, h, s, server.now_iso()))
        conn.commit()
    finally:
        conn.close()


def ensure_admin():
    global FIXTURE_USER, FIXTURE_PW
    u = os.environ.get("BGMI_ADMIN_USER", "")
    p = os.environ.get("BGMI_ADMIN_PASSWORD", "")
    if u and p:
        _db_admin_upsert(u, p)
        return u, p, False
    if FIXTURE_USER:
        return FIXTURE_USER, FIXTURE_PW, True
    FIXTURE_USER = "zz_fixture_" + rnd(6).lower()
    FIXTURE_PW = "Fx!" + rnd(24)
    _db_admin_upsert(FIXTURE_USER, FIXTURE_PW)
    return FIXTURE_USER, FIXTURE_PW, True


def drop_fixture():
    if not FIXTURE_USER:
        return
    import sqlite3
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        conn.execute(
            "DELETE FROM admin_sessions WHERE admin_id IN "
            "(SELECT id FROM admin_users WHERE username = ?)", (FIXTURE_USER,))
        conn.execute("DELETE FROM admin_users WHERE username = ?",
                     (FIXTURE_USER,))
        conn.commit()
    finally:
        conn.close()


def ah(extra=None):
    """Admin request headers: session cookie + CSRF token."""
    h = {"Cookie": SESS_COOKIE, "X-Admin-CSRF": SESS_CSRF}
    h.update(extra or {})
    return h


def admin_login():
    global SESS_COOKIE, SESS_CSRF
    user, pw, _ = ensure_admin()
    st, body, hdrs = http_h(
        "POST", "/api/admin/login",
        raw=json.dumps({"username": user, "password": pw}).encode(),
        ctype="application/json")
    try:
        data = json.loads(body)
    except Exception:
        data = {}
    if st == 200:
        SESS_COOKIE = hdrs.get("Set-Cookie", "").split(";")[0]
        SESS_CSRF = data.get("csrf", "")
    return st, data


def squad(tag=None, base_uid=None, **over):
    """Build a valid registration payload."""
    bu = base_uid or random.randint(10000000, 99999999)
    d = {
        "teamName": "Team " + rnd(4),
        "teamTag": tag or rnd(4),
        "guildName": "Guild " + rnd(3),
        "capIgn": "Cap" + rnd(3),
        "capUid": str(bu),
        "capEmail": "cap%d@example.com" % random.randint(1, 99999),
        "capPhone": "98" + str(random.randint(10000000, 99999999)),
        "capDiscord": "",
        "roster": json.dumps([
            {"slot": "P1", "role": "IGL / Captain", "ign": "Cap" + rnd(3), "uid": str(bu)},
        ] + [
            {"slot": "P%d" % i, "role": "Starter",
             "ign": "P%d%s" % (i, rnd(3)), "uid": str(bu + i)}
            for i in (2, 3, 4)
        ]),
    }
    # NOTE: roster P1 ign must match capIgn — fix it up
    r = json.loads(d["roster"])
    r[0]["ign"] = d["capIgn"]
    d["roster"] = json.dumps(r)
    d.update(over)
    return d


CREATED = []        # teamIds this suite registered (cleaned up in main())


def post_reg(payload, token=None, extra_headers=None, raw=None, ctype=None):
    headers = dict(extra_headers or {})
    tok = token if token is not None else csrf()
    if tok:
        headers["X-CSRF-Token"] = tok
    st, data = jhttp("POST", "/api/register", data=None if raw is not None else payload,
                     headers=headers, raw=raw, ctype=ctype)
    if st in (200, 201) and isinstance(data, dict) and data.get("teamId"):
        CREATED.append(data["teamId"])
    return st, data


def png_bytes():
    """Minimal valid 1x1 PNG."""
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
        "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def data_url(raw, mime="image/png"):
    return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode())


def main():
    ensure_server()
    print("== BGMI API test suite @ %s ==" % BASE)

    # ---------- health & static ----------
    print("\n[static & health]")
    st, b = http("GET", "/")
    report("GET / serves the page", st == 200 and b"teamForm" in b)
    st, b = http("GET", "/about")
    report("GET /about -> about.html", st == 200 and b"teamGrid" in b)
    st, b = http("GET", "/about.html")
    report("GET /about.html 200", st == 200 and b"teamGrid" in b)
    st, b = http("GET", "/css/style.css")
    report("GET /css/style.css 200", st == 200 and b":root" in b)
    st, b = http("GET", "/js/bgmi-register.js")
    report("GET /js/bgmi-register.js 200", st == 200)
    st, b = http("GET", "/assets/vendor/qrcode.min.js")
    report("vendor qrcode present", st == 200 and len(b) > 10000)
    st, b = http("GET", "/assets/vendor/jspdf.umd.min.js")
    report("vendor jspdf present", st == 200 and len(b) > 100000)
    st, b = http("GET", "/assets/images/sculptures/caesar.png")
    report("sculpture asset present", st == 200 and b[:4] == b"\x89PNG")
    st, _ = http("GET", "/nope-404.html")
    report("unknown path 404", st == 404)
    st, _ = http("GET", "/server.py")
    report("server.py not served", st == 404)
    st, _ = http("GET", "/registrations.db")
    report("sqlite db not served", st == 404)
    st, _ = http("GET", "/../server.py")
    report("path traversal blocked", st in (404, 400))

    st, data = jhttp("GET", "/api/health")
    report("GET /api/health", st == 200 and data.get("ok") is True)

    # ---------- csrf ----------
    print("\n[csrf]")
    t = csrf()
    report("csrf token issued", bool(t) and len(t) > 20)
    st, data = jhttp("POST", "/api/register", data=squad())
    report("POST without csrf -> 403", st == 403 and data.get("errorCode") == "csrf")

    # ---------- validation ----------
    print("\n[validation]")
    st, data = post_reg(squad(teamName="AB"))
    report("short team name rejected", st == 400 and data.get("field") == "teamName")

    st, data = post_reg(squad(teamTag="X"))
    report("1-char tag rejected", st == 400 and data.get("field") == "teamTag")

    st, data = post_reg(squad(teamTag="toolong"))
    report("7-char tag rejected", st == 400 and data.get("field") == "teamTag")

    st, data = post_reg(squad(capEmail="not-an-email"))
    report("bad email rejected", st == 400 and data.get("field") == "capEmail")

    st, data = post_reg(squad(capPhone="12345"))
    report("short phone rejected", st == 400 and data.get("field") == "capPhone")

    st, data = post_reg(squad(capPhone="+91 9876543210"))
    report("+91 phone accepted", st in (200, 201), "status=%s body=%s" % (st, data))

    st, data = post_reg(squad(capUid="abc"))
    report("non-numeric captain uid rejected", st == 400 and data.get("field") == "capUid")

    st, data = post_reg(squad(capDiscord="bad handle!"))
    report("bad discord handle rejected", st == 400 and data.get("field") == "capDiscord")

    # roster: too few starters
    p = squad()
    p["roster"] = json.dumps(json.loads(p["roster"])[:2])
    st, data = post_reg(p)
    report("2-player roster rejected", st == 400)

    # roster: bad uid on P3
    p = squad()
    r = json.loads(p["roster"])
    r[2]["uid"] = "12"
    p["roster"] = json.dumps(r)
    st, data = post_reg(p)
    report("short player uid rejected", st == 400)

    # roster: malformed json
    p = squad()
    p["roster"] = "{not json"
    st, data = post_reg(p)
    report("malformed roster json rejected", st == 400)

    # roster: duplicate uid within squad
    p = squad()
    r = json.loads(p["roster"])
    r[2]["uid"] = r[0]["uid"]
    p["roster"] = json.dumps(r)
    st, data = post_reg(p)
    report("intra-squad duplicate uid rejected", st == 400 and "twice" in data.get("error", ""))

    # roster: duplicate ign within squad
    p = squad()
    r = json.loads(p["roster"])
    r[2]["ign"] = r[1]["ign"]
    p["roster"] = json.dumps(r)
    st, data = post_reg(p)
    report("intra-squad duplicate ign rejected", st == 400 and "registered twice" in data.get("error", ""))

    # partial sub
    p = squad()
    r = json.loads(p["roster"])
    r.append({"slot": "S1", "role": "Substitute", "ign": "SubX", "uid": ""})
    p["roster"] = json.dumps(r)
    st, data = post_reg(p)
    report("partial sub row rejected", st == 400)

    # 3 subs
    p = squad()
    r = json.loads(p["roster"])
    bu = int(p["capUid"])
    for i in range(3):
        r.append({"slot": "S%d" % (i + 1), "role": "Substitute",
                  "ign": "Sub%d" % i, "uid": str(bu + 100 + i)})
    p["roster"] = json.dumps(r)
    st, data = post_reg(p)
    report("3 subs rejected", st == 400)

    # ---------- honeypot / rate ----------
    print("\n[abuse controls]")
    p = squad()
    p["company"] = "SpamBot Inc"
    st, data = post_reg(p)
    report("honeypot filled -> 403", st == 403)

    # ---------- happy paths ----------
    print("\n[registration happy paths]")
    p = squad()
    st, data = post_reg(p)
    ok1 = st in (200, 201) and data.get("ok") is True
    report("valid squad registers", ok1, "status=%s body=%s" % (st, data))
    tid1 = data.get("teamId", "")
    report("team id format CSM-BG-XXXX", tid1.startswith("CSM-BG-") and len(tid1) == 11)

    # duplicate tag (same tag, different case)
    p2 = squad(tag=p["teamTag"].lower())
    st, data = post_reg(p2)
    report("duplicate tag -> 409", st == 409 and data.get("field") == "teamTag")

    # rejected registration must not orphan its logo file on disk
    updir = UPLOADS_DIR
    before = set(os.listdir(updir)) if os.path.isdir(updir) else set()
    p_orph = squad(tag=p["teamTag"].upper())
    p_orph["logoDataUrl"] = data_url(png_bytes())
    st, data = post_reg(p_orph)
    after = set(os.listdir(updir)) if os.path.isdir(updir) else set()
    report("rejected registration leaves no orphan logo",
           st == 409 and after == before, "status=%s delta=%s" % (st, after - before))

    # duplicate uid across squads
    p3 = squad()
    r = json.loads(p3["roster"])
    r[1]["uid"] = p["capUid"]
    p3["roster"] = json.dumps(r)
    st, data = post_reg(p3)
    report("cross-squad duplicate uid -> 409",
           st == 409 and "already on squad" in data.get("error", ""),
           "status=%s body=%s" % (st, data))

    # with logo
    p4 = squad()
    p4["logoDataUrl"] = data_url(png_bytes())
    st, data = post_reg(p4)
    ok4 = st in (200, 201) and data.get("ok")
    report("registration with logo", ok4, "status=%s body=%s" % (st, data))
    tid_logo = data.get("teamId", "")
    logo_path = data.get("logoPath") or ""
    report("logo path returned", logo_path.startswith("/uploads/"))
    if logo_path:
        st2, b2 = http("GET", logo_path)
        report("logo file served", st2 == 200 and b2[:4] == b"\x89PNG")

    # fake png (bad magic)
    p5 = squad()
    p5["logoDataUrl"] = data_url(b"GIF89a" + b"\x00" * 30, "image/png")
    st, data = post_reg(p5)
    report("logo magic mismatch rejected", st == 400, "status=%s body=%s" % (st, data))

    # oversized logo (>2MB)
    p6 = squad()
    big = b"\x89PNG\r\n\x1a\n" + os.urandom(2 * 1024 * 1024 + 100)
    p6["logoDataUrl"] = data_url(big)
    st, data = post_reg(p6)
    report("oversized logo rejected", st == 400, "status=%s body=%s" % (st, data))

    # with subs
    p7 = squad()
    r = json.loads(p7["roster"])
    bu = int(p7["capUid"])
    r.append({"slot": "S1", "role": "Substitute", "ign": "BenchOne", "uid": str(bu + 500)})
    r.append({"slot": "S2", "role": "Substitute", "ign": "BenchTwo", "uid": str(bu + 501)})
    p7["roster"] = json.dumps(r)
    st, data = post_reg(p7)
    report("squad with 2 subs registers", st in (200, 201), "status=%s body=%s" % (st, data))

    # ---------- admin gate (session login replaced the old token) ----------
    print("\n[admin]")
    # the retired token routes stay closed for good
    st, data = jhttp("GET", "/api/registrations")
    report("old admin route closed", st != 200, "status=%s" % st)
    st, data = jhttp("GET", "/api/registrations?token=" + OLD_TOKEN)
    report("old token no longer works", st != 200, "status=%s" % st)
    st, data = jhttp("DELETE", "/api/registrations?token=%s&teamId=%s"
                     % (OLD_TOKEN, tid1))
    report("old delete route -> 405", st == 405, "status=%s" % st)

    # /admin serves the login gate when logged out
    st, b = http("GET", "/admin")
    report("GET /admin (logged out) shows login", st == 200 and b"loginForm" in b)

    # admin APIs refuse anonymous callers
    st, data = jhttp("GET", "/api/admin/registrations")
    report("admin API without session -> 401", st == 401, "status=%s" % st)
    st, data = jhttp("POST", "/api/admin/registrations/%s/status" % tid1,
                     raw=json.dumps({"status": "approved"}).encode(),
                     ctype="application/json")
    report("admin POST without session -> 401", st == 401, "status=%s" % st)

    # wrong password
    user, pw, is_fixture = ensure_admin()
    st, body, _ = http_h(
        "POST", "/api/admin/login",
        raw=json.dumps({"username": user, "password": "definitely-wrong-1"}).encode(),
        ctype="application/json")
    report("login with wrong password -> 401", st == 401, "status=%s" % st)

    st, data = admin_login()
    report("login with fixture account", st == 200 and data.get("ok") and bool(SESS_COOKIE),
           "status=%s body=%s" % (st, data))

    st, b = http("GET", "/admin", headers={"Cookie": SESS_COOKIE})
    report("GET /admin (logged in) serves the panel", st == 200 and b"queueBody" in b)

    st, data = jhttp("GET", "/api/admin/me", headers={"Cookie": SESS_COOKIE})
    report("/api/admin/me identifies admin",
           st == 200 and data.get("username") == user)

    st, data = jhttp("GET", "/api/admin/registrations", headers={"Cookie": SESS_COOKIE})
    regs = data.get("registrations", [])
    report("admin queue with session", st == 200 and len(regs) >= 4,
           "status=%s n=%s" % (st, len(regs)))
    if regs:
        one = regs[0]
        report("registration has roster",
               isinstance(one.get("roster"), list) and len(one["roster"]) >= 4)
        report("captain email stored", "@" in (one.get("cap_email") or ""))
        report("every row carries a status",
               all((r.get("status") or "") in
                   ("pending", "approved", "rejected", "waitlisted", "needs_changes")
                   for r in regs))
        report("queue reports per-status counts",
               isinstance(data.get("counts"), dict) and "approved" in data["counts"])
        report("queue reports slot limit", isinstance(data.get("slot_limit"), int))

    # CSRF: a session cookie alone is not enough for writes
    st, data = jhttp("PUT", "/api/admin/registrations/" + tid1,
                     headers={"Cookie": SESS_COOKIE},
                     raw=json.dumps({"teamName": "NoCSRF Team"}).encode(),
                     ctype="application/json")
    report("admin write without CSRF -> 403", st == 403, "status=%s" % st)

    # delete single (session + CSRF)
    st, data = jhttp("DELETE", "/api/admin/registrations/" + tid1, headers=ah())
    report("admin delete single team", st == 200 and data.get("ok"),
           "status=%s body=%s" % (st, data))
    st, data = jhttp("GET", "/api/admin/registrations", headers={"Cookie": SESS_COOKIE})
    gone = all(r.get("team_id") != tid1 for r in data.get("registrations", []))
    report("deleted team gone", gone)

    # deleting a squad must remove its uploaded logo too (no orphan file)
    if tid_logo and logo_path:
        fpath = os.path.join(updir, os.path.basename(logo_path))
        existed = os.path.isfile(fpath)
        st, data = jhttp("DELETE", "/api/admin/registrations/" + tid_logo,
                         headers=ah())
        file_gone = not os.path.isfile(fpath)
        st2, _ = http("GET", logo_path)
        report("delete removes orphaned logo file",
               existed and st == 200 and file_gone and st2 == 404,
               "existed=%s del=%s file_gone=%s get=%s"
               % (existed, st, file_gone, st2))

    # logout invalidates the session
    st, data = jhttp("POST", "/api/admin/logout", headers=ah(),
                     raw=b"{}", ctype="application/json")
    report("logout succeeds", st == 200 and data.get("ok"), "status=%s" % st)
    st, data = jhttp("GET", "/api/admin/me", headers={"Cookie": SESS_COOKIE})
    report("session dead after logout", st == 401, "status=%s" % st)
    st, data = admin_login()
    report("re-login after logout", st == 200, "status=%s" % st)

    # ---------- methods ----------
    print("\n[methods]")
    st, _ = jhttp("PUT", "/api/register")
    report("PUT /api/register -> 405", st == 405)
    st, _ = jhttp("POST", "/api/nope")
    report("POST unknown path -> 404", st == 404)

    # ---------- rate limit ----------
    # Runs only when explicitly requested, since the main server usually
    # runs with a high limit:  BGMI_RATE_LIMIT_TEST=1 python tests/test_api.py
    if os.environ.get("BGMI_RATE_LIMIT_TEST"):
        print("\n[rate limit]")
        got429 = False
        for _ in range(15):
            st, data = post_reg(squad())
            if st == 429:
                got429 = True
                break
        report("rate limit engages within 15 posts", got429)

    RATE_PROBE = bool(os.environ.get("BGMI_RATE_LIMIT_TEST"))

    # ---------- security headers ----------
    print("\n[security headers]")
    st, body, hdrs = http_h("GET", "/")
    report("static page sends X-Content-Type-Options: nosniff",
           (hdrs.get("X-Content-Type-Options") or "").lower() == "nosniff",
           repr(hdrs.get("X-Content-Type-Options")))
    report("static page sends Referrer-Policy",
           bool(hdrs.get("Referrer-Policy")),
           repr(hdrs.get("Referrer-Policy")))
    st, body, hdrs = http_h("GET", "/api/health")
    report("JSON responses send nosniff",
           (hdrs.get("X-Content-Type-Options") or "").lower() == "nosniff")
    st, body, hdrs = http_h("GET", "/ghost-" + rnd(5))
    report("themed 404 still sends nosniff",
           st == 404 and
           (hdrs.get("X-Content-Type-Options") or "").lower() == "nosniff",
           "status=%s" % st)

    # ---------- traversal / server internals ----------
    print("\n[path safety]")
    probes = ["/server.py", "/registrations.db", "/test_api.py", "/.env",
              "/%2e%2e/server.py", "/js/%2e%2e/%2e%2e/server.py",
              "/uploads/%2e%2e/%2e%2e/registrations.db",
              "/uploads/..%2f..%2fserver.py"]
    leaked = []
    for probe in probes:
        st, body = http("GET", probe)
        if st != 404 or b"Traceback" in body or b"SQLite format" in body:
            leaked.append("%s -> %s" % (probe, st))
    report("internals and traversal probes all 404",
           not leaked, "; ".join(leaked))
    st, body = http("GET", "/js/status.js")
    report("legit static asset still served",
           st == 200 and len(body) > 100, "status=%s len=%d" % (st, len(body)))
    st, body = http("GET", "/uploads/ghost-" + rnd(5) + ".png")
    report("uploads route 404 for unknown file", st == 404, "status=%s" % st)

    # ---------- structural upload validation ----------
    if RATE_PROBE:
        print("\n[upload structure]  (skipped: BGMI_RATE_LIMIT_TEST run)")
    else:
        print("\n[upload structure]")

        def _sof(w, h):
            # SOF0: length = 2 len-bytes + precision + h + w + ncomp + 3*ncomp
            return (b"\xff\xc0" + (11).to_bytes(2, "big") + b"\x08" +
                    h.to_bytes(2, "big") + w.to_bytes(2, "big") +
                    b"\x01\x11\x00")

        app0 = (b"\xff\xe0" + (16).to_bytes(2, "big") +
                b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
        good_jpg = b"\xff\xd8" + app0 + _sof(64, 64) + b"\xff\xd9"
        bad_crc = bytearray(png_bytes())
        bad_crc[16] ^= 0xFF                  # flips an IHDR byte -> CRC fails
        vp8x = (b"VP8X" + (10).to_bytes(4, "little") +
                b"\x00\x00\x00\x00" +
                (9999).to_bytes(3, "little") + (9999).to_bytes(3, "little"))
        huge_webp = (b"RIFF" + (4 + len(vp8x)).to_bytes(4, "little") +
                     b"WEBP" + vp8x)
        bad_riff = (b"RIFF" + (0x7FFFFFF0).to_bytes(4, "little") +
                    b"WEBP" + b"VP8 " + b"\x00" * 20)
        struct_cases = [
            ("PNG with a broken IHDR CRC rejected",
             data_url(bytes(bad_crc)), (400,)),
            ("PNG missing its IEND chunk rejected",
             data_url(png_bytes()[:-12]), (400,)),
            ("JPEG with a 9000px frame rejected",
             data_url(b"\xff\xd8" + _sof(9000, 9000) + b"\xff\xd9",
                      "image/jpeg"), (400,)),
            ("JPEG without an EOI marker rejected",
             data_url(b"\xff\xd8" + _sof(64, 64), "image/jpeg"), (400,)),
            ("WebP with a lying RIFF size rejected",
             data_url(bad_riff, "image/webp"), (400,)),
            ("WebP with a 10000px canvas rejected",
             data_url(huge_webp, "image/webp"), (400,)),
            ("JPEG bytes declared as png rejected",
             data_url(png_bytes(), "image/jpeg"), (400,)),
            ("structurally valid JPEG accepted",
             data_url(good_jpg, "image/jpeg"), (200, 201)),
        ]
        for name, url, want in struct_cases:
            ps = squad()
            ps["logoDataUrl"] = url
            st, data = post_reg(ps)
            report(name, st in want, "status=%s body=%s" % (st, data))

    # ---------- concurrency (BEGIN IMMEDIATE allocation) ----------
    if RATE_PROBE:
        print("\n[concurrency]  (skipped: BGMI_RATE_LIMIT_TEST run)")
    else:
        print("\n[concurrency]")
        import threading
        slots = [None] * 4

        def _race(i):
            try:
                slots[i] = post_reg(squad())
            except Exception as e:           # never let a thread crash main
                slots[i] = (0, {"error": str(e)})

        ths = [threading.Thread(target=_race, args=(i,)) for i in range(4)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        ok_ids = [d.get("teamId") for s, d in slots if s in (200, 201)]
        ok_codes = [d.get("regCode") for s, d in slots if s in (200, 201)]
        report("4 parallel registrations all succeed",
               len(ok_ids) == 4, "statuses=%s" % [s for s, _ in slots])
        report("parallel team ids are unique",
               len(set(ok_ids)) == 4 and None not in ok_ids, str(ok_ids))
        report("parallel reg codes are unique",
               len(set(ok_codes)) == 4 and None not in ok_codes,
               str(ok_codes))

        same_tag = rnd(4)                      # tags are 2-5 chars
        race = [None, None]

        def _dup(i):
            race[i] = post_reg(squad(tag=same_tag))

        dths = [threading.Thread(target=_dup, args=(i,)) for i in range(2)]
        for t in dths:
            t.start()
        for t in dths:
            t.join()
        rstats = sorted(s for s, _ in race)
        report("same-tag race: exactly one wins, loser gets 409",
               rstats == [201, 409] or rstats == [200, 409],
               "statuses=%s" % rstats)

    # ---------- status lookup: updatedAt + privacy ----------
    if RATE_PROBE:
        print("\n[status lookup]  (skipped: BGMI_RATE_LIMIT_TEST run)")
    else:
        print("\n[status lookup]")
        ps = squad()
        st, dreg = post_reg(ps)
        code_s = dreg.get("regCode", "")
        st, d1 = jhttp("POST", "/api/status/lookup",
                       raw=json.dumps({"regCode": code_s,
                                       "hint": ps["capPhone"]}).encode(),
                       ctype="application/json")
        upd = (d1.get("updatedAt") or "") if isinstance(d1, dict) else ""
        valid_ts = False
        if upd:
            try:
                time.strptime(upd[:19].replace("T", " "), "%Y-%m-%d %H:%M:%S")
                valid_ts = True
            except ValueError:
                valid_ts = False
        report("lookup carries an updatedAt timestamp",
               st == 200 and d1.get("found") and valid_ts,
               "status=%s updatedAt=%r" % (st, upd))

        wrong_hint = ps["capPhone"][:-1] + str(
            (int(ps["capPhone"][-1]) + 1) % 10)
        st_a, da = jhttp("POST", "/api/status/lookup",
                         raw=json.dumps({"regCode": "BGMI26-" + rnd(4),
                                         "hint": ps["capPhone"]}).encode(),
                         ctype="application/json")
        st_b, dbd = jhttp("POST", "/api/status/lookup",
                          raw=json.dumps({"regCode": code_s,
                                          "hint": wrong_hint}).encode(),
                          ctype="application/json")
        report("status misses are byte-identical (wrong code vs wrong hint)",
               st_a == 404 and st_b == 404 and da == dbd,
               "a=%s b=%s" % (da, dbd))

    # ---------- backup / restore round-trip ----------
    print("\n[backup / restore]")
    import sqlite3
    import scripts.backup_db as bmod
    import scripts.restore_db as rmod
    bdir = tempfile.mkdtemp(prefix="bgmi_bak_")
    try:
        out = os.path.join(bdir, "copy.db")
        path = bmod.backup(src=DB_PATH, out=out, keep=0)
        report("backup written where asked",
               path == out and os.path.isfile(out), "path=%s" % path)
        con = sqlite3.connect(out)
        integ = con.execute("PRAGMA integrity_check").fetchone()[0]
        n_copy = con.execute(
            "SELECT COUNT(*) FROM registrations").fetchone()[0]
        con.close()
        con = sqlite3.connect(DB_PATH)
        n_src = con.execute(
            "SELECT COUNT(*) FROM registrations").fetchone()[0]
        con.close()
        report("backup is intact and matches the source row count",
               integ == "ok" and n_copy == n_src,
               "integ=%s copy=%s src=%s" % (integ, n_copy, n_src))
        st, h = jhttp("GET", "/api/health")
        report("live server unaffected by the backup",
               st == 200 and h.get("count") == n_src,
               "status=%s count=%s" % (st, h.get("count")))

        tgt = os.path.join(bdir, "restored.db")
        rmod.restore(out, target=tgt)
        con = sqlite3.connect(tgt)
        n_rest = con.execute(
            "SELECT COUNT(*) FROM registrations").fetchone()[0]
        con.close()
        report("restore reproduces every row",
               os.path.isfile(tgt) and n_rest == n_copy,
               "restored=%s copy=%s" % (n_rest, n_copy))
        try:
            rmod.restore(out, target=tgt)    # exists, no --overwrite
            refused = False
        except SystemExit:
            refused = True
        report("restore refuses to clobber without overwrite", refused)
        up = os.path.realpath(UPLOADS_DIR)
        bk = os.path.realpath(bmod.BACKUP_DIR)
        report("backup folder is outside the uploads tree",
               not (bk == up or bk.startswith(up + os.sep)), bk)
        st, body = http("GET", "/backups/copy.db")
        report("backup files are not web-served (.db blocked)",
               st == 404, "status=%s" % st)
    finally:
        shutil.rmtree(bdir, ignore_errors=True)

    # ---------- durable notification queue ----------
    if EXTERNAL:
        print("\n[notification queue]  (skipped with BASE: needs isolated DB)")
    elif RATE_PROBE:
        print("\n[notification queue]  (skipped: BGMI_RATE_LIMIT_TEST run)")
    else:
        print("\n[notification queue]")
        import server as srv
        ps = squad()
        st, dq = post_reg(ps)
        qt = dq.get("teamId", "")

        def _qcount(status):
            c = srv.db()
            try:
                return c.execute(
                    "SELECT COUNT(*) FROM notification_queue "
                    "WHERE team_id = ? AND status = ?",
                    (qt, status)).fetchone()[0]
            finally:
                c.close()

        c = srv.db()
        try:
            srv.enqueue_notification(c, qt, "status")
            srv.enqueue_notification(c, qt, "status")   # duplicate collapses
            c.commit()
            pend = c.execute(
                "SELECT COUNT(*) FROM notification_queue WHERE team_id = ? "
                "AND status = 'pending'", (qt,)).fetchone()[0]
        finally:
            c.close()
        report("duplicate enqueue collapses to one pending job",
               pend == 1, "pending=%s" % pend)

        handled = srv.process_notification_queue()
        report("worker pass handles the pending job",
               isinstance(handled, int) and handled >= 1,
               "handled=%r" % (handled,))
        report("unconfigured SMTP marks jobs skipped, not failed",
               _qcount("skipped") == 1 and _qcount("pending") == 0,
               "skipped=%s pending=%s"
               % (_qcount("skipped"), _qcount("pending")))

        c = srv.db()
        try:
            srv.enqueue_notification(c, qt, "status")
            c.commit()
        finally:
            c.close()
        report("a later change enqueues a fresh job after the skip",
               _qcount("pending") == 1, "pending=%s" % _qcount("pending"))

    # ---------- clean-database initialization ----------
    print("\n[database init]")
    import server as srv
    old_db_path = srv.DB_PATH
    init_dir = tempfile.mkdtemp(prefix="bgmi_init_")
    fresh = os.path.join(init_dir, "fresh.db")
    srv.DB_PATH = fresh
    core_tables = {"registrations", "roster_members", "groups",
                   "admin_users", "admin_sessions", "settings",
                   "notification_queue", "audit_log"}
    try:
        srv.init_db()
        srv.init_db()                          # idempotent on existing schema
        con = srv.db()
        try:
            reg_cols = {r["name"] for r in con.execute(
                "PRAGMA table_info(registrations)")}
            sess_cols = {r["name"] for r in con.execute(
                "PRAGMA table_info(admin_sessions)")}
            tables = {r["name"] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")}
            idx_sql = [((r["name"] or "") + " " + (r["sql"] or ""))
                       for r in con.execute(
                           "SELECT name, sql FROM sqlite_master "
                           "WHERE type = 'index'")]
            fresh_code = srv.next_reg_code(con)
            fresh_tz = srv.get_setting(con, "timezone", "")
            fresh_sched = srv.get_setting(con, "schedule_note", "")
        finally:
            con.close()
    finally:
        srv.DB_PATH = old_db_path
        shutil.rmtree(init_dir, ignore_errors=True)
    report("clean init builds every core table",
           core_tables <= tables,
           "missing=%s" % sorted(core_tables - tables))
    report("migrated columns exist on a fresh schema",
           "reg_code" in reg_cols and "status" in reg_cols
           and "last_seen" in sess_cols,
           "reg=%s sess=%s" % (sorted(reg_cols), sorted(sess_cols)))
    report("reg_code uniqueness index exists",
           any("reg_code" in s for s in idx_sql), str(idx_sql))
    report("fresh database numbers from BGMI26-0001",
           fresh_code == "BGMI26-0001", fresh_code)
    report("schedule settings seeded with defaults",
           fresh_tz == "Asia/Kolkata" and fresh_sched == "",
           "tz=%r sched=%r" % (fresh_tz, fresh_sched))

    # ---------- cleanup ----------
    # remove every team this suite registered so runs never leave test
    # registrations behind in the real database; the throwaway admin
    # account is removed as well
    st, data = admin_login()
    for tid in CREATED:
        jhttp("DELETE", "/api/admin/registrations/" + tid, headers=ah())
    jhttp("POST", "/api/admin/logout", headers=ah(),
          raw=b"{}", ctype="application/json")
    drop_fixture()

    print("\n== %d passed, %d failed ==" % (PASS, FAIL))
    if FAILURES:
        print("Failures:")
        for f in FAILURES:
            print("  - " + f)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
