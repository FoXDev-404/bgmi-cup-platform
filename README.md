# BGMI Cup Noida 2026 — Team Registration (fullstack)

Competitive BGMI squad-registration page matching the CyberSec India theme,
backed by a dependency-free Python server with SQLite persistence and a full
registration **approval workflow**.

## Run

```powershell
# 1. create your admin account (prompts for username/password; no default exists)
$env:BGMI_ADMIN_USER='admin'; $env:BGMI_ADMIN_PASSWORD='choose-a-strong-password'
python scripts/create_admin.py        # cmd.exe: set BGMI_ADMIN_USER=... && ...

# 2. take a first backup of the live database (see Backup below)
python scripts/backup_db.py

# 3. start the server
python server.py                      # http://127.0.0.1:8080
```

Open `http://127.0.0.1:8080/` (registration), `/status` (public status check),
`/teams` (approved grid), `/rules`, `/schedule`, `/about`
or `/admin` (Control Room login). No pip installs — Python 3 stdlib only.

## Files

| Path | Purpose |
|---|---|
| `bgmi-team-registration.html` | Registration page (hero, countdown, rules, form, review step, confirmation with Reg ID) |
| `status.html` | Public "Check your status" page (Reg ID + captain phone/email, last-updated + next steps) |
| `teams.html` | Public approved-teams grid with search + group filter (off unless enabled in Settings) |
| `rules.html` | `/rules` — curated house rules, tournament config, format, fair play (same text as registration) |
| `schedule.html` | `/schedule` — settings-driven day-of schedule + timezone + last-updated (gated with `/teams`) |
| `admin.html` | Control Room — session login, queue, team detail, groups, audit, notifications, settings |
| `about.html` | About page (Who we are + team cards), served at `/about` too |
| `privacy.html` | Privacy note page (footer-linked) |
| `404.html` | Themed not-found page |
| `css/style.css` | Theme stylesheet copied verbatim from the original site |
| `css/bgmi-register.css` | Page-specific styles (roster rows, dropzone, subs, review step, confirmation) |
| `css/admin.css` / `css/status.css` / `css/teams.css` | Control Room, status and teams styles |
| `js/bgmi-register.js` | Client validation, roster/subs, logo upload, **review step + submit guard**, squad-pass PDF/QR |
| `js/panel.js` | Control Room logic (queue, bulk counts, groups preview, notifications, audit, settings) |
| `js/status.js` | Status lookup + request-changes form + next-steps line |
| `js/about.js` | `TEAM` config array + card rendering + photo-missing fallback |
| `server.py` | Static file server + JSON API + SQLite storage + notification worker |
| `scripts/create_admin.py` | Create/rotate an admin account (scrypt-hashed) |
| `scripts/seed_demo.py` | Optional ~20 demo registrations + groups for UI rehearsal |
| `scripts/backup_db.py` | Consistent online backup of `registrations.db` (integrity-checked) |
| `scripts/restore_db.py` | Restore a backup (temp file + atomic replace, `--overwrite` guard) |
| `test_api.py` | End-to-end API suite (104 checks, self-hosted + isolated by default) |
| `test_admin.py` | Approval-workflow suite (94 checks, includes a 61s rate-limit wait) |
| `assets/vendor/` | qrcode + jsPDF (for squad-pass PDF/QR) |
| `public/team/` | Team photos read by the About page (`fe_psycho.png` etc.) |
| `uploads/` | Saved team logos (created on demand) |
| `backups/` | `backup_db.py` output (outside `uploads/`; `.db` files are never served) |
| `registrations.db` | SQLite database (created on first run) |

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, count}` |
| GET | `/api/csrf` | — | Issues short-lived, IP-bound CSRF token |
| POST | `/api/register` | CSRF | Registers a squad; returns `{ok, teamId, regCode}` |
| POST | `/api/status/lookup` | rate-limited | `{regCode, hint}` → own status only (5/min/IP), includes `updatedAt` |
| POST | `/api/status/request-change` | rate-limited | Team asks for a correction (same bucket) |
| GET | `/api/public/approved` | setting | Names/tags/logos/groups only — 404 unless enabled |
| GET | `/api/public/schedule` | setting | Schedule text + timezone + updatedAt — 404 unless the teams feed is on |
| POST | `/api/admin/login` | rate-limited | Session cookie (httpOnly, SameSite) + CSRF token |
| GET | `/api/admin/registrations` | session | Queue: search/status/sort/counts/slot info/`remaining`/`notify`/conflicts |
| POST | `/api/admin/registrations/<id>/status` | session + CSRF | approve/reject/waitlist/needs_changes (+override) |
| PUT | `/api/admin/registrations/<id>` | session + CSRF | Edit team/captain/roster (audited, PII-masked) |
| GET/POST | `/api/admin/notifications` (+ `/retry`) | session + CSRF | Queue health (counts, failures without addresses), requeue failed jobs |
| * | `/api/admin/groups…`, `/settings`, `/export/*.csv`, `/purge`, `/audit` | session + CSRF | Groups, settings, CSV exports, typed-confirm purge, audit log |

`POST /api/register` mirrors the client validators server-side (team/tag/guild,
captain fields, 4 starters + 0–2 subs, unique UIDs and IGNs), rejects honeypot
spam, enforces a per-IP rate limit, validates logo **structure** (PNG chunk/CRC
walk, JPEG marker walk, WebP container; magic vs. declared type must agree;
≤ 2 MB, ≤ 8000 px/side, ≤ 40 MP) and writes duplicates as HTTP 409. Team IDs
(`CSM-BG-XXXX`) and Reg IDs (`BGMI26-NNNN`) are allocated by the **server**
inside a `BEGIN IMMEDIATE` transaction, so concurrent submissions can never
collide.

## Security

- **Sessions** — `bgmi_admin` cookie is httpOnly/SameSite, stored hashed.
  Two lifetimes apply: an **absolute cap** (`BGMI_SESSION_TTL`, default 14 d)
  and an **idle timeout** (`BGMI_SESSION_IDLE_TTL`, default 8 h) that revokes
  an untouched session on its next request.
- **Login throttle** — per-IP (10/5 min) *and* per-username (5 failures/5 min,
  cleared on success), plus a dummy scrypt for unknown users so response times
  don't reveal whether an account exists. Failure messages never distinguish
  "no such user" from "wrong password".
- **Same-origin writes** — every state-changing admin request checks
  `Origin`/`Referer` against `Host` (403 on mismatch); CSRF tokens remain
  required on top of that.
- **Headers** — `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  strict-origin-when-cross-origin` on every response.
- **Path safety** — `.py/.db/.db-wal/.db-shm/.pyc`, dotfiles and `..` escapes
  are blocked; `uploads/` resolves only inside `BGMI_UPLOADS`.
- **Privacy** — `/status` misses are byte-identical regardless of whether the
  Reg ID or the hint was wrong; notification/queue payloads carry team ids, not
  addresses; exports are recorded in the audit log.
- **Integrity** — multi-statement admin writes run in `BEGIN IMMEDIATE`
  transactions; rejected registrations can never leave orphan logo files.

## Approval workflow

Every registration starts **pending**. The Control Room (`/admin`) provides:

- **Queue** — status chips with counts, search, sort, duplicate warnings,
  bulk approve/reject (**the confirm dialog states exactly how many teams are
  affected** and the result line reports updated vs. failed), per-row actions.
- **Slot limit** — "Approved X/16 · N left" blocks further approvals unless
  explicitly overridden (limit configurable in Settings).
- **Team detail** — edit fields, roster editor, schedule note (shown on
  `/status`), admin-only notes, per-team audit history.
- **Groups** — create/size/lock, assign approved teams only, and a
  re-runnable auto-distribute that **previews the full plan first**
  (nothing is written until you confirm). Default runs preserve existing and
  locked placements and only fill unplaced teams; type `R` at the prompt to
  rebuild/reshuffle. Re-runs report `moved`.
- **Notifications** — status/group/schedule changes enqueue a durable job in
  SQLite (`notification_queue`). A worker thread sends mail with exponential
  backoff (`BGMI_NOTIFY_ATTEMPTS` tries, then parks as *failed*), SMTP
  unconfigured → *skipped*. The dashboard shows pending/failed counts and a
  **Retry queue** button; e-mail is only a supplement — `/status` always
  updates instantly.
- **Audit log** — who changed what, when (logins, edits, exports, setting and
  schedule changes included); e-mail/phone values masked.
- **Exports** — approved-team CSV, groups CSV, printable group sheet.
- **Purge** — destructive reset guarded by typing the exact confirmation word.

## Public pages

- **`/status`** — Reg ID + captain phone/email lookup with generic misses,
  last-updated timestamp, per-status next-steps line, change requests.
- **`/teams`** (when enabled) — approved names/tags/logos/groups only, with a
  live **search box and group filter**; all values HTML-escaped, logos
  restricted to the server-generated `/uploads/` path.
- **`/rules`** — the curated house rules/format/fair-play text (same content
  shown during registration, no invented policies).
- **`/schedule`** (when the teams feed is enabled) — schedule note published
  from Settings, timezone label, last-updated stamp; plain-text rendering.
- **`/about`** — team cards driven by the `TEAM` array in `js/about.js`.

## Registration UX

The form runs client validation **and** a **review step**: after validation
passes, everything you entered is shown read-only with *Back to edit* /
*Confirm & register* — nothing is sent until Confirm. The submit button is
disabled while saving (double-submit guard) with bounded retries that never
duplicate a squad. The confirmation pass displays the Reg ID prominently with
a hint to screenshot it (it is the key to `/status`).

## Backup & restore

```powershell
python scripts/backup_db.py                    # -> backups/registrations-<stamp>.db
python scripts/backup_db.py --out copy.db      # explicit destination
python scripts/backup_db.py --keep 20          # prune older copies (default 10)

# restore: STOP THE SERVER FIRST
python scripts/restore_db.py backups/registrations-<stamp>.db
python scripts/restore_db.py <backup> --to other.db
python scripts/restore_db.py <backup> --overwrite   # replace an existing target
```

Backups use SQLite's online backup API (correct while the server runs), are
verified with `PRAGMA integrity_check` (corrupt copies are deleted, never
kept), and land in `backups/` — outside `uploads/`, and `.db` files are never
served. Restore copies through a temp file + `os.replace` so a crash can't
leave a half-written database; it refuses to clobber an existing target
without `--overwrite`. Both scripts print row counts only — no PII.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Bind address |
| `BGMI_DB` | `registrations.db` | SQLite path |
| `BGMI_UPLOADS` | `uploads/` | Logo storage dir |
| `BGMI_SLOT_LIMIT` | `16` | Initial approved-slot limit |
| `BGMI_RATE_LIMIT` / `BGMI_RATE_WINDOW` | `30` / `3600` | Register submissions per window per IP |
| `BGMI_STATUS_RATE_LIMIT` / `BGMI_STATUS_RATE_WINDOW` | `5` / `60` | Public status lookups per IP |
| `BGMI_SESSION_TTL` | `1209600` | Absolute admin-session lifetime (seconds) |
| `BGMI_SESSION_IDLE_TTL` | `28800` | Idle timeout — untouched sessions die after this (seconds) |
| `BGMI_SMTP_HOST/PORT/USER/PASS/FROM` | *(unset)* | Optional e-mail; unset = jobs marked *skipped* |
| `BGMI_NOTIFY_ATTEMPTS` | `5` | Send attempts before a job parks as *failed* |
| `BGMI_NOTIFY_POLL` | `30` | Worker tick (seconds) |

No secrets live in the code; admin credentials come from your environment /
`scripts/create_admin.py`, SMTP credentials only from env vars.

## Tests

```bash
python test_api.py       # 104 checks — self-hosted, isolated temp DB/uploads
python test_admin.py     # 94 checks — same isolation (waits 61s once for the
                         # public lookup bucket, then restores the DB)
```

**Isolation** — with no `BASE` set, each suite boots its own throwaway server
on a free port with a temporary database and uploads folder and removes them
on exit; the real `registrations.db` cannot be touched and every run starts
from a freshly initialized database (clean rate-limit buckets, default
settings). Point at an already-running server with
`BASE=http://127.0.0.1:8080 python test_api.py` — that mode operates on the
server's configured database, so use it with the temp `BGMI_DB` workflow.

`test_api.py` covers: static serving + traversal probes, friendly URLs, CSRF
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

`test_admin.py` covers: seed + queue, register→pending, public lookup
(generic misses, 429 budget), edits + audit masking, approve/reject/waitlist/
needs_changes, slot-limit block + override, groups (assign/lock/auto/global
lock), **CSV export auditing**, the public-feed toggle, the typed-confirm
purge guard, **dashboard extras** (`remaining`, notify counts),
**`/schedule` settings round-trip**, **notification queue health + retry**,
**auto-distribute preview (writes nothing) → apply → preserve-on-re-run**,
**same-origin rejection (Origin/Referer 403)**, **session idle + absolute
expiry**, **login throttling (per-account 429, identical 401 bodies)**, and a
teardown that returns the DB to its pre-test state.

Rate limiting is verified separately (opt-in):

```bash
BGMI_RATE_LIMIT_TEST=1 python test_api.py   # asserts the register limiter engages
```
