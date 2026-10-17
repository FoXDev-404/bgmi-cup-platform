# BGMI Cup — OBS broadcast runbook (v2)

The one-page operational guide for the BGMI Cup stream setup on this machine.
The easy way in: open the **`Setup`** folder in the project and double-click
the numbered files **1 → 4** in order. Under the hood they run
`scripts\obs\setup_obs.bat` (build/repair) and `scripts\obs\check_obs.bat`
(verify) — this file tells you **when to press what**.

- OBS profile: **BGMI Cup** · Scene collection: **BGMI Cup v2**
- Canvas/output: 1920×1080 @ 60 fps, CBR, 2 s keyframes, encoder **QSV**
- Audio: 48 kHz, AAC 160 kbps
- 16 scenes, each with its **own** browser source
  (`<SCENE> · <overlay>` → `/overlay/<overlay>?token=***`)
- Default transition: **Fade 300 ms** · Studio Mode **off** (hotkeys go
  straight to air)
- Recording: `C:\Users\rajpa\Videos\BGMI-Cup-Recordings` — hybrid MP4, HQ
  (never the stream bitrate/container)

## First run on a new machine (fresh clone)

1. Install **OBS Studio 28+** (the WebSocket server is built in) and
   **Python 3**, open OBS once, then set the websocket password where the
   scripts can read it: `setx OBS_WEBSOCKET_PASSWORD "<from OBS → Tools →
   WebSocket Server Settings>"` (or add it to the repo `.env`).
2. Build the tooling venv once:
   `powershell -ExecutionPolicy Bypass -File scripts\obs\setup_env.ps1`.
3. Start the platform once (`Setup\1 - Start Platform Server.bat`) so the
   database and the overlay token exist, then run
   `Setup\Rebuild OBS Setup.bat` — it creates the OBS profile and the whole
   16-scene collection from scratch on this machine. From then on it is the
   normal 1 → 4 routine below.

## Startup order (every broadcast day)

Everything you need is in the **`Setup`** folder — double-click the numbered
files in order, then go live.

1. **Platform server** — `Setup\1 - Start Platform Server.bat`
   (http://127.0.0.1:8080; says so if it is already running). Start
   `cloudflared` too if remote overlays matter.
2. **Phone** — plug USB, unlock it manually once, then
   `Setup\2 - Start Phone Mirror.bat`. It wakes the screen, keeps it on,
   and starts scrcpy with audio forwarding, fixed window title
   `BGMI-PHONE`, high bitrate, 60 fps, no control.
3. **OBS** — `Setup\3 - Start OBS.bat` (profile *BGMI Cup*, collection
   *BGMI Cup v2*; says so if OBS is already running).
4. **Health check** — `Setup\4 - Check Everything.bat`.

   Every line is `[ok]/[warn]/[fail]`; it prints **READY** when nothing is
   red. It verifies, per scene: source list + lock, its own browser source
   (name, URL, scene match, token present), shutdown/refresh flags, camera
   positions, hotkeys, transition. Options when run from a terminal:
   `--quick` (skip scene-switching probes), `--keys` (presses F1 + Ctrl+F3
   for a real hotkey test), `--shots` (one screenshot per scene →
   `docs/obs/screenshots/v2/` and a distinct-content check), `--soak 120`
   (2-minute fps/CPU/GPU/dropped frame sample).
5. **Stream key** — first time only: OBS → *Settings → Stream*, paste the
   key **yourself**. Never stored in the repo; these scripts never start
   a stream.
6. **Phone in-game** — unlock, open BGMI, sound up, confirm the **Game
   Audio** meter moves in OBS when the game makes noise.
7. Press the scene hotkey you need (below) and *Start Streaming* when the
   producer says go.

## Hotkeys and what each scene is for

| Key | Scene | Purpose |
|-----|-------|---------|
| F1 | PRE-SHOW | Transparent lower bar over the phone feed (pre-broadcast hold) |
| F2 | STARTING SOON | Full slate: tournament logo + “we go live” timer |
| F3 | COUNTDOWN | Caster cam in the left frame + match-start countdown |
| F4 | FORMAT | Points table / format slate |
| F5 | LINEUP | Dropping team lineup slate |
| F6 | CASTERS | Caster cam(s) + names for the commentary intro |
| F7 | GAMEPLAY | Phone mirror + live scoreboard + corner cam + info strip |
| F8 | CHICKEN DINNER | Winner celebration panel over gameplay |
| F9 | FRAG LEADERS | Top-frag leaderboard panel |
| F10 | RESULTS | Match results table |
| F11 | OVERALL | Overall standings |
| F12 | MVP | Player spotlight |
| Ctrl+F1 | MAP FEED | Full-screen map / zones feed |
| Ctrl+F2 | INTERMISSION | Break slate |
| Ctrl+F3 | TECHNICAL DIFFICULTIES | Fallback slate while fixing |
| Ctrl+F4 | ENDING | End card |

Hotkeys are bound on the **scenes** (`OBSBasic.SelectScene`) in the saved
collection — they survive restarts. F-keys need **OBS focused** (that is how
libobs captures global hotkeys); check with `check_obs.bat --keys`.

## How the scenes are wired (the v2 rule)

The old single **Program Overlay** source is gone for good. The root rule:

> **One browser source lives in exactly one scene.** No source and no URL is
> ever shared between scenes; every scene owns `<SCENE> · <overlay>`, and its
> URL path matches that scene's own overlay (`/overlay/<overlay>`).

Layers, bottom → top:

- **Full slates** (PRE-SHOW, STARTING SOON, COUNTDOWN, FORMAT, LINEUP,
  CASTERS, INTERMISSION, TECHNICAL DIFFICULTIES, ENDING): a black
  `<SCENE> · background` color source, then the scene's browser source.
- **Gameplay panels** (GAMEPLAY, CHICKEN DINNER, FRAG LEADERS, RESULTS,
  OVERALL, MVP, MAP FEED): the nested scene **BASE - GAMEPLAY**, then — for
  GAMEPLAY/CASTERS/COUNTDOWN only — the camera(s), then the scene's browser
  source on top.
- **BASE - GAMEPLAY** shares the hardware: `Phone Capture` (Window Capture of
  `BGMI-PHONE`, fitted to canvas), `Phone Offline Notice` (visible only when
  scrcpy wasn't running at setup time), `Game Audio`. Cameras intentionally
  sit *outside* BASE: their frames exist only in live/caster overlay states,
  and each scene needs a different position.
- The offline notice is **not** locked — if the phone comes back without a
  script run, just hide it (eye icon) in OBS.

Browser-source flags per overlay type (set by the script):

- `live` and `map-feed` (steady panels): *Shutdown when not visible* **off**,
  *Refresh browser when scene becomes active* **off** (never blank mid-air).
- Everything else (animated / event overlays): both **on** — the page loads
  fresh when the scene takes air.

## Live data (no OBS touching mid-show)

Every overlay page pulls `/api/overlay/state/<overlay>` with the token and
subscribes to an SSE stream, so anything you change on the control desk
(`/admin/control`), the overlays page, or the Railway site appears within
about a second — no source refresh, no scene reload. Screenshots of a real
desk change flipping the on-air logo live are in
`docs/obs/screenshots/v2/live-update/`.

- Scene switching mid-show = **press the hotkey**. Do not use the producer
  desk's “Program output” buttons (v2 pins each scene to its own overlay).
- `hidden` overlay (`/overlay/hidden`) is available via a browser source if
  you ever want it — the ENDING scene stays fully blank.

## Cameras

- **Caster Cam 1** = `USB2.0 HD UVC WebCam`. Shows as CAM 01 in the caster
  frame (COUNTDOWN/CASTERS) and in the live corner frame (GAMEPLAY), with the
  caster name from the platform DB underneath (`FE_PSYCHO` today).
- **Camera 2** — plug it in, then run `Setup\Rebuild OBS Setup.bat`
  (auto-detects; from a terminal pass `--cameras 2` / `--cam1 "Name"`).
  It gets frame 2/CAM 02 and the overlay switches to the two-frame layout
  automatically.
- Frame geometry lives in **`public/camera-frames.json`** — the single
  source of truth for both the OBS transforms and the overlay. Change a
  value, run `Setup\Rebuild OBS Setup.bat`.
- URL switches: `?frame=off` = no frame (fewer cams), `?frames=2` = two
  frames. The setup script sets these to match what is wired.

## Audio

- **Game audio** = Application Audio Capture of `scrcpy.exe` (`Game Audio`
  source). Desktop audio is disabled on purpose.
- **Mic chain**: RNNoise noise suppression → noise gate (−26/−32 dB) →
  limiter (−6 dB). Monitoring is off everywhere.
- Target levels: game ≈ −12 dB, mic ≈ −10 dB peaks.
- ⚠️ Use **headphones** at the caster desk. Speakers let the mic re-hear the
  game (echo). The gate cannot fix that.
- ⚠️ **A/V sync**: cheap USB cams lag a few frames — clap check, then nudge
  with *Advanced Audio Properties / Audio-Video Sync Offset* if needed.
- ⚠️ Bluetooth headsets can't record and play at once (HFP vs A2DP) — use a
  wired mic.

## Recording (separate from the stream)

- Folder `C:\Users\rajpa\Videos\BGMI-Cup-Recordings`, hybrid MP4 (crash-safe
  until stop), HQ — never the stream bitrate. Takes work while streaming.
- **Verified**: a 15 s test take was recorded and finalized through OBS's
  own pipeline, then deleted (the folder is kept clean).
- End of stream: stop the **recording** first, then stop streaming, then
  close the phone mirror.

## Changing one overlay URL (safely)

The only two rules: it must point at **that scene's own overlay**, and it
must carry a **valid token**.

1. Preferred: rotate/change via the platform — `/admin/overlays` → *Rotate
   token* — then run **`Setup\Rebuild OBS Setup.bat`**; it rewrites all 16
   URLs from the database and you are done.
2. Or edit one source manually: right-click its browser source →
   *Properties* → the URL is
   `<BGMI_BASE_URL>/overlay/<that-scene's overlay>?token=<token>` — 1920×1080,
   no custom CSS, hardware acceleration on. Never copy a URL from another
   scene's source.
3. Run **`Setup\4 - Check Everything.bat`** — it fails loudly if any
   URL/name/token does not match its scene or if anything is shared.

To point OBS at the deployed (Railway) copy instead of localhost, set these
**once** and run **`Setup\Rebuild OBS Setup.bat`**:

```
setx BGMI_BASE_URL "https://<your-app>.up.railway.app"
setx BGMI_OVERLAY_TOKEN "<copy from /admin/overlays>"
```

(The token is read from the environment / local DB — the scripts never
print it. Keep it out of chats and tickets.)

## Troubleshooting

Table shorthand: `setup_obs.bat` = **`Setup\Rebuild OBS Setup.bat`**,
`check_obs.bat` = **`Setup\4 - Check Everything.bat`**.

| Symptom | Fix |
|---|---|
| One scene's overlay blank / token error | `check_obs.bat` says which scene; usually the token was rotated → re-run `setup_obs.bat`. |
| Wrong overlay on a scene | Someone edited URLs — re-run `setup_obs.bat` (it restores the canonical map) and `check_obs.bat` to confirm. |
| Phone black/locked on stream | Org-managed device re-locks. Unlock it; then `adb shell input keyevent KEYCODE_WAKEUP` + `adb shell svc power stayon usb`; restart the mirror. |
| Phone mirror window missing | `scripts\obs\start_phone_capture.bat` (keep the `BGMI-PHONE` title). Then re-run `setup_obs.bat` so `Phone Capture` binds to it. |
| “Phone Offline Notice” card visible during gameplay | It was up when the setup last ran (scrcpy down). Start the mirror and re-run `setup_obs.bat`, or just hide the source with the eye in OBS. |
| Camera black | Re-plug USB, run `check_obs.bat`; if the device id changed, re-run `setup_obs.bat`. |
| Hotkeys dead | F-keys need OBS focused; test with `check_obs.bat --keys`; re-run `setup_obs.bat` to re-bind. |
| Overlay didn't update after a desk change | Give it a second; if stuck, right-click that scene's browser source → *Refresh*. |
| OBS asks for the websocket password | It lives in `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json` and the `OBS_WEBSOCKET_PASSWORD` env var (gitignored `.env`). |
| Dropped frames / lag | `check_obs.bat --soak 120`. If the machine is weak, `setup_obs.bat --fps 30`. |
| Something deeply broken | OBS → *Help → Safe Mode*, or restore the backup below. |

## Restore the old setup (backup)

Backup taken before v2: `C:\Users\rajpa\obs-backups\obs-studio-20261017-202707`.

1. Close OBS completely.
2. Copy the backup's `profiles\` and `scenes\` folders back over
   `%APPDATA%\obs-studio\basic\`.
3. Start OBS — the old scene collection (**BGMI Cup**, 1 scene) and any
   older profiles are back. The v2 collection file stays in the folder, so
   you can switch between them in *Scene Collection* at any time.

## End-of-stream checklist

- [ ] Stop the **recording** (finalizes the MP4), then stop streaming.
- [ ] Press **Ctrl+F4 (ENDING)**, then stop streaming if you haven't.
- [ ] Close the phone mirror window (scrcpy).
- [ ] Rotate the overlay token if the URLs were shared publicly
      (`/admin/overlays` → *Rotate token* → re-run `setup_obs.bat`).
- [ ] Back up the database (`python scripts\backup_db.py`).

## Rebuilding / changing things

| Want | Command |
|---|---|
| Rebuild everything (idempotent) | double-click `Setup\Rebuild OBS Setup.bat` |
| 30 fps fallback | `setup_obs.bat --fps 30` |
| 0/1/2 cameras | `setup_obs.bat --cameras 2` (or `--cam1 "Name"` / `--cam2 "Name"`) |
| Force an encoder | `setup_obs.bat --encoder nvenc` (default `auto`) |
| Fast tweak without OBS relaunch | `setup_obs.bat --no-restart` |
| Verify | double-click `Setup\4 - Check Everything.bat` (`--quick`, `--keys`, `--shots`, `--soak 120`) |

The build exits OBS gracefully, patches the scene-collection JSON
(hotkeys + global audio devices have no websocket API), writes a token-free
export to `scripts/obs/scene-collection-export.json`, and relaunches OBS. It
never touches the stream key and never starts a stream.
