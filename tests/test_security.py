#!/usr/bin/env python3
"""Security regression tests for the BGMI Cup server.

These are pure unit tests: no HTTP server and no real database.  They cover
the proxy-aware client IP, CSV formula-injection sanitising, input length
caps, the SSE connection limiter and the vendored jsPDF security baseline.

Usage:  python tests/test_security.py
"""

import atexit
import csv
import io
import os
import re
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# Keep the import side-effect free: server reads these paths at import time.
TMP = tempfile.mkdtemp(prefix="bgmi-security-")
os.environ["BGMI_DB"] = os.path.join(TMP, "security.db")
os.environ["BGMI_UPLOADS"] = os.path.join(TMP, "uploads")
atexit.register(shutil.rmtree, TMP, True)

import server  # noqa: E402

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


class FakeHandler:
    """Only the attributes client_ip() reads from a real handler."""

    def __init__(self, peer, headers=None):
        self.client_address = (peer, 45678)
        self.headers = headers or {}


def client_ip(peer, **headers):
    return server.Handler.client_ip(FakeHandler(peer, headers))


def validation_error(fn, *args):
    try:
        fn(*args)
    except server.ValidationError as exc:
        return exc
    except Exception:
        return None
    return None


def main():
    global PASS, FAIL
    print("== BGMI security regression tests ==")

    # ---------- proxy-aware client IP ----------
    print("\n[client IP]")
    report("Railway/private peer uses X-Real-IP",
           client_ip("10.20.30.40", **{"X-Real-IP": "198.51.100.7"})
           == "198.51.100.7")
    report("local cloudflared still uses Cf-Connecting-Ip",
           client_ip("127.0.0.1", **{"Cf-Connecting-Ip": "203.0.113.9"})
           == "203.0.113.9")
    report("loopback peer uses X-Real-IP as a fallback",
           client_ip("127.0.0.1", **{"X-Real-IP": "203.0.113.10"})
           == "203.0.113.10")
    report("public peer cannot spoof X-Real-IP",
           client_ip("8.8.8.8", **{"X-Real-IP": "198.51.100.7"})
           == "8.8.8.8")
    report("invalid X-Real-IP falls back to the peer",
           client_ip("10.20.30.40", **{"X-Real-IP": "not-an-ip"})
           == "10.20.30.40")
    report("X-Real-IP is stripped and canonicalised",
           client_ip("10.20.30.40", **{"X-Real-IP": " 2001:0db8::1 "})
           == "2001:db8::1")

    # ---------- CSV formula injection ----------
    print("\n[csv sanitising]")
    for raw in ("=cmd", "+cmd", "-cmd", "@cmd", "\tcmd", "\rcmd"):
        report("dangerous CSV cell %r is prefixed" % raw,
               server.csv_cell(raw) == "'" + raw,
               repr(server.csv_cell(raw)))
    report("normal CSV cell is unchanged",
           server.csv_cell("Team Alpha") == "Team Alpha")
    report("negative numeric CSV cell is not a formula",
           server.csv_cell(-5) == -5)
    report("empty CSV cell stays empty", server.csv_cell(None) == "")

    body = server.csv_body([
        ["name", "score"],
        ["=2+2", -5],
        ["@SUM(A1)", 3],
    ])
    report("CSV body keeps the Excel-friendly BOM",
           body.startswith(b"\xef\xbb\xbf"))
    rows = list(csv.reader(io.StringIO(body.decode("utf-8-sig"))))
    report("CSV body prefixes a formula in a row",
           len(rows) == 3 and rows[1][0] == "'=2+2", repr(rows))
    report("CSV body leaves negative numbers numeric",
           len(rows) == 3 and rows[1][1] == "-5", repr(rows))
    report("CSV body prefixes every dangerous cell",
           len(rows) == 3 and rows[2][0] == "'@SUM(A1)", repr(rows))

    # ---------- input length caps ----------
    print("\n[input length caps]")
    report("48-character guild accepted",
           server.v_guild("G" * 48) == "G" * 48)
    guild_err = validation_error(server.v_guild, "G" * 49)
    report("49-character guild rejected",
           guild_err is not None and guild_err.field == "guildName",
           repr(guild_err))
    report("254-character email accepted",
           server.v_email("a" * 242 + "@example.com") ==
           "a" * 242 + "@example.com")
    email_err = validation_error(server.v_email, "a" * 243 + "@example.com")
    report("255-character email rejected",
           email_err is not None and email_err.field == "capEmail",
           repr(email_err))

    # ---------- SSE connection limiter ----------
    print("\n[sse limiter]")
    limiter = server.SseLimiter(max_total=2, max_per_ip=1)
    report("first SSE for an IP is accepted", limiter.acquire("a"))
    report("second SSE for the same IP is rejected",
           not limiter.acquire("a"))
    report("another IP can use the remaining global slot",
           limiter.acquire("b"))
    report("global SSE cap is enforced", not limiter.acquire("c"))
    limiter.release("a")
    report("releasing a slot lets the same IP reconnect",
           limiter.acquire("a"))
    limiter.release("a")
    limiter.release("a")            # double release must not free a slot
    report("another IP can still take the freed slot",
           limiter.acquire("c"))
    report("double release did not bypass the global cap",
           not limiter.acquire("d"))

    # ---------- vendored jsPDF baseline ----------
    print("\n[vendored jsPDF]")
    js = os.path.join(ROOT, "public", "assets", "vendor", "jspdf.umd.min.js")
    with open(js, "r", encoding="utf-8", errors="ignore") as fh:
        head = fh.read(4000)
    match = re.search(r"Version\s+(\d+)\.(\d+)\.(\d+)", head)
    found = tuple(int(x) for x in match.groups()) if match else (0, 0, 0)
    report("vendored jsPDF is 4.2.1 or newer",
           found >= (4, 2, 1), "found %s" % ".".join(map(str, found)))

    print("\n== %d passed, %d failed ==" % (PASS, FAIL))
    if FAILURES:
        print("\nFailures:")
        for failure in FAILURES:
            print("  - " + failure)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
