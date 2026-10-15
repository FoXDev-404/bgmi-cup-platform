# BGMI Cup Noida 2026 — Team Registration

A competitive BGMI squad-registration platform in the CyberSec India theme:
public registration with a review step and confirmation, public status lookup,
approved-teams grid, rules/schedule pages, and a full admin approval workflow
(Control Room) — served by a dependency-free Python server with SQLite
persistence.

**Stack:** Python 3 standard library only — no pip packages, no build step.
Minimum Python **3.7** (uses `ThreadingHTTPServer`; developed and verified on
Python 3.10). Playwright + Chromium are only needed for the browser tests.

## Layout

```
server.py            Static file server + JSON API + SQLite + notify worker
public/              Web root: pages, css/, js/, assets/ (vendor libs + images),
                     images/team/ (About-page photos)
scripts/             create_admin.py, seed_demo.py, backup_db.py, restore_db.py
tests/               test_api.py, test_admin.py, Playwright specs
docs/                api.md, features.md, security.md, testing.md
data/                Live data: registrations.db + uploads/ (gitignored)
backups/             backup_db.py output (gitignored)
.env.example         Environment variable names (no values in git)
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

Pages: `/` registration · `/status` status lookup · `/teams` approved grid ·
`/rules` · `/schedule` · `/about` · `/admin` Control Room · `/privacy.html` ·
anything else → themed 404. Change the bind with `HOST` / `PORT`
(`$env:PORT='9000'; python server.py`).

## Tests

```powershell
python tests/test_api.py            # 104 checks — self-hosted temp DB/uploads
python tests/test_admin.py          # 94 checks — same isolation (includes one 61s wait)
npx playwright test                 # browser specs (run `npm install` once first)
```

Each Python suite boots its own throwaway server with a temporary database and
uploads folder, so the live `data/registrations.db` can never be touched.
Coverage details: [docs/testing.md](docs/testing.md).

## Seed demo data

```powershell
python scripts/seed_demo.py           # ~20 demo squads + groups (schema must exist — see above)
python scripts/seed_demo.py --clean   # remove everything demo
```

Demo rows are identifiable: team ids `CSM-BG-Dxxx`, codes `BGMI26-9xxx`,
emails `@demo.invalid`.

## Environment variables

Variables are read from the process environment (PowerShell examples:
`$env:PORT='9000'`, cmd.exe: `set PORT=9000`). Every name is listed in
[.env.example](.env.example) — values never go into git.

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
`scripts/create_admin.py`, SMTP credentials only from environment variables.

## Backup & restore

```powershell
python scripts/backup_db.py                     # -> backups/registrations-<stamp>.db
python scripts/restore_db.py backups/<file>     # stop the server first
```

SQLite's online backup API + integrity check; atomic restore with an
`--overwrite` guard. Details: [docs/features.md](docs/features.md).

## Docs

- [docs/api.md](docs/api.md) — HTTP API reference
- [docs/features.md](docs/features.md) — approval workflow, public pages, backup/restore, file map
- [docs/security.md](docs/security.md) — sessions, throttling, headers, privacy
- [docs/testing.md](docs/testing.md) — suite coverage & isolation
