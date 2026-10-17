# BGMI Cup — OBS broadcast runbook

The one-page operational guide for the BGMI Cup stream setup on this machine.
Everything is built by `scripts/obs/setup_obs.py` and verified by
`scripts/obs/check_obs.py` — this file tells you **when to press what**.

- OBS profile: **BGMI Cup** · Scene collection: **BGMI Cup**
- Canvas/output: 1920×1080 @ 60 fps (30 fps fallback), CBR, 2 s keyframes
- Video encoder: **QSV** (auto-picked; H.264 hardware, low CPU)
- Audio: 48 kHz, AAC 160 kbps
- Recording: `C:\Users\rajpa\Videos\BGMI-Cup-Recordings` — hybrid MP4, HQ
  (never the stream bitrate/container)
- One overlay URL drives everything (producer desk switches scenes — OBS
  follows within a second, no refresh)

## Startup order (every broadcast day)

1. **Phone** — plug USB, unlock it manually once, then run
   `scripts\obs\start_phone_capture.bat` (`start_phone_capture.ps1`).
   It wakes the screen, sets USB stay-on, and starts scrcpy with audio
   forwarding, fixed title `BGMI-PHONE`, high bitrate, 60 fps, no control.
2. **Platform server** — `python server.py` (already running at
   http://127.0.0.1:8080). Start `cloudflared` too if remote overlays matter.
3. **OBS** — double-click `scripts\obs\start_obs.bat` (starts OBS with the
   *BGMI Cup* profile + collection, or says so if it is already running).
4. **Health check** — in a terminal:

   ```
   scripts\obs\.venv\Scripts\python.exe scripts\obs\check_obs.py
   ```

   Every line is `[ok]/[warn]/[fail]`. Fix anything red (usually:
   re-run `setup_obs.py`, or start the phone mirror) until it prints
   **READY**. Options: `--quick` (skip scene-switching probes),
   `--keys` (press F6 in OBS to prove hotkeys), `--soak 120` (2-minute
   fps/CPU/dropped-frame sample).
5. **Stream key** — first time only: OBS → *Settings → Stream*, pick the
   service, paste the key **yourself**. It is never stored in the repo and
   these scripts never start a stream.
6. **Phone in-game** — unlock, open BGMI, turn the ringer/sound up, and
   confirm the **Game Audio** meter moves in OBS when the game makes noise.
   If it does not, see *Phone/audio* troubleshooting below.
7. Press **F4 (GAMEPLAY)** when the phone mirror is on the program, then
   hit *Start Streaming* in OBS when the producer says go.

## Hotkeys

| Key | Scene                 | Shows                                                        |
|-----|-----------------------|--------------------------------------------------------------|
| F1  | PRE-SHOW              | Phone mirror full-screen + overlay                           |
| F2  | STARTING SOON         | Phone mirror + overlay (pre-match hold screen)               |
| F3  | COUNTDOWN             | Caster camera in frame + countdown overlay                   |
| F4  | GAMEPLAY              | Phone mirror + in-game camera frame top-right + overlay      |
| F5  | CASTERS               | Caster camera(s) in frame(s) + overlay                       |
| F6  | INTERMISSION          | Phone mirror + overlay break screen                          |
| F7  | TECHNICAL DIFFICULTIES| Fallback screen while something is being fixed               |
| F8  | ENDING                | End card                                                     |

Hotkeys are bound on the **scenes** (`OBSBasic.SelectScene`), so they work
from any window as long as OBS is focused. They survive OBS restarts.

## Cameras

- **Caster Cam 1** = `USB2.0 HD UVC WebCam` (the only camera plugged in).
  It shows in **frame 1** and is labelled **CAM 01** on the overlay, with the
  caster name underneath (currently `FE_PSYCHO` from the platform DB).
- **Caster Cam 2** — when you plug a second camera, run
  `setup_obs.py` again (`--cameras 2`); it gets **frame 2** and plate
  **CAM 02**. The overlay picks names up from the platform DB
  (`caster.name` / `caster.name2`, fallback `CASTER 2`).
- Frame geometry lives in **`public/camera-frames.json`** — the single
  source of truth read by both the setup script (OBS transforms) and the
  overlay. Change a number there, re-run `setup_obs.py`, and refresh the
  browser source if the overlay is already open.
- **Live cam corner = top-right**, because the in-game HUD owns the other
  corners: minimap + kill feed top-left, joystick bottom-left,
  fire/weapon/ammo bottom-right, compass top-centre. In caster scenes the
  camera sits in the left panel with the caster name and tagline beside it.
- URL switches: `?frame=off` hides the frame entirely, `?frames=2` shows
  two frames. The setup script sets these automatically to match the wired
  cameras (`&frame=off` when none).

## Producer desk & overlay states (the 16 scenes)

Everything on screen (except the phone and cameras) is the **Program
Overlay** browser source. Open `/admin/overlays`, and press the scene
buttons in the “Program output” row — the OBS source follows within a
second:

`pre-show · stream-start · countdown · caster · format · lineup · live ·
chicken-dinner · frag-leaders · results · overall · mvp · map-feed ·
intermission · technical-difficulties · hidden`

- Score changes on the control desk (`/admin/control`: kills +1/−1,
  damage, placement, undo `U`) appear on the overlay live — no OBS touch.
- `hidden` blanks the overlay while the phone/camera keeps running.
- **Phone Offline Notice** (GAMEPLAY): if the phone mirror dies, tick the
  eye on that hidden source in OBS to show the fallback card, and hide it
  again when the mirror is back.

## Audio

- **Game audio** comes from the phone via scrcpy (`Game Audio` —
  Application Audio Capture of `scrcpy.exe`). Desktop audio is
  **disabled** on purpose — nothing else leaks into the stream.
- **Mic chain**: RNNoise noise suppression → noise gate (−26/−32 dB) →
  limiter (−6 dB). Adjust the gate in OBS → Mic/Aux → Filters if the room
  is noisy.
- Target levels: game ≈ **−12 dB**, mic ≈ **−10 dB** peaks.
- Monitoring is **off** on all sources.
- ⚠️ **Headphones, not speakers** for the casters. With speakers the mic
  hears the game echo — you get doubled/echoing audio on stream. The gate
  helps but cannot fix that.
- ⚠️ **A/V sync**: USB cameras (especially cheap ones) lag a few frames.
  Do a live check — clap in front of the camera while the phone mic picks
  it up — then use OBS → Caster Cam → *Advanced Audio Properties* /
  source filter *Audio/Video Sync Offset* to nudge it if lips don't match.
- ⚠️ **Bluetooth mics**: a Bluetooth headset cannot record voice while the
  same headset plays audio (HFP vs A2DP). If casters use the Xiaomi
  speaker, use a **wired** mic. “Mic/Aux” follows whatever Windows marks
  as default input.

## Recording (separate from the stream)

- Folder `C:\Users\rajpa\Videos\BGMI-Cup-Recordings`, hybrid MP4 (crash-safe
  until stop), HQ quality — **never** the stream bitrate. Takes and stop
  both work while streaming.
- Test once before the event: *Start Recording* → wait 10 s → *Stop* →
  confirm the file plays → delete it.
- End of stream: **stop the recording first** (it finalizes the MP4), then
  stop streaming, then close the phone mirror.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone screen black/locked on stream | It's an org-managed device — it re-locks. Unlock it; then `adb shell input keyevent KEYCODE_WAKEUP` + `adb shell svc power stayon usb`. Re-run `start_phone_capture.bat` if scrcpy died. |
| Phone mirror window missing | `scripts\obs\start_phone_capture.bat` (keeps the title `BGMI-PHONE` that OBS captures). |
| Overlay blank / “token” errors | Token was rotated or the server restarted with a fresh DB. Re-run `setup_obs.py` (it re-reads the token) and re-open `/admin/overlays`. |
| Overlay didn't pick up a scene press | Check the producer desk says “· on air” on the new scene; give it a second. Worst case right-click the source → *Refresh* (never enable “Refresh when active”). |
| Camera black | Re-plug USB, run `check_obs.py`. A camera that re-enumerates changes its device id — re-run `setup_obs.py` to re-select `Caster Cam 1`. |
| hotkeys dead | OBS must be focused for F-keys; run `check_obs.py --keys` to test. Re-bind happens on the next full `setup_obs.py` run (stop OBS first — the script does that itself). |
| OBS asks for the websocket password | Password lives in `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json` and the `OBS_WEBSOCKET_PASSWORD` env var (also in the gitignored `.env`). Never commit it. |
| Dropped frames / lag | `check_obs.py --soak 120`. If CPU/fps are fine but the stream drops, lower stream bitrate in OBS → Output. For a weak machine run `setup_obs.py --fps 30`. |
| Recording won't start | Ensure the recordings folder exists (setup creates it). |
| Audio echo | Casters on speakers → switch to headphones (see Audio). |
| Something deeply broken | OBS → *Help → Safe Mode*; or restore the backup (below). |

## Restore the pre-change OBS settings (backup)

Backup folder: `C:\Users\rajpa\obs-backups\obs-studio-2026-10-17-165301`
(taken before this setup was built).

1. Close OBS completely.
2. Copy the backup's `profiles\` and `scenes\` folders back over
   `%APPDATA%\obs-studio\basic\`.
3. Start OBS. The old collections/profiles (e.g. *Untitled*) are back.
   (The *BGMI Cup* profile + collection stay in the backup's copy you
   overwrote — keep the backup folder around until you're sure.)

## End-of-stream checklist

- [ ] Stop the **recording** (flushes the MP4) — then stop streaming.
- [ ] Press **F8 (ENDING)** for the end card, then stop streaming in OBS.
- [ ] Close the phone mirror window (`scrcpy`).
- [ ] Rotate the overlay token if the URLs were shared publicly
      (`/admin/overlays` → *Rotate token* → re-run `setup_obs.py`).
- [ ] Back up the database (`python scripts\backup_db.py`).

## Environment variables (remote/Railway overlays)

Local overlays need nothing. To point OBS at a deployed copy, set these
**once** in a new terminal, then re-run `setup_obs.py`:

```
setx BGMI_BASE_URL "https://<your-app>.up.railway.app"
setx BGMI_OVERLAY_TOKEN "<paste from /admin/overlays>"
```

Then `check_obs.py` should show the overlay URL with
`token=***` redacted but pointing at your domain. Keep the token out of
chats and tickets — rotating it invalidates every old URL.

## Rebuilding / changing things

| Want | Command |
|---|---|
| Rebuild everything (idempotent) | `scripts\obs\.venv\Scripts\python.exe scripts\obs\setup_obs.py` |
| 30 fps fallback | `... setup_obs.py --fps 30` |
| 0/1/2 cameras | `... setup_obs.py --cameras 2` (or `--cam1 "Name"`/`--cam2 "Name"`) |
| Force an encoder | `... setup_obs.py --encoder nvenc` (default `auto`) |
| Fast tweak without an OBS relaunch | add `--no-restart` |
| Verify | `... check_obs.py` (`--quick`, `--keys`, `--soak 120`) |

The setup script exits OBS gracefully, patches the scene-collection JSON
(hotkeys + global audio devices have no websocket API), writes a
token-free export to `scripts/obs/scene-collection-export.json`, and
relaunches OBS. It never touches the stream key or starts a stream.
