# BGMI Broadcast V4.8 — Tactical Broadcast Arena

An independent community tournament-management and broadcast graphics tool with an original tactical operator background, cinematic overlay motion, tournament-style result tables, and a public spectator standings page. This project is **not an official KRAFTON product** and is not affiliated with KRAFTON. It does not include BGMI game telemetry or proprietary official broadcast assets.

## What's new in V4.7

- New navy / lime competition skin based on the supplied reference layouts: angular rank tabs, slate team rows, logo cells, top-right scan metadata, group color keys, technical grids and an original fictional operator background.
- Live-match HUD with team, finishes, total points and Alive / Knock / Eliminated status bars.
- **Overall standings show all 16 squads on one page: ranks 01–08 in the left table and 09–16 in the right**, each table carrying its own lime column header, the way an official 16-squad standings board is laid out. The match results table that shares the screen with the winner panel keeps its 8-row rotation (1–8 → 9–16 every 8.5 seconds); only the rows animate, never the whole scene.
- Team introduction is a two-slide lineup: 8 team cards on each slide, 4 columns × 2 rows. The selection order follows the saved match lineup.
- Seven-column tournament table: rank, team, chicken-dinner wins, matches played, finishes, placement points and total points. Ranking uses finalized match history.
- New public `/standings` site with the overall points table, current match data, overall fragger list, leader spotlight, recent match results and a registration link.
- New public spectator socket role and sanitized feed. The spectator page and OBS overlay do not receive player UIDs or registration contact records; authenticated operator sockets retain the roster detail needed for admin work.
- Squad Control Center refined with restrained navy/slate cards, subtle lime accent, consistent group tags and quieter status buttons.

## Requirements

- Node.js 20 or newer
- OBS Studio 28 or newer recommended
- MongoDB / MongoDB Atlas optional (local JSON remains usable for rehearsals)

## Upgrade from V4.6 without losing your tournament

1. Stop the existing server with `Ctrl+C` and back up the entire project folder.
2. Extract this ZIP to a **new folder**. The release excludes your private `data/` and `.env` files.
3. To carry the existing tournament forward, copy the following files/folders from the old project into the new one if they exist: `data/tournament.json`, `data/admin.json`, `data/captains.json`, `data/.session-secret`, and `.env`. Keep those files private and never commit them to a public repository.
4. Install and check:

```powershell
npm install
npm run check
npm start
```

5. Open the operator control room at `http://localhost:3000/operator` and the public standings page at `http://localhost:3000/standings`.

## Main URLs

- Operator control room (administrator login required): `http://localhost:3000/operator`
- Team registration portal: `http://localhost:3000/register`
- Transparent OBS overlay: `http://localhost:3000/overlay`
- Public standings and match stats: `http://localhost:3000/standings`
- Sanitized public standings JSON: `http://localhost:3000/api/public/standings`
- Admin-only health API: `http://localhost:3000/api/health`
- Admin-only CSV export: `http://localhost:3000/api/standings.csv`

## Match setup and live squad controls (V4.9)

The live workspace is split into two dedicated pages so a match is easier to run:

- **Match setup** (`Match setup` in the sidebar) — match number, phase, map, team filter and the
  16-squad lineup picker. It closes with a sticky action bar showing `Group · Map · squads selected`
  (including an "unsaved lineup changes" warning).
- **Live squad controls** (`Live squad controls`) — the full-page squad workspace. Pressing
  **Start match** verifies the lineup, starts the match and drops you straight onto this page, where
  every selected squad has one premium card holding its match points, finishes, placement and the four
  player tiles (finish, damage and Alive / Knock / **ELIM** status). Inside every panel the four player
  tiles sit in their **own 2 × 2 grid** — player 1 left, player 2 right, players 3 & 4 on the row below —
  so no player is hidden behind another and every control is a single click away.
- **All 16 squads render on one page** — no paging, no *Next* button to reach squads 9–16. Each card
  follows your saved lineup order and never reorders while you are entering scores.
- A sticky **lobby index** strip lists every squad with its placement, points and health dot; click a
  chip to jump straight to that squad card. `Search`, the `All / Active / Eliminated` filter chips and
  per-squad / bulk collapse narrow the page further.
- **PANELS switch — Auto / 1 / 2 / 3, with a live `2 × 8` readout.** The default is **2 panels side by
  side**: team 1 left, team 2 right, then teams 3 & 4 on the next row — 2 columns × 8 rows for a
  16-squad lobby. Every control (team finish, placement, roster edit, per-player finish, damage and
  status) stays on screen in all four modes.
- An explicit choice is **honoured, not silently overridden**: 2 panels stay 2 panels from 900px
  viewport width upward (laptops, split screens, narrow preview panes), and 3 panels need ~1500px.
  Below 900px it falls back to one column, and the readout turns amber and explains why in its tooltip
  instead of lying. Those floors are chosen so the 2 × 2 player grid inside each panel never gets
  squeezed: at 3 panels the narrowest player tile is still ≈195px wide, at 2 panels ≈144px.
- **Full cards / Short cards density.** Short cards trim the padding, the long labels and the card
  header so a squad card is roughly a third shorter, while keeping the same 2 × 2 player grid. The grid
  only collapses to one player per row below 560px. Both switches are remembered in the browser.

Measured effect on a 1920×1080 operator screen (16-squad lobby, same information): a squad card drops
from ≈520px to ≈344px, which takes the squad list from ≈3.9 screens of scrolling to ≈2.6 — and ≈2.0
with 3 columns. Collapsing all squads compresses the whole lobby into roughly one screen for a fast
overview.

## Automatic placements (positions 9–16 score zero, by rule)

Placements no longer have to be typed in one squad at a time:

1. When a squad's fourth player is marked **ELIM**, the server records the elimination and immediately
   derives the placement — the first squad wiped from a 16-squad lobby is **16th**, the next is **15th**,
   and so on. Positions 9–16 resolve to **0 placement points** straight from the scoring table.
2. The last squad standing is placed **1st** automatically and banks the chicken-dinner placement points.
3. **Every position belongs to exactly one squad.** Placements are always a permutation of 1…16: two
   squads can never hold the same position or the same placement points. The server refuses a duplicate
   outright — typing a position another squad already holds is rejected with
   `Placement N is already taken by TEAM X…` and the original entry is kept. Automatic squads route
   around manually pinned positions instead of colliding with them.
4. **A wipe takes the whole squad, knocked players included.** If three players are knocked and the
   operator marks the last surviving player **ELIM**, there is nobody left to revive them, so all four
   players become eliminated and the squad takes its placement. Marking a player **ALIVE** again brings
   back only the players that the wipe took out (explicitly eliminated players stay out), releases the
   placement and puts the squad back into the fight.
5. A squad's card shows `AUTO` next to its placement, plus a `PLACE PTS` figure (`+0` for 9th–16th,
   `+1` for 8th, and so on), so the rule is visible while you work.
6. **Manual override for re-verification stays available.** Typing a placement pins that squad to
   `MANUAL` and it is never overwritten — the automation keeps recomputing every other squad around it.
   Press `↺ AUTO` on the card, or `↺ Re-derive placements` in the toolbar, to hand it back.
7. The toolbar states what is at stake (`12 alive · next squad wiped takes 5th place`), and warns when
   squads still need a placement. `AUTO PLACEMENTS · ON/OFF` switches the whole lobby to fully manual
   entry, and a match that ends with squads still alive is reported by the existing verify checks so the
   operator can type the remaining positions before publishing.
- The verify flow is unchanged: an operator still presses *Verify & publish* and the server validates
  unique placements before locking the result snapshot — placements are now correct by default instead of
  by hand.
- Two socket events were added for the automation (`placements:auto-mode`, `placements:reset-auto`); all
  existing events (`team:kill`, `player:update`, `player:damage`, `player:kill`, `team:update`,
  `match:configure`, `match:status`, `match:finalize`) behave exactly as before.

## Skip the login while developing (open the dashboard directly)

For local demos, rehearsals and preview sandboxes you can open the operator dashboard without creating an
administrator account or typing a password:

```bash
npm run dev:open        # same server, but DEV_BYPASS_LOGIN=true
```

- `/operator` and `/` go straight to the production dashboard, and `/login` redirects to it.
- Browser requests and the operator socket both receive a temporary `dev-operator` **admin** session, so
  live match controls, broadcast scenes, standings and CSV/health APIs all behave exactly as after a real sign-in.
- The sign-out button is hidden in this mode because signing out would only re-enter the same dashboard.

How it works, and how to turn it off:

- The switch is the environment variable `DEV_BYPASS_LOGIN` (`true`, `1`, `on` or `yes`). It is **off unless
  you set it**, and `npm start` / `npm run dev` keep the normal administrator login.
- Disable it with `DEV_BYPASS_LOGIN=false npm run dev:open`, or by unsetting the variable in your `.env`.
- While the bypass is active the server also relaxes `X-Frame-Options` so the dashboard can be embedded in
  preview panes and OBS browser sources. The flag never writes an administrator password, so turning it off
  restores the normal sign-in screen exactly as before.
- Tournaments, teams, registrations and sessions keep using the regular storage backend (local JSON or
  MongoDB), so nothing is demo-only once you sign in for real.

> Never enable `DEV_BYPASS_LOGIN` on a public or production broadcast server: it grants full operator access
> to anyone who can reach the port.

## Overlay setup in OBS

1. Set OBS base canvas/output to 1920×1080 (16:9) for the included layouts.
2. Add the gameplay/observer capture as a source.
3. Add a Browser Source above gameplay with URL `http://localhost:3000/overlay`, width `1920`, height `1080`, FPS `30`.
4. Keep the source loaded during the show; the operator state updates using Socket.IO.
   To preview one scene in an ordinary browser tab without disturbing the live show, open
   `http://localhost:3000/overlay?scene=overall` (any scene name works: `lineup`, `results`, `live`, …).
   The flag only affects that one tab — OBS and every other viewer keep following the broadcast state.
5. In Broadcast Control, use the existing show flow: stream-start slate → caster → tournament format → team lineup → caster hype → 30-second countdown → live match → current MVP / map feed / results / overall standings.
6. In `Overall standings` every squad is already on screen — 01–08 down the left table, 09–16 down the right — and nothing rotates. In `Match results`, the table beside the winner panel still rotates 1–8 → 9–16 every 8.5 seconds.
7. In `Match lineup`, the saved roster is displayed in order as two slides of eight teams. For live lineup data, confirm the match team picker is saved first.
8. For actual OBS scene cuts, set OBS Scene Transitions to Fade (300–500 ms) or use an authorized OBS WebSocket adapter if you add one. The current dashboard changes overlay graphic states; it does not remotely change native OBS scenes.

## Scoring and data notes

- Overall standings use finalized match snapshots. Placement points are read from the stored result if available; older snapshots without that field are back-calculated as `max(0, match points - finishes × current finish-point setting)`. If scoring rules have changed since an older match, verify historical placement-point numbers manually.
- Wins are counted as finalized matches where the team's placement is first.
- A finish, player status, kill or placement is recorded by an operator unless your event has a reliable authorized external feed. This application does not automatically read game telemetry.
- The configured map panel is a static image. A real moving in-game map or observer camera should be added as a dedicated authorized OBS source.
- Player images, logos, tournament brand assets and music must be supplied by the organizer and used with permission. The included tactical operator artwork and HUD elements are original assets designed for this project.

## Public spectator page and privacy

`/standings` is a public page designed for participants and viewers. Its `/api/public/standings` endpoint and `spectator:update` Socket.IO room expose only the fields needed for standings, current match stats, recent results, and fragger information. They do not include registration records, contact information, audit history or BGMI player UIDs. The overlay uses a separate sanitized display payload too. Operator sockets remain authenticated and receive the UID fields necessary for roster verification.

Public viewers can browse the standings and stats, but only authenticated administrators can change tournament state or control broadcast scenes. The public page is read-only.

## Master reset (admin protected)

Rehearsals leave numbers everywhere, so the dashboard carries a single **⟲ Reset all data…** button in the
**Match setup** action bar (next to *Save match & lineup*, *Start match*, *End & review results* and
*Reset current inputs*). A second entry point lives in **Tournament setup → Reset tournament data**.

The reset erases, for the whole event:

- the live lobby — finishes, placements, damage and Alive/Knock/Eliminated status of every squad;
- live standings and current-match points;
- the overall standings — total points, finishes, placement points and matches played;
- finalized match history and the recent-results feed;
- the MVP spotlight selection and the overall top-fragger leaderboard;
- the match number/status, broadcast scene, countdown timers and the event log.

It deliberately **keeps team registration data**: the registration desk, approved squads and their
rosters, group allocation, scoring rules, qualification slots and production identity all survive. The
match lineup is rebuilt from the approved squads in the current group so the next rehearsal starts on
real teams.

The reset only runs with the **reset protection password** — a special password the administrator sets in
**Tournament setup → Reset protection password**, separate from the login password. It is stored as a
bcrypt hash in `data/reset-password.json` (0600, never committed) and is asked for on every wipe.
Incorrect attempts are rate-limited (10 per 15 minutes per address) and logged in the audit trail.
Changing the password asks for the administrator login password again, which also recovers a forgotten one.

The dialog also offers a **Factory reset** option, which additionally erases team registrations and
approved rosters. Both scopes require the reset password.

## Collapsible navigation panel

The operator top bar carries a hamburger button (left of the page title). Click it to fold the left
navigation panel away and give the live squad controls — or any wide table — the whole screen; click it
again to bring the panel back. While the panel is hidden a small floating button sits at the bottom-left
so it can be reopened anywhere on a long page, and the choice is remembered per browser
(`localStorage → bgmi.sidebarHidden`). On screens 1600px or wider the live-controls grid gains a third
squad column once the panel is out of the way.

## Security notes

- Keep local development bound to `127.0.0.1` unless you configure a secure hosted deployment.
- The reset protection password is a second, purpose-built credential for the destructive master reset. Keep `data/reset-password.json` private together with `data/admin.json`.
- Public registration still requires captain login and server-side validation. Email/SMS ownership verification and CAPTCHA require a configured provider; they are not automatically supplied here.
- The public standings route intentionally has no login because it is the viewer page. It returns sanitized tournament information only.
- Before hosting for a public event, configure HTTPS, a strong session secret, secure cookie settings, restricted MongoDB credentials, backups, and contact verification/anti-abuse checks. This project has not undergone a professional penetration test.

## Check and rehearsal

Run `npm run check`. It checks JavaScript syntax in the backend, operator, registration, login, overlay and public standings scripts. This is not a substitute for a live integration test. Before streaming:

1. Verify `/operator` still requires admin authentication.
2. Verify `/standings` opens without an account and contains no UID/contact fields in the network payload.
3. Add sample team logos and player portraits; confirm bad image URLs fall back cleanly.
4. Start a test match and change a team's finishes/status; check the live HUD.
5. Show Overall Standings; confirm all 16 squads are visible at once in two tables (01–08 left, 09–16 right) with the title and background stable. Show Match Results; confirm the right-hand table still rotates 1–8 then 9–16.
6. Show the team lineup; confirm slide one is squads 1–8 and slide two is 9–16 in saved lineup order.
7. Check readability and browser-source frame rate at the actual OBS canvas size.
8. Rehearse scoreboard, audio, countdown, game capture, recording and recovery before a real event.

## Independence notice

The included color treatment, angular table structures and cinematic motion are an original implementation inspired by general esports broadcast techniques and the user-provided reference screenshots. The operator character is fictional and original. No official KRAFTON/BGMI logo or official character asset is bundled.


## V4.8 — Results Arena & live table

- Live match composition now hides the generic broadcast header and single-player top-fragger box. A configurable match identity panel sits left, and an overall 16-team points table sits right with finishes, total points, matches and current squad status.
- Team lineup shows all 16 teams in one frame: positions 1–8 on the left and 9–16 on the right.
- Results scene keeps the chicken-dinner squad and four player stats pinned on the left while the results table rotates between placements 1–8 and 9–16 on the right. The overall standings board instead shows all 16 squads at once, 01–08 left and 09–16 right, each table with its own header.
- Match finalization opens the chicken-dinner spotlight first. Use the Results scene afterward for the pinned-winner + standings composition.
- Added individual damage entry (0–50,000) to the operator squad cards; damage is saved with match snapshots and totals appear on the winner graphic.
- Added a five-player overall frag-leaders screen. Player avatars are used when provided; otherwise original fictional tactical-operator art is used as a fallback.
- Configure live stage, day/session, group caption and match caption in Broadcast Control → Show Package. Leave group/match caption blank to use the current match details.
- Public overlay/spectator feeds omit player UIDs as before. Damage stats are public presentation data; operator registration/contact information is not.


## V4.8.1 — Match-day layout refinement

- Live timer is bottom-left over the full-screen caster.
- Live HUD uses the compact, editable tournament identity plate on the left and the rolling 16-team cumulative points table on the right. The redundant generic broadcast header and top-fragger card are hidden while live.
- Lineup roster shows all 16 teams on one page, with teams 1–8 on the left and teams 9–16 on the right.
- Match results pins chicken-dinner team/player data on the left while only the table pages 1–8 and 9–16 rotate on the right.
- Chicken-dinner view displays four players, individual finishes and damage, team finishes, total damage and match points. If a player portrait is absent, the original four-operator group illustration is used as a visual fallback.
- Overall frag leaders displays five players on one screen.
- Broadcast stage, day/session, group label and match caption remain editable under Show Package.


### V4.8 final show rehearsal checklist

1. Open Broadcast Control → Show Package and set the stage, day/session, group label, and caption. Event logo URL supplies the editable logo tile.
2. Match lineup: select 16 teams and ensure they appear in one frame, 8 stacked left and 8 stacked right.
3. Hype timer: select the 30-second timer. Verify the timer remains bottom-left over the full-screen caster; it should turn the overlay to the live HUD at zero.
4. Live HUD: confirm only the right-side 16-team table and left editable match-info plate are shown; no generic top header or top-fragger box should appear.
5. Frag leaders: show five rows at once.
6. Verify final placements, then finalize: the chicken-dinner scene should appear first and show all four player finishes/damage, team total finishes/damage, and match points.
7. Select Match Results: the winner spotlight must stay fixed at left while the 8-row table on the right switches from ranks 1–8 to 9–16.


## V4.9 — 16-squad overall standings board (Krafton-style two tables)

- The `Overall standings` scene no longer pages 8 squads at a time. All 16 are on one canvas: ranks **01–08 in the left table**, **09–16 in the right**, separated by a gutter and each headed by its own lime column bar, so the board reads like the official 16-squad standings graphic.
- Both tables carry the same seven centred columns — rank badge, squad (logo, name, group), wins, matches played, finishes, placement points and total points — and the frame widens to 1780 px on a 1920×1080 canvas so the two tables get equal, comfortable space.
- Rank accents (the lime edge on the top three) stay on the left table; the right table starts at rank 09 and stays neutral.
- The footer readout now states `TEAMS 01–16 / 16`, the grid kicker says `TACTICAL DATA GRID // LEFT 01–08 · RIGHT 09–16`, and the standings unit reads `01_16`.
- The **Match results** table is unchanged: it shares the canvas with the chicken-dinner panel, so it keeps its single-column 8-row rotation (1–8 → 9–16 every 8.5 seconds).
- Fewer than 9 squads fall back to one full-width table, so a small lobby is never split with an empty right-hand side.
