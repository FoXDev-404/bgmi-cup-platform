# End-to-end verification report — BGMI Cup

- **Checkpoint verified:** `f190183` (clean tree, branch `merge/broadcast-into-site`)
- **Final state:** stage-11 commit — 4 app fixes + 10 test/doc/runner commits since the
  checkpoint (all local, nothing pushed)
- **Date:** 2026-10-16
- **Environment:** Windows · Python 3.14.4 · Node v24.15.0 · Playwright 1.64.1
  (Chromium) as a **dev-only** tool — the app itself stays Python stdlib + SQLite +
  plain HTML/CSS/JS with no new runtime dependencies.
- **Isolation:** every stage ran against a throw-away copy of the seeded demo DB
  (`%TEMP%\opencode\bgmi-verify\verify.db` + a matching uploads dir), recreated
  before each stage and deleted afterwards. The real `data/registrations.db`,
  the 8080 demo server (`data/demo.db`), uploads and `.env` were never modified.
- **How it was driven:** the eleven stages of the brief, each ending in a commit;
  bugs fixed with the smallest safe change plus a regression test.

## Results matrix

| Suite / script | Before (checkpoint f190183) | After | What it covers |
|---|---|---|---|
| `tests/test_api.py` | 104 / 0 | 104 / 0 | static + traversal, CSRF, validation, uploads, races, backup |
| `tests/test_admin.py` | 94 / 0 | **96 / 0** | gating, queue, statuses, groups, exports, purge — +2 new regression checks |
| `tests/test_broadcast.py` | 139 / 0 | 139 / 0 | match engine, AUTO placements, rules, publish, overlays |
| `npx playwright test` (3 spec files) | 8 / 0 | **9 / 0** | link/asset sweep, review-step flow, broadcast dry run (+1 duplicate-nav regression spec) |
| `tests/e2e/public-site.js` | — (new) | 158 / 0 | every public page at 3 viewports, nav/footer, reveal, escapes |
| `tests/e2e/registration-flows.js` | — (new) | 30 / 0 | valid UI squad + PDF/QR, rejection matrix, rate limit, PII |
| `tests/e2e/status-lookup.js` | — (new) | 13 / 0 | lookup pairs, generic miss, correction request, 5/min limit |
| `tests/e2e/admin-flows.js` | — (new) | 97 / 0 | login/throttle, queue+filters, edits+audit, groups, settings, purge |
| `tests/e2e/matches-flows.js` | — (new) | 40 / 0 | lifecycle guards, check-in, publish/history, room details |
| `tests/e2e/control-desk.js` | — (new) | 38 / 0 | 16-squad lobby, 4-player rule, swaps, AUTO wipes, publish flow |
| `tests/e2e/scoring-check.js` | — (new) | 45 / 0 | 3 matches, 21-point tie, tie-breaker reorder, penalty, 3 surfaces |
| `tests/e2e/overlays.js` | — (new) | 68 / 0 | token gate, 1920×1080 transparency, PII sweep, SSE fan-out |
| `tests/e2e/security-a11y.js` | — (new) | 46 / 0 | headers, traversal, API auth, labels/alt, keyboard, perf budget |

535 stage checks + 348 suite checks, all green. Reproduce with one command:

```powershell
scripts\verify.bat        # Windows
scripts/verify.sh         # bash / git-bash
```

Each script exits non-zero on failure; the runner reseeds the throw-away DB
before every stage (the status-lookup stage waits out the 5/min bucket twice,
so a full run takes roughly 15 minutes).

## Bugs found and fixed

| # | Bug | Fix commit | Regression test |
|---|---|---|---|
| 1 | **Duplicate "Rules" nav link** on the 404 / about / privacy pages (two links with the same label and target) | `cd3934b` | Playwright spec — fails if any page ships a duplicate nav/footer link |
| 2 | **Share links missing `noreferrer`** ("open in new tab" squad-pass links leaked the referrer to external targets) | `e80ceec` | `public-site.js` asserts every `target=_blank` link carries `rel="noopener noreferrer"` |
| 3 | **Keep-alive connections poisoned by rejected writes** — a 4xx (e.g. CSRF failure) left the body unread, so the *next* request on the same connection answered a spurious 501 | `9d820e5` | 2 new `test_admin.py` checks replay write→rejected-write→read on one connection |
| 4 | **Create-match drawer race** — the check-in drawer opened before the async list refresh finished, swallowing the new match | `1013b4e` | `matches-flows.js` creates a match through the UI and asserts the drawer opens for it |

No other genuine app bugs surfaced; every other first-run failure was the
script asserting an intended behaviour wrongly and was fixed in the script
(e.g. player rows exist only after a match starts, squads without substitutes
get a toast instead of the swap dialog, the standings CSV starts with a
UTF-8 BOM for Excel). Those are listed under observations where notable.

## Stage-by-stage summary

1. **Checkpoint + existing suites** — clean tree committed as a checkpoint;
   suites green at the checkpoint (numbers above).
2. **Public pages** — 12 URLs × 3 viewports, nav/hamburger, footer/CTA targets,
   404 page, escaping, external-link policy, scroll-reveal; screenshots for
   every page/viewport in `tests/screenshots/`.
3. **Registration** — full happy path through the UI (5-step form, squad +
   substitutes), confirmation Reg ID, PDF+QR asset, the rejection matrix
   (validation, duplicates, honeypot), 30/h rate limit, and a PII scan of
   every public payload.
4. **Status lookup** — correct captain pairs, deliberately generic miss
   message (no hint which field was wrong), correction request flow with
   admin-immediate short-circuit, 5/min bucket.
5. **Admin flows** — session/login throttling/CSRF, queue search + status
   filters, edit + audit masking, groups (create/assign/auto/lock), slot-limit
   block + override, schedule settings, typed purge guard, CSV exports
   (PII only in the admin contact sheet by design), logout.
6. **Matches** — eligibility rules (upcoming only, group size, check-in),
   lifecycle guards (no skip-ahead, publish validation), unpublish/republish,
   history, room details on `/status`, delete protection, UI create → drawer →
   delete.
7. **Control desk** — 16-squad lobby with the 4-player rule enforced at match
   start, kills/finish steppers, undo, bench swaps (stats preserved, all API
   guards), AUTO placement engine (wipes take the deepest free seat in order,
   pins win, unplaced teams block publish), publish flow and public results.
8. **Independent scoring** — an in-test copy of the scoring model compared
   against three surfaces (`/api/live/state`, the `/results` DOM, the admin
   standings CSV) after every step: 3 matches under default rules, a deliberate
   21-point tie broken by wins, a tie-breaker reorder that flips the tie, a
   −10 penalty with reason, and a kill/placement points change (verified on a
   new match scored under the new rules).
9. **Overlays** — all 16 scenes render at 1920×1080 with transparent document
   background and zero console errors; token gate (missing/wrong → 403,
   rotation retires the old token, unknown scene → 404, disabled flag),
   PII sweep of every scene payload cross-checked against the admin state
   (which does carry player UIDs), SSE fan-out to two overlay clients + the
   public live feed, and a desk kill flowing through SSE into the rendered
   scoreboard row.
10. **Security / a11y / perf** — security headers on every surface (nosniff,
    referrer policy, strict CSP, admin pages `X-Frame-Options: DENY` vs
    `SAMEORIGIN` elsewhere), 9 path-traversal/file-block probes over a raw
    socket (encoded, double-encoded, backslash, upload dir — all 404, no leak),
    401/403 without session/CSRF, SQL-ish input → clean 4xx, accessible-name
    /label/alt sweeps on 4 pages, keyboard activation of links and the mobile
    drawer, `Escape` closing the native desk dialog, page-load and
    `/api/live/state` latency budgets.
11. **Report + runner** — this document, `scripts/verify.bat`(+`.sh`), and a
    final all-green run of the runner.

## Observations (intended behaviour, documented not changed)

- **Published points are frozen at scoring time.** Changing the scoring rules
  after a match is published updates the *displayed components*
  (placement/finish points) and future matches, but not the stored per-match
  totals; unpublish → republish recomputes them. Worth a product decision if
  retro-application is wanted.
- **`POST /api/admin/scoring-rules` expects the full form payload** (the
  admin UI always sends kill + all 8 placements + tie-breakers). A hand-rolled
  partial payload resets the omitted values to zero — an API robustness
  footnote, not reachable from the UI.
- **A fresh seed leaves the overlay token empty** (secure default): overlay
  endpoints answer 403 until an admin rotates/sets a token on /admin/overlays.
- **The landing page is the registration form**, so its "Register team"
  buttons are in-page `#register` anchors; other pages link across. The footer
  CTA and sitemap both include "Register team" by design.
- **A squad with no substitutes** gets a toast instead of the swap dialog.
- **Before a match starts**, the desk shows the lineup with `0/16` alive and
  no player rows (rows are created when the match goes live).
- **The mobile nav drawer** has no `Escape`-to-close (it closes via the
  toggle, overlay tap, or following a link); the desk dialogs are native
  `<dialog>` elements and close on `Escape`.

## Skipped (with reason)

| Item | Reason |
|---|---|
| OBS scene switching, streaming, recording | OBS is not running with obs-websocket (`health_check`: connection refused at 127.0.0.1:4455). No OBS state was touched; overlays were verified in Chromium instead. |
| SMTP e-mail notifications | No SMTP configured in the verification environment — the queue records `skipped` by design (covered by `test_api.py`). |
| Lighthouse scores | `lighthouse` CLI is not installed and `npx` cannot fetch packages in this offline environment. Replaced with explicit budgets: page load < 2.5 s, API latency < 250 ms avg over 25 calls, document transfers < 500 KB (all green). |

## Evidence & artifacts

- Stage scripts: `tests/e2e/{public-site,registration-flows,status-lookup,admin-flows,matches-flows,control-desk,scoring-check,overlays,security-a11y}.js`
  — plain Node + `require('playwright')`, `PASS/FAIL` per check, non-zero exit
  on failure.
- Runner: `scripts/verify.bat` / `scripts/verify.sh`.
- Screenshots (git-ignored, `tests/screenshots/`): every public page at three
  viewports, admin queue/login/matches/rules/control desk, registration
  confirmation, status results, overlay scenes at 1920×1080, mobile nav open.
- Commit trail since the checkpoint: 4 `fix:` (bug table above) + test/doc
  commits (`cd3934b` … final), matching the eleven stages of the brief.
