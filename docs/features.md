# Features, pages and file map

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
  from Settings, a per-match plan (group, map, start time) maintained on the
  matches page, timezone label, last-updated stamp; plain-text rendering.
- **`/about`** — team cards driven by the `TEAM` array in `public/js/about.js`.

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

## File map

| Path | Purpose |
|---|---|
| `server.py` | Static file server + JSON API + SQLite storage + notification worker |
| `public/bgmi-team-registration.html` | Registration page (hero, countdown, rules, form, review step, confirmation with Reg ID) |
| `public/status.html` | Public "Check your status" page (Reg ID + captain phone/email, last-updated + next steps) |
| `public/teams.html` | Public approved-teams grid with search + group filter (off unless enabled in Settings) |
| `public/rules.html` | `/rules` — curated house rules, tournament config, format, fair play (same text as registration) |
| `public/schedule.html` | `/schedule` — settings-driven day-of schedule + match plan (start times) + timezone + last-updated (gated with `/teams`) |
| `public/admin.html` | Control Room — session login, queue, team detail, groups, audit, notifications, settings |
| `public/admin-login.html` | Control Room login screen (served by `/admin` when logged out) |
| `public/about.html` | About page (Who we are + team cards), served at `/about` too |
| `public/privacy.html` | Privacy note page (footer-linked) |
| `public/404.html` | Themed not-found page |
| `public/css/style.css` | Theme stylesheet (originally copied from the original site; pruned to what this app serves) |
| `public/css/bgmi-register.css` | Page-specific styles (roster rows, dropzone, subs, review step, confirmation) |
| `public/css/admin.css` / `status.css` / `teams.css` / `footer.css` / `404.css` / `about.css` | Page styles |
| `public/js/bgmi-register.js` | Client validation, roster/subs, logo upload, **review step + submit guard**, squad-pass PDF/QR |
| `public/js/panel.js` | Control Room logic (queue, bulk counts, groups preview, notifications, audit, settings) |
| `public/js/status.js` | Status lookup + request-changes form + next-steps line |
| `public/js/about.js` | `TEAM` config array + card rendering + photo-missing fallback |
| `public/assets/vendor/` | qrcode + jsPDF (for squad-pass PDF/QR) |
| `public/images/team/` | Team photos read by the About page (`fe_psycho.png` etc.) |
| `scripts/create_admin.py` | Create/rotate an admin account (scrypt-hashed) |
| `scripts/seed_demo.py` | Backup-first demo reseed: 32 anime squads 16/16 in Group A+B, one scheduled match per group with start times, DEMO DATA badge |
| `scripts/backup_db.py` | Consistent online backup of `registrations.db` (integrity-checked) |
| `scripts/restore_db.py` | Restore a backup (temp file + atomic replace, `--overwrite` guard) |
| `tests/test_api.py` | End-to-end API suite (105 checks, self-hosted + isolated by default) |
| `tests/test_admin.py` | Approval-workflow suite (94 checks, includes a 61s rate-limit wait) |
| `tests/*.spec.js` | Playwright browser specs (review step + link/asset checks) |
| `data/` | Live data: `registrations.db` + `uploads/` (gitignored; `.gitkeep` tracks the folder) |
| `backups/` | `backup_db.py` output (outside `uploads/`; `.db` files are never served) |
| `docs/` | Long-form docs: API, features, security, testing |
