# Round 2 Report — Registration Site × Broadcast Merge

2026-10-15 · branch `merge/broadcast-into-site` · commits `57fe7b9`, `6d23406`,
`7d75c25`, `faa3149` (+ this report's commit)

Round 2 was the follow-up round after the merge dry run: exactly 4 players per
team, the **original** broadcast overlays served as-is, the control desk card
rebuilt to the reference layout, a configurable BGMI points table / tie-breakers,
and one scoring engine behind every surface.

**Safety:** all runs used the demo/seed DB (`data/demo.db`) or self-hosted temp
DBs. Backup taken before the round: `backups/demo-pre-4players-20261015-205758.db`.
The live registrations DB, uploads and `.env` were not touched; no OBS scene,
stream or recording state was changed.

## What changed

| Stage | Commit | Delivered |
| --- | --- | --- |
| R2-1 | `57fe7b9` | 4 players per team in a match: `player_stats.active` column + DB triggers (hard cap 4), per-match swap route (`POST /api/admin/match/<id>/team/<tid>/swap`) with event + audit log and undo, unassigned finishes ask (`match_team_results.unassigned_finishes`, `team_kill_delta` feeds it), legacy repair (D001 `5 = 4 + 1 unassigned`), `/api/live/state` strips UID + bench. |
| R2-2 | `6d23406` | Original overlays restored and served as-is at `/overlay/<scene>` for the full 16-scene set; `socket.io/socket.io.js` shim bridges `io()` to SSE with a 2 s poll fallback; server-side `legacy_state()` rebuilds the original `tournament:update` payload (numeric ids, `out`→`eliminated`, UID/PII stripped); producer page lists the scenes; caster stat-card push lives server-side only. |
| R2-3 | `7d75c25` | Desk card rebuilt to the reference layout: header (slot badge, tag badge, name + group, FIN · PLACE · PTS, fold), control row (`+ FINISH`, take-back, PLACE stepper + typed pin, AUTO, gear → swap / adjustment / reset), exactly 4 player rows (IGN + UID, DMG stepper, finish counter, Alive/Knocked/Out), wiped squads dim + rank badge, `PLACE TAKEN` conflict badge, stable 3→2→1-column grid. Server: `adjustment` + `adjustment_reason` columns, `adjust_team()` (reason mandatory), `reset_team()`, auto/adjust/reset routes; undo restores adjustments. |
| R2-4 | `faa3149` | Configurable points table (default 10/6/5/4/3/2/1/1, 9th+ = 0, +1/finish, adjustments) with per-change audit on `/admin/matches`; ordered configurable tie-breakers (default: wins → placement points → finish points → last-match placement) as chips with add/move/remove; `finishPoints` on rows; CSV exports `/api/admin/export/standings.csv` (published overall, admin-gated + logged) and `/api/admin/export/match/<id>.csv` (per-match, includes adjustment + reason). |
| R2-5 | this commit | Operator dry run `scripts/dry-run.js` (27/27 checks), screenshots `qa-shots/r25-*`, this report. |

`/live`, `/results`, the overview tables, the CSV exports and every overlay
scene read the same scoring engine — no duplicate score math anywhere.

## The overlay files — served as-is, one documented line

All overlay markup, styling and art are **byte-identical restores** of the
original broadcast front-end (blob-level check against `b91ccef:broadcast-src/public/`):

- `public/overlay.html` ✓ identical · `public/overlay.css` ✓ identical
- 6 assets at `public/assets/` (2 `.webp`, 4 `.svg`) ✓ identical
- `public/socket.io/socket.io.js` — the SSE bridge shim (a new file, not an overlay edit)

The only change to any overlay file is **one line in `public/overlay.js`**, so
pretty URLs `/overlay/<scene>` can pin a scene without touching live state:

```js
- const PREVIEW_SCENE=(()=>{try{const v=new URLSearchParams(location.search).get('scene');return v&&BROADCAST_STATES_PREVIEW.includes(v)?v:''}catch{return ''}})();
+ const PREVIEW_SCENE=(()=>{try{const v=new URLSearchParams(location.search).get('scene');if(v&&BROADCAST_STATES_PREVIEW.includes(v))return v;const seg=(location.pathname.split('/').pop()||'').toLowerCase();return seg&&BROADCAST_STATES_PREVIEW.includes(seg)?seg:''}catch{return ''}})();
```

### Scene coverage

The original set ships 16 states, all served: `pre-show`, `stream-start`,
`countdown`, `caster`, `format`, `lineup`, `live`, `chicken-dinner`,
`frag-leaders`, `results`, `overall`, `mvp`, `map-feed`, `intermission`,
`technical-difficulties`, `hidden`.

Not re-created (they only existed in round 1's themed set, which the original
artwork replaced): `teams-alive`, `team-status-strip`, `elimination-popup`,
`team-intro`, `sponsor-bug`; the old `break-screen` maps to `intermission`.
These can be rebuilt in the original style later if wanted.

## Verification

Command-line suites on the exact app code (no app-code change after R2-4):

| Suite | Result |
| --- | --- |
| `python tests/test_broadcast.py` | **139/139** |
| `python tests/test_api.py` | **104/104** |
| `python tests/test_admin.py` | **94/94** |
| `npx playwright test` | **8/8** |
| `node scripts/verify-broadcast.js` | green — 16/16 overlay scenes at 1920×1080, admin pages at 1440/768/390, no console errors |
| `node scripts/dry-run.js` (R2-5) | **27/27, exit 0** |

### The R2-5 operator dry run

`scripts/dry-run.js` runs the whole journey on a match it creates itself (so it
is repeatable and does not depend on seeded state):

1. login → pick a lobby group (`DRY_GROUP`, default Group A) → create the match
   + check in its squads → open it on the desk → **Start Match**.
2. Asserts **exactly 4 players on every squad card**, each with IGN + UID.
3. Scores it through the UI: `+ FINISH` on PXRA; 1 kill + 100 dmg on DZKG;
   statuses out/knocked; `+2` manual adjustment with reason on LOOT.
4. Squads wipe → AUTO seats them in elimination order: PXRA 4th (4+1 = 5 pts),
   DZKG 3rd (5+1 = 6), LOOT 2nd (6+2 = 8), Blue Zone Bandits lone survivor 1st (10).
5. Publish gating: blocked while squads are unplaced; a duplicate placement is
   rejected with the `PLACE TAKEN` badge; then **Verify and publish**.
6. Confirms the points everywhere, baseline-relative (history before/after, so
   seed state can't make it brittle): `/api/live/state` overall sums, `/live`
   overall table, `/results` match card (`Match #5 · 🏆 Blue Zone Bandits 1º ·
   0K · 10pts`) + overall totals row, and the overlay payloads (`matchHistory`
   entry for the match with exact match points, elimination-ordered placements,
   `placementPoints` excluding the adjustment, standings equal to the engine,
   no UID/email leaked).

Run: `BGMI_DB=data/demo.db BGMI_ADMIN_USER=… BGMI_ADMIN_PASSWORD=…`
`node scripts/dry-run.js http://127.0.0.1:8080`. Each run leaves its match
published by design (it is a completed demo match).

### Screenshots (`qa-shots/`, gitignored)

- Dry run: `r25-desk-1440.png`, `r25-desk-390.png` (mid-match), `r25-desk-published.png`,
  `r25-live-1440.png`, `r25-results-1440.png`,
  `r25-overlay-{overall,results,map-feed,live}.png`
- Full visual smoke: `overlay-*.png` (all 16 scenes), `admin-{control,matches,overlays,caster}-{1440,768,390}.png`
- R2-4 tie-breaker editor: `admin-matches-scoring.png`

## Bugs found and fixed during the round

1. **Dead tie-breakers at standings level** — `overall_sort_key` read snake_case
   keys while the standings builder emits camelCase; the placement-points,
   finish-points and last-placement breakers never fired. Both spellings are read
   now, with a regression test proving a genuine tie resolves on last-match
   placement.
2. **Publishing dropped manual adjustments** — `publish_match` re-scored without
   the `adjustment` column; fixed (dry run asserts LOOT ends on 8 = 6 + 2).
3. **Documented behavior, not a bug:** the legacy overlay payload's
   `placementPoints` is table-only; the manual adjustment shows in `matchPoints`.
   The dry run pins both values so future edits can't drift.

## Unfinished / known gaps

- The 5 themed extra scenes above are not in the original set (see "Scene coverage").
- The caster stat-card is a server-side push in the caster dashboard; the
  original set has no dedicated on-stream card scene.
- Nothing else outstanding: all round-2 items (4-player rule, original overlays,
  desk cards, points table, one engine, dry run + screenshots + report) are done
  and verified.
