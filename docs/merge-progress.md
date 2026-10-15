# Merge Progress — Registration Site + BGMI Broadcast

## Round 2 (2026-10-15) — 4-player rule · old overlays · new desk cards · BGMI points

Requested follow-ups after the merge dry run. Safety: demo/seed DB only (backup taken:
`backups/demo-pre-4players-20261015-205758.db`), live DB/uploads/.env untouched, no OBS actions.

- [x] R2-1. Exactly 4 players per team in a match — **Done** (commit after tests: 107/107)
       `player_stats.active` + triggers (hard cap of 4 active per match/team, drop+recreate in
       `TRIGGERS_SQL`), `match_team_results.unassigned_finishes` (FIN = Σ active player kills +
       unassigned; `team_kill_delta` now feeds that bucket), robust starter selection
       (slot `S*`/role `sub*` excluded + `NOT EXISTS` guard so re-ensuring never trips the trigger),
       repair migration (verify on demo: D001 5 = 4 player + 1 unassigned; D005 2 unassigned),
       swap via `POST /api/admin/match/<id>/team/<tid>/swap` (bench-first, event + audit log,
       stats kept, undo restores the four), `/api/live/state` strips uid+bench, bench list in desk state.
       13 new checks: 4-per-squad, swap + logs + undo, refusal of an already-playing sub,
       DB guard (5th insert aborts), legacy repair keeps rows, no benched/UID data on /live or overlays.
- [x] R2-2. Old broadcast overlays served as-is — **Done**
       `public/overlay.{html,css,js}` restored byte-identical from
       `b91ccef:broadcast-src/` (+ 6 assets at `/assets/` root); served at
       `/overlay/<scene>` for the original 16-scene set; `public/socket.io/
       socket.io.js` shim bridges `io()` to SSE (`/api/overlay/stream|state/
       <scene>`) with a 2 s polling fallback; server-side `legacy_state()`
       rebuilds B's `tournament:update` payload from the merged DB (numeric
       team ids, `out`→`eliminated`, uid/PII stripped); the scene pin comes
       from the URL path — 1-line edit in `overlay.js`, the only change to
       any overlay file; producer page lists the 16 scenes; the caster push
       now lives server-side only (no card scene).
       Missing vs the old themed set, **not created**: `teams-alive`,
       `team-status-strip`, `elimination-popup`, `team-intro`, `sponsor-bug`
       (`break-screen` → `intermission`).
       Verified: suites 108/104/94, Playwright 8/8, visual smoke green with
       16/16 scene screenshots (qa-shots/overlay-*.png) on demo data.
- [x] R2-3. Control desk team card rebuilt to the reference layout — **Done**
       header: slot badge (P#) / tag badge (logo or initials) / tag + full name + group /
       FIN · PLACE (or —) · PTS / collapse chevron; control row: green `+ FINISH`
       (unassigned finishes, `−` to take one back), PLACE stepper + typed pin, AUTO,
       gear menu (swap player / manual adjustment with reason / reset team);
       exactly 4 player rows: index, IGN + UID, DMG stepper (±100 + typed), finish
       counter, Alive/Knocked/Out icon buttons (tooltip + aria-label, pressed state
       highlighted, others dimmed); wiped squads dim + rank badge (`SET AUTO` hint when
       unplaced); rejected placement sets a `PLACE TAKEN` badge on the card; grid is a
       stable 3-column lobby order (P# slots) collapsing to 2 then 1; cards fold;
       actions stay serialized and undoable, every event timestamped.
       New server-side: `adjustment` + `adjustment_reason` columns (migrated),
       `compute_points(..., adjustment)` (PTS = placement + finishes + adjustment),
       `adjust_team()` (reason mandatory, event + audit, undoable), `reset_team()`,
       `POST .../team/<id>/auto|adjust|reset` routes; undo restores adjustments too.
       Verified: test_broadcast 119/119 (11 new: schema, AUTO, adjust + audit + no-reason
       refusal, PTS math, reset, undo), test_api 104, test_admin 94, Playwright 8/8,
       plus an interactive desk dry run on the demo DB (finish, adjust, swap with a real
       sub, placement conflict badge, AUTO, undo ×N — all clean, state restored).
- [ ] R2-4. BGMI points table, configurable — **Not started**
       default 10/6/5/4/3/2/1/1 + 1/finish + manual adjustments (reason + audit); tie-breakers
       points → wins → placement pts → finish pts → last-match placement (configurable);
       settings page confirm note; one engine for /live, /results, overlays, CSV; unit tests.
- [ ] R2-5. Dry run + screenshots + report — **Not started**

Verified by running (2026-10-15): `python tests/test_api.py` (104 ✓), `python tests/test_admin.py` (94 ✓),
`python tests/test_broadcast.py` (94 ✓), `npx playwright test` (8 ✓ after `npx playwright install chromium`),
plus an HTTP smoke pass on a temp seeded DB (all public/admin/overlay routes 200, bad overlay token → 403).

Status key: **Done** = code + tests verified by running · **Partial** = implemented, verification pending · **Not started**

- [x] 1. Unified data model and migrations — **Done**
       `broadcast.migrate()` inside `init_db`; matches / match_team_results / player_stats /
       event_log / scoring_rules / overlay_settings; A's registrations/groups remain source of truth.
- [x] 2. Scoring engine and its tests — **Done**
       Placement table 1–8 + kill points, auto-placement permutation, squad-wipe cascade,
       tie-breakers (points → wins → placement pts → kills → last placement); covered in test_broadcast.
- [x] 3. Routes and navigation — **Done**
       /live /results /schedule; /admin/matches /control /overlays /caster (session-gated);
       /overlay/<name> + token-gated /api/overlay/{state,stream}; legacy redirects; nav/footer links pass link-check.
- [x] 4. Match Control Desk (site theme) — **Done**
       admin-control.html + control.css + control.js; theme classes adm-*; desk actions covered by test_broadcast.
       *(visual re-check happens in the stage-10 dry run)*
- [x] 5. Public /live and /results — **Done**
       200s verified; SSE + 8 s polling fallback in live.js/results.js; screenshots in qa-shots/.
- [x] 6. Overlays and the producer page — **Done**
       11 scenes through /overlay/<name>?token=; admin-overlays.html producer (enable/theme/rotate/preview);
       wrong token → 403 verified.
- [x] 7. Caster dashboard — **Done**
       admin-caster.html; server-side stat-card push (PUSH_CARD_TTL) tested.
- [x] 8. Real-time updates (SSE + polling fallback) — **Done**
       /api/live/stream, /api/admin/stream, per-match stream; EventSource with 2 s poll fallback
       (admin-shell.js) / 8 s freshness poll (live.js); cleanup on broken pipe in broadcast.py.
- [x] 9. Cleanup — **Done**
       broadcast-src/ removed; unified README + .env.example + .gitignore (qa-shots, graft, data/,
       uploads, .env); seed_demo.py with --clean (now self-initialising: it runs the idempotent
       `init_db` so it works on a fresh DB); shared js/nav.js (no duplicated inline navbar);
       scripts/verify-broadcast.js kept as the repeatable visual smoke (public + overlays + admin pass).
- [x] 10. Security checks, tests and the full dry run — **Done**
       Automated: `tests/broadcast-flow.spec.js` green (register → approve → group → match → desk score →
       publish → /live, /results, overlay + token gate, PII assertions). Full `npx playwright test`: 8/8.
       Python suites: 104 + 94 + 94.
       Visual dry run (temp seeded DB, `scripts/verify-broadcast.js`): /live + /results at 1440/768/390,
       all 11 overlays at 1920×1080, admin pages at 1440/768/390 — clean (no console errors, no 4xx).
       Interactive desk check: "Eliminate squad" on `/admin/control` → `/live` alive counter updates
       live 4/4 → 3/4 without reload (SSE), auto-placement + event log correct.
       Concurrency check: desk + `/live` + teams-alive + live-leaderboard overlays open together —
       one SSE stream each, all four update after a desk action, nothing blocks.
       Triggered overlays: elimination-popup fires from a desk squad wipe; team-intro appears when the
       producer pins a team (`introTeam` setting). Both captured live (qa-shots/overlay-*-live.png).
       Bug found & fixed in the dry run: broadcast admin pages used relative asset/link paths, so the
       pretty URLs `/admin/<page>` served them unstyled with 404 CSS/JS (commit `973e943` — now
       root-absolute, matching `overlay.html`'s pattern).

## How to resume stage 10

All stages done. To re-verify from scratch:
1. `npx playwright install chromium` (done on this machine), then `npx playwright test` — 8/8 specs
   (7 pre-existing + the dry run). Python: `python tests/test_api.py`, `test_admin.py`, `test_broadcast.py`.
2. Visual pass on a temp seeded DB (never `data/registrations.db`):
   `BGMI_DB=<temp> BGMI_ADMIN_USER=... BGMI_ADMIN_PASSWORD=... node scripts/verify-broadcast.js <base>`.
3. Undo the merge: `git switch cleanup/repo-tidy` (pre-merge state; merge branch is 10+ commits ahead,
   nothing on the pre-merge branch was rewritten).
