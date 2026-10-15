# Merge Progress — Registration Site + BGMI Broadcast

Verified by running (2026-10-15): `python tests/test_api.py` (104 ✓), `python tests/test_admin.py` (94 ✓),
`python tests/test_broadcast.py` (94 ✓), `npx playwright test` (7 ✓ after `npx playwright install chromium`),
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
       uploads, .env); seed_demo.py with --clean; shared js/nav.js (no duplicated inline navbar).
       Note: seed_demo.py requires schema first — README documents `python -c "import server; server.init_db()"`.
- [ ] 10. Security checks, tests and the full dry run — **Partial**
       Done: security assertions live inside the 3 Python suites (admin gating, CSRF, token compare_digest,
       PII stripping, CSP headers, traversal probes) and all pass; `tests/broadcast-flow.spec.js` written
       and green (register → approve → group → match → desk score → publish → /live, /results, overlay +
       token gate, PII assertions at the HTTP level).
       Next: (a) run the manual full dry run on a temp seeded DB; (b) final screenshots at 1440/768/390 px;
       (c) final report (folder tree, route map, OBS steps, undo-merge command).

## How to resume stage 10

1. `npx playwright install chromium` (done on this machine), then `npx playwright test tests/broadcast-flow.spec.js`
   (green: full register→publish dry run; uses `scripts/create_admin.py` for a throwaway admin on the temp DB).
2. `npx playwright test` — all 8 specs green on this machine (7 pre-existing + the dry run).
3. Manual dry run on a temp seeded DB (never `data/registrations.db`), screenshots at 1440/768/390.
4. Final report: folder tree, route map, test results, OBS setup, undo-merge command.
