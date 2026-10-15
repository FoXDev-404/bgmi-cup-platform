# Merge Plan — Registration Site (A) + BGMI Broadcast (B) → one project

Branch: `merge/broadcast-into-site` · Base: A's full git history (cloned) · B imported under `broadcast-src/` for reference, removed at cleanup.

## 0. Decision

The merged app keeps **A's stack**: Python 3 stdlib (`ThreadingHTTPServer`), one SQLite
database, plain HTML/CSS/JS, no pip packages, no npm runtime deps, no build step.
B was Express + Socket.IO + JSON store → its **logic is ported to Python**, its pages are
rewritten in A's theme. One server (port 8080), one DB (`data/registrations.db`), one
admin login/session/CSRF, one theme.

Real-time: B used Socket.IO. The stdlib substitute is **Server-Sent Events** on the
threaded server, with a **2-second polling fallback** in every client. One SSE
connection per page; subscribers are cleaned up on broken pipe.

## 1. Final folder structure

```
bgmi-cup/
├─ server.py               # A's server, extended: broadcast routes, SSE, overlay gate
├─ broadcast.py            # NEW — ported scoring engine, broadcast queries, SSE hub
├─ README.md               # one README (unified)
├─ .env.example            # one env template (unified)
├─ .gitignore
├─ package.json            # dev-only: Playwright (tests); no runtime JS deps
├─ playwright.config.js
├─ public/
│  ├─ bgmi-team-registration.html   # "/" unchanged
│  ├─ status.html teams.html about.html schedule.html rules.html privacy.html 404.html
│  ├─ live.html results.html        # NEW public pages
│  ├─ admin-login.html admin.html   # A unchanged (Control Room) + nav links added
│  ├─ admin-matches.html admin-control.html admin-overlays.html admin-caster.html  # NEW
│  ├─ overlay.html                  # single overlay shell; /overlay/<name>?token=…
│  ├─ css/  style.css footer.css admin.css … + control.css overlays.css caster.css live.css results.css overlay.css
│  ├─ js/   panel.js … + nav.js (shared navbar) control.js matches.js overlays.js caster.js live.js results.js overlay.js broadcast-common.js
│  ├─ images/team/                  # A's photos (kept)
│  ├─ assets/vendor/                # jspdf, qrcode (kept)
│  └─ assets/broadcast/             # B's 4 SVG props + 2 webp backgrounds (theme.mp3 dropped)
├─ tests/
│  ├─ test_api.py test_admin.py     # A's suites — must keep passing
│  ├─ test_broadcast.py             # NEW python suite (scoring, desk, publish, tokens, PII, gating)
│  ├─ link-check.spec.js review-step.spec.js  # A's Playwright (nav updated)
│  └─ broadcast-flow.spec.js        # NEW full dry-run on demo DB
├─ scripts/
│  ├─ seed_demo.py                  # extended: demo groups/matches/results/overlay settings
│  ├─ backup_db.py restore_db.py create_admin.py
├─ data/                            # registrations.db + uploads (gitignored; live data never committed)
├─ backups/                         # db backups (gitignored)
└─ docs/ api.md features.md security.md testing.md merge-plan.md
```

## 2. Route map

### Public (unchanged ones keep working exactly as before)
| Route | Notes |
|---|---|
| `/` `/status` `/teams` `/about` `/schedule` `/rules` `/privacy.html` | A, unchanged |
| `/live` | NEW — live group tables + overall leaderboard (SSE + 2 s poll) |
| `/results` | NEW — published match result cards + overall leaderboard |
| `/overlay/<name>` | NEW — OBS browser source page (1920×1080, transparent) |
| `/api/health` `/api/csrf` `/api/public/approved` `/api/public/schedule` | A, unchanged |
| `/api/live/state` | NEW — sanitized live JSON (no PII) |
| `/api/live/stream` | NEW — SSE for /live and /results |
| `/api/overlay/state/<name>?token=` | NEW — overlay JSON, token-gated |
| `/api/overlay/stream/<name>?token=` | NEW — SSE for overlays, token-gated |
| `/standings` → 301 `/results`, `/operator` → 301 `/admin/control`, `/login` → 301 `/admin` | B muscle-memory kept alive |

### Admin (A's session cookie `bgmi_admin`, per-session CSRF header `X-Admin-CSRF`)
| Route | Notes |
|---|---|
| `/admin` | A Control Room (queue/groups/audit/settings) — untouched behaviour |
| `/admin/matches` | NEW — match list, create (group + map + lineup check-in), scoring rules |
| `/admin/control` | NEW — Match Control Desk |
| `/admin/overlays` | NEW — producer page: enable/show overlays, theme, logo, preview, copy URLs, rotate token |
| `/admin/caster` | NEW — caster dashboard, push stat card to overlay |
| `GET/POST /api/admin/matches`, `GET /api/admin/matches/<id>` | list/create/read |
| `POST /api/admin/matches/<id>/status` | start → live, end → awaiting_verification, publish, unpublish |
| `POST /api/admin/matches/<id>/checkin` | toggle lineup (approved + in group only) |
| `POST /api/admin/match/<id>/kills` | team kills ±1 |
| `POST /api/admin/match/<id>/player` | per-player kill/damage/status (alive/knocked/out) |
| `POST /api/admin/match/<id>/placement` | manual placement (duplicate rejected) |
| `POST /api/admin/match/<id>/eliminate` | one-click squad wipe → auto placement |
| `POST /api/admin/match/<id>/reset` | reset a match's live inputs |
| `POST /api/admin/match/<id>/undo` | undo last action (from event_log payload) |
| `GET/POST /api/admin/overlay-settings` | producer settings + token rotate + caster card push |
| `GET/POST /api/admin/scoring-rules` | placement table 1–8 + kill point |
| `GET /api/admin/match/<id>/stream` | SSE for desk + caster page |
| `GET /api/admin/stream` | SSE for admin pages (match list changes) |

Every new `/admin` page is gated server-side exactly like `/admin` (session check in
`do_GET`, login page otherwise). Every new admin API uses `require_admin(write=True)`
(same-origin + CSRF). All writes audited via `audit()`.

## 3. Unified data model (one SQLite DB, additive migrations only)

Approved teams, groups, rosters and tags from A are the **single source of truth**.
B's team/player/registration JSON structures are dropped; nothing reads `broadcast-src/`.

New tables (created by `broadcast.migrate()` inside `init_db`, idempotent, never drop):

```
matches(id PK, match_number INT, group_name TEXT, map TEXT,
        status TEXT DEFAULT 'upcoming',        -- upcoming|live|awaiting_verification|published
        created_at, started_at, ended_at, published_at, notes)
match_team_results(match_id REFERENCES matches ON DELETE CASCADE,
        team_id TEXT REFERENCES registrations ON DELETE CASCADE,
        placement INT, placement_auto INT DEFAULT 1, kills INT DEFAULT 0,
        points INT DEFAULT 0, eliminated_at INT, PRIMARY KEY(match_id, team_id))
player_stats(id PK, match_id, team_id, player_uid TEXT, player_name TEXT,
        kills INT DEFAULT 0, damage INT DEFAULT 0,
        status TEXT DEFAULT 'alive',           -- alive|knocked|out
        auto_eliminated INT DEFAULT 0, UNIQUE(match_id, player_uid))
event_log(id PK, at, match_id, type, team_id, player_uid,
        description, payload TEXT,             -- JSON snapshot for undo
        undone INT DEFAULT 0)
scoring_rules(key PK, value)    -- kill_points=1, placement_1..8 = 10,6,5,4,3,2,1,1 (from B)
overlay_settings(key PK, value) -- token, theme_color, logo_path, enabled(list),
                                  caster_name/tagline/image, pushed_card, sponsor_text
```

Check-in: A has no check-in model, so one is added minimally — creating a match opens
a **lineup check-in** for approved teams of the match's group (max 16). Only
checked-in teams appear on the desk, standings and overlays. A's registration,
status, approvals, groups, exports, notifications and purge behaviour are untouched.

## 4. Scoring engine (ported from B, `broadcast.py`)

- `placement_points = {1:10, 2:6, 3:5, 4:4, 5:3, 6:2, 7:1, 8:1}` (configurable 0–100),
  `kill_points` per frag (configurable 0–10, default 1) — B's defaults.
- `match_points = kills × kill_points + placement_points[placement]`.
- Auto placements (B's algorithm): a squad owns its placement when its 4th player
  falls — first wiped = deepest free position, permutation of 1..N so duplicates are
  impossible; manual placements are pinned; a lone survivor takes P1.
- Squad wipe cascade: last player out → knocked/alive teammates cascade to
  `out` (auto); revive reverts only auto-eliminated players.
- Aggregation across published matches per team and per player (players keyed by UID,
  fall back to team+IGN; UIDs never leave the server in public payloads).
- **Tie-breakers (user spec, supersedes B's name-sort):**
  1. total points ↓  2. wins (placement 1) ↓  3. placement points ↓  4. kills ↓
  5. last-match placement ↑
- Unit-tested in `tests/test_broadcast.py`.

## 5. What is ported from B / what is dropped

**Ported:** scoring engine + auto placements + squad-wipe cascade (server logic);
duplicate-placement and publish validation; live HUD / teams-alive / status-strip /
elimination popup / results / overall / lower-third / chicken-dinner / MVP / break /
sponsor overlay *concepts* — rebuilt in A's theme; standings tie idea; production
config (caster name/tagline/photo, labels); event log with descriptions.

**Redesigned (A's theme):** control desk, overlays, standings, caster. Amber/Barlow
Rajdhani look is replaced by A's dark `--bg #0c0d10`, lime `--acid #b6ff3e`, coral
`--red #c14d40`, the four fonts (Anton / Special Elite / Caveat / JetBrains Mono),
dashed borders, stamps, `adm-*` buttons/cards so admin pages are Control Room siblings.

**Dropped:** Node/Express/Socket.IO/MongoDB, B's own auth (admin.json, captains,
reset-password) — one login now; B's registration desk (A owns registration);
12 of 16 broadcast scenes not in the user's overlay list (pre-show, stream-start,
countdown, format, lineup, map-feed, intermission, technical-difficulties, hidden,
frag-leaders split, plus music); `code.js` (Figma plugin), `GODLScoreboard.jsx`
(React prototype), root `scoreboard.css`, `theme.mp3` (4 MB, stream-start only),
B's login/register pages, dev bypass, `data/*.json` store.

## 6. Overlay list (1920×1080, transparent, no chrome, token in URL)

`live-leaderboard`, `teams-alive`, `team-status-strip`, `elimination-popup`,
`match-results`, `overall-standings`, `team-intro`, `chicken-dinner`, `mvp-card`,
`break-screen`, `sponsor-bug`. All update instantly via SSE; all respect
`prefers-reduced-motion`; none can render email/phone/UID (payloads strip them).

> Superseded in R2-2: production now serves the ORIGINAL broadcast app's
> 16 scenes (`pre-show` … `hidden`) as-is — see docs/merge-progress.md R2-2
> for the served list and the scenes that were not carried over.

## 7. Security

- One login, one session store, one CSRF scheme (A's). New admin APIs:
  `require_admin(write=True)` + audit. Overlay data endpoints require the
  overlay token (`secrets.token_urlsafe(24)`, `hmac.compare_digest`, rotatable
  from `/admin/overlays`; rotation kills old URLs immediately).
- Parameterized SQL everywhere (project-wide rule).
- CSP (`default-src 'self'`, Google Fonts allowed, `connect-src 'self'`, no
  `unsafe-inline` scripts — the duplicated navbar IIFE is factored into `js/nav.js`),
  plus existing nosniff + Referrer-Policy; `X-Frame-Options: DENY` on admin pages.
- `POST /api/admin/purge` extended to also clear matches, match results, player
  stats, event log and overlay settings (typed `PURGE` confirm unchanged).

## 8. Test & verification plan

- A's `python tests/test_api.py` + `python tests/test_admin.py` must stay green.
- NEW `tests/test_broadcast.py` (same harness: temp DB, free port, subprocess):
  scoring + tie-breakers, desk actions (kill/knock/out/eliminate/undo/duplicate
  placement), publish rules, overlay token access + rotation, no PII in
  `/api/live/*` and `/api/overlay/*`, admin gating of every new route.
- Playwright: existing specs updated for the new nav; new `broadcast-flow.spec.js`
  full dry run (approve → group → match → score → publish → /live + overlay update)
  at 1440/768/390 px with console/network error capture.
- Live-data safety: every test run uses `BGMI_DB` pointed at a temp/demo DB —
  the live `data/registrations.db` is never opened by tests.

## 9. Undo

The merge lives on its own branch in its own repo (`bgmi-cup`), and both originals
are untouched (plus zip backups in `../_backups-pre-merge/`). Full undo:

```
Remove-Item -Recurse -Force "E:\AA Projects\BGMI Complete\bgmi-cup"
```

(the registration site continues to live in `Registration Section/` exactly as before).
