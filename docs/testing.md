# Tests

```powershell
python tests/test_api.py           # 104 checks
python tests/test_admin.py         # 96 checks (waits 61s once for the public lookup bucket)
python tests/test_broadcast.py     # 139 checks (scoring engine, desk, overlays, purge)
python tests/test_flow.py          # admin FLOW workflow-status endpoint + status logic
python tests/test_seed.py          # 41 checks (seed rails, scenarios, backups, env)
npx playwright test                # browser specs (tests/, Chromium; run `npm install` once)
```

One command runs all of the above plus the eleven end-to-end stage scripts in
`tests/e2e/` (each against a freshly seeded throw-away DB): `scripts\verify.bat`
on Windows, `scripts/verify.sh` in bash. Full details and results:
`docs/verification-report.md`.

**Isolation** — with no `BASE` set, each Python suite boots its own throwaway
server on a free port with a temporary database and uploads folder and removes
them on exit; the real `data/registrations.db` cannot be touched and every run
starts from a freshly initialized database (clean rate-limit buckets, default
settings). Point at an already-running server with
`BASE=http://127.0.0.1:8080 python tests/test_api.py` — that mode operates on
the server's configured database, so use it with the temp `BGMI_DB` workflow.

`tests/test_api.py` covers: static serving + traversal probes, friendly URLs, CSRF
(missing/invalid/single-use), every field validator, roster rules, honeypot,
duplicates (409), logo structure validation (CRC/EOI/RIFF/dimension bombs,
declared-vs-actual type) + serving, **security headers**, **concurrent
registration races** (unique team ids/reg codes, same-tag race → one winner),
status `updatedAt` + **byte-identical privacy misses**, **backup/restore
round-trip** (integrity, counts, overwrite guard, not web-served), the
**notification queue** (duplicate collapse, skip-while-SMTP-off, re-enqueue),
**clean-database initialization** (schema, migrations, indexes, fresh
numbering, defaults), session auth (401/403/200), retired token routes, and
HTTP method handling.

`tests/test_admin.py` covers: seed + queue, register→pending, public lookup
(generic misses, 429 budget), edits + audit masking, approve/reject/waitlist/
needs_changes, slot-limit block + override, groups (assign/lock/auto/global
lock), **CSV export auditing**, the public-feed toggle, the typed-confirm
purge guard, **dashboard extras** (`remaining`, notify counts),
**`/schedule` settings round-trip**, **notification queue health + retry**,
**auto-distribute preview (writes nothing) → apply → preserve-on-re-run**,
**same-origin rejection (Origin/Referer 403)**, **session idle + absolute
expiry**, **login throttling (per-account 429, identical 401 bodies)**, and a
teardown that returns the DB to its pre-test state. Its fixtures come from the
demo seed's library API (32 squads in the `mixed` scenario) plus its own
registrations.

`tests/test_broadcast.py` covers: migrations, the scoring engine + tie-breakers,
admin gating, published standings and live state (PII-free), overlay tokens and
SSE fan-out, the full match lifecycle, desk actions (kills, placements,
adjustments, swaps, undo), publish rules, CSV exports and the purge.

`tests/test_flow.py` covers the admin FLOW workflow-status endpoint (auth gate,
counts/statuses/labels only, demo flag) and the pure status logic.
`tests/test_seed.py` runs `scripts/seed_demo.py` as a subprocess against
private temp databases: fresh seed, re-run, `--with-results`, the `mixed`
scenario, the safety rails (stop on real-looking rows, typed confirmation),
backup/restore and the `BGMI_DB_PATH` override.

Playwright specs (`tests/*.spec.js`) drive Chromium against a self-spawned
server: the registration review-step flow, plus a link/asset check that walks
every page, nav/footer link, and internal asset for 404s and console errors.

Rate limiting is verified separately (opt-in):

```powershell
BGMI_RATE_LIMIT_TEST=1 python tests/test_api.py   # asserts the register limiter engages
```
