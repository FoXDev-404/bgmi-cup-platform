# BGMI Champions Cup — Registration + Broadcast

One project, one server, one database, one login, one theme. Two sections:

1. **Registration** — public squad registration with review/confirmation,
   status lookup, approved-teams grid, schedule, and a full admin approval
   workflow (Control Room).
2. **Broadcast** — match schedule, live control desk (kills, damage, status,
   placements, undo), public live/results pages, 11 OBS browser-source
   overlays, and a caster dashboard — all driven from the same approved teams
   and groups (the registration section is the single source of truth).

**Stack:** Python 3 standard library only — no pip packages, no build step,
one SQLite database (`data/registrations.db`). Minimum Python **3.7**
(`ThreadingHTTPServer`; verified on 3.10). Playwright + Chromium only for the
browser tests. Real-time updates use **Server-Sent Events** with a polling
fallback — no Socket.IO, no Node server.

## Layout

```
server.py            Static file server + JSON API + SQLite + SSE + notify worker
broadcast.py         Broadcast engine: schema/migrations, scoring, match
                     lifecycle, desk actions, undo, standings, overlay state
public/              Web root
  *.html             Public pages (index, status, teams, schedule, live,
                     results, about, 404, privacy)
  admin*.html        Admin pages (dashboard, matches, control desk,
                     overlays producer, caster)
  overlay.html       Single transparent shell served for /overlay/<name>
  css/               style.css (theme), admin.css, footer.css, control.css
                     (broadcast admin), overlay.css (OBS scenes)
  js/                nav.js, admin-shell.js (BC bootstrap), per-page scripts,
                     overlay.js (11 scene renderers)
  assets/, images/   Vendor libs + imagery
scripts/             create_admin.py, seed_demo.py, backup_db.py, restore_db.py
tests/               test_api.py, test_admin.py, broadcast specs (Playwright)
docs/                api.md, features.md, security.md, testing.md, merge-plan.md
data/                Live data: registrations.db + uploads/ (gitignored)
backups/             backup_db.py output (gitignored)
```

## Install & run

There is nothing to install — Python 3 is the only requirement.

```powershell
# one-time: create the database schema (data/registrations.db)
python -c "import server; server.init_db()"

# one-time: create your admin account (prompts for username/password;
# no default account exists. Re-running with the same username resets it.)
python scripts/create_admin.py

# recommended: first backup
python scripts/backup_db.py

python server.py                       # http://127.0.0.1:8080
```

Change the bind with `HOST` / `PORT` (`$env:PORT='9000'; python server.py`).

## Route map

**Public** (no login):

| Route | Page |
|---|---|
| `/` | Registration |
| `/status` | Status lookup |
| `/teams` | Approved teams grid |
| `/schedule` | Schedule + group draw |
| `/live` | Live match centre (SSE) |
| `/results` | Standings, group tables, match results |
| `/about` · `/privacy.html` · `/rules` | Info pages |
| `/overlay/<name>` | OBS overlay scene (token-gated data) |
| `/standings` · `/operator` · `/login` | Legacy redirects → `/results` · `/admin/control` · `/admin` |

**Admin** (one session + CSRF, gated server-side on every route):

| Route | Page |
|---|---|
| `/admin` | Registration approval dashboard |
| `/admin/matches` | Match schedule + check-in + scoring rules |
| `/admin/control` | Match Control Desk (drive a live match) |
| `/admin/overlays` | Overlay producer (URLs, token, on/off, preview) |
| `/admin/caster` | Caster dashboard + push-stat-card |

**API:** registration/status endpoints (see [docs/api.md](docs/api.md)) plus
`/api/live/state`, `/api/live/stream` (SSE), `/api/overlay/state/<name>`,
`/api/overlay/stream/<name>` (token-gated), and `/api/admin/matches*`,
`/api/admin/matches/<id>/*`, `/api/admin/overlay-settings`,
`/api/admin/scoring-rules`.

## Broadcast in 60 seconds

1. Approve teams and draw groups in `/admin` (registration section is the
   source of truth — matches can only contain approved squads of a group).
2. `/admin/matches` → create a match for a group, check squads in (max 16).
3. `/admin/control` → **Start match**; log kills, damage, player status;
   squads are auto-placed as they are eliminated (or set placements by hand);
   **Undo** reverses any logged action; keyboard: `S` squad focus, `U` undo,
   `R` refresh.
4. **Verify and publish** (gated: every squad needs a placement) — points
   flow into standings, `/live`, `/results` and the overlays immediately.
5. `/admin/overlays` → copy the 11 overlay URLs into OBS browser sources
   (1920×1080, transparent). Each URL carries a rotatable token.
6. `/admin/caster` → standings + push any player's stat card onto the
   `mvp-card` overlay for 90 seconds.

Scoring: placement points `{1:10, 2:6, 3:5, 4:4, 5:3, 6:2, 7:1, 8:1}` + 1 pt
per kill (tunable on `/admin/matches`). Tie-breakers: points → wins →
placement points → kills → last-match placement.

## Tests

```powershell
python tests/test_api.py            # registration/public API suite
python tests/test_admin.py          # admin workflow suite (includes one 61s wait)
npx playwright test                 # browser specs (run `npm install` once first)
```

Each Python suite boots its own throwaway server with a temporary database and
uploads folder, so the live `data/registrations.db` can never be touched.
Coverage details: [docs/testing.md](docs/testing.md).

## Seed demo data

```powershell
python scripts/seed_demo.py           # 20 demo squads + groups + 2 demo matches
                                      # (one published, one live) + overlay settings
python scripts/seed_demo.py --clean   # remove everything demo
```

Demo rows are identifiable: team ids `CSM-BG-Dxxx`, codes `BGMI26-9xxx`,
emails `@demo.invalid`, match notes `Demo match …`.

## Environment variables

Variables are read from the process environment (PowerShell: `$env:PORT='9000'`,
cmd.exe: `set PORT=9000`). Every name is listed in
[.env.example](.env.example) — values never go into git. The broadcast
section adds no environment variables: the overlay token and producer
settings live in the database (`overlay_settings`).

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Bind address |
| `BGMI_DB` | `data/registrations.db` | SQLite database path |
| `BGMI_UPLOADS` | `data/uploads` | Team-logo storage directory |
| `BGMI_SLOT_LIMIT` | `16` | Approved-slot limit |
| `BGMI_RATE_LIMIT` / `BGMI_RATE_WINDOW` | `30` / `3600` | Register POSTs per IP per window (seconds) |
| `BGMI_STATUS_RATE_LIMIT` / `BGMI_STATUS_RATE_WINDOW` | `5` / `60` | Status lookups per IP per window (seconds) |
| `BGMI_SESSION_TTL` / `BGMI_SESSION_IDLE_TTL` | `1209600` / `28800` | Admin session absolute cap / idle timeout (seconds) |
| `BGMI_SMTP_HOST` / `BGMI_SMTP_PORT` / `BGMI_SMTP_USER` / `BGMI_SMTP_PASS` / `BGMI_SMTP_FROM` | *(unset)* / `587` | Optional e-mail; SMTP unset → jobs are marked *skipped* |
| `BGMI_NOTIFY_ATTEMPTS` / `BGMI_NOTIFY_POLL` | `5` / `30` | Send attempts before *failed* / worker tick (seconds) |
| `BGMI_ADMIN_USER` / `BGMI_ADMIN_PASSWORD` | — | Non-interactive input for `scripts/create_admin.py` |
| `BASE` / `BGMI_RATE_LIMIT_TEST` | *(tests)* | Point a suite at a running server / enable the rate-limit probe |

No secrets live in the code: admin credentials come only from
`scripts/create_admin.py`, SMTP credentials only from environment variables,
the overlay token is generated into the database and rotatable from
`/admin/overlays`.

## OBS setup (overlays)

1. In OBS add a **Browser** source per overlay you want.
2. URL: copy from `/admin/overlays` (each contains `?token=…`); width
   `1920`, height `1080`; leave "Shutdown source when not visible" off so
   SSE reconnects cleanly.
3. Backgrounds are transparent — safe to stack. The producer's on/off switch
   hides an overlay everywhere (stored server-side).
4. Rotating the token on `/admin/overlays` invalidates every copied URL at
   once — paste the new URLs into OBS after rotating.

## Backup & restore

```powershell
python scripts/backup_db.py                     # -> backups/registrations-<stamp>.db
python scripts/restore_db.py backups/<file>     # stop the server first
```

SQLite's online backup API + integrity check; atomic restore with an
`--overwrite` guard. Details: [docs/features.md](docs/features.md).

## Docs

- [docs/api.md](docs/api.md) — HTTP API reference
- [docs/features.md](docs/features.md) — approval workflow, broadcast feature guide, file map
- [docs/security.md](docs/security.md) — sessions, throttling, headers, privacy, overlay tokens
- [docs/testing.md](docs/testing.md) — suite coverage & isolation
- [docs/merge-plan.md](docs/merge-plan.md) — how the registration and broadcast sections were merged
