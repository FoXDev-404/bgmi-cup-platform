"""Broadcast readiness check for the BGMI Cup OBS setup.

One command, green/red output:

    scripts\\obs\\.venv\\Scripts\\python.exe scripts\\obs\\check_obs.py

Every line is [ok] / [warn] / [fail]; the exit code is 0 only when no
[fail] line was printed. Secrets (the overlay token and the websocket
password) are never displayed - URLs get token=***.

Options:
    --quick   skip the checks that briefly switch the program scene
              (camera feed probe, audio-meter sample)
    --keys    functional hotkey test: focuses OBS and presses F6, then
              restores the scene (never runs blind - the foreground
              window must be OBS)
    --soak N  sample OBS stats for N seconds (fps, CPU, dropped frames)
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import time

import obs_config
import obs_ws
import setup_obs
from obs_ws import Obs

FAILS = 0
WARNS = 0
OBS_LIVE = False                    # streaming or recording right now


def ok(msg):
    print("  [ok]   %s" % msg)


def warn(msg):
    global WARNS
    WARNS += 1
    print("  [warn] %s" % msg)


def fail(msg):
    global FAILS
    FAILS += 1
    print("  [fail] %s" % msg)


def info(msg):
    print("   %s" % msg)


def step(title):
    print("\n== %s ==" % title)


def redact(text):
    return re.sub(r"token=[^&\s\"']+", "token=***", text or "")


def _flatten_numbers(node, out):
    """Collect every number in a nested list (meter levels are nested)."""
    if isinstance(node, list):
        for child in node:
            _flatten_numbers(child, out)
    elif isinstance(node, (int, float)):
        out.append(float(node))


# ---------------------------------------------------------------------------
# small OBS helpers
# ---------------------------------------------------------------------------


def profile_param(o, category, name):
    data = o.try_req("GetProfileParameter",
                     {"parameterCategory": category,
                      "parameterName": name}) or {}
    return data.get("parameterValue") or ""


def input_settings(o, name):
    data = o.try_req("GetInputSettings", {"inputName": name}) or {}
    return data.get("inputSettings") or {}


def build_items_map(o):
    """{scene: {source: {"id":, "enabled":, "index":}}}"""
    out = {}
    for scene in setup_obs.SCENES:
        data = o.try_req("GetSceneItemList", {"sceneName": scene}) or {}
        items = {}
        for item in data.get("sceneItems", []):
            items[item.get("sourceName")] = {
                "id": item.get("sceneItemId"),
                "enabled": bool(item.get("sceneItemEnabled", True)),
                "index": int(item.get("sceneItemIndex") or 0),
            }
        out[scene] = items
    return out


def item_transform(o, scene, source, items_map):
    item = items_map.get(scene, {}).get(source)
    if not item or item["id"] is None:
        return None
    data = o.try_req("GetSceneItemTransform",
                     {"sceneName": scene, "sceneItemId": item["id"]}) or {}
    return data.get("sceneItemTransform")


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------


def check_version_profile(o, args):
    step("OBS, profile, collection")
    version = o.req("GetVersion")
    ok("OBS %s / obs-websocket %s"
       % (version.get("obsVersion"), version.get("obsWebSocketVersion")))
    profile = (o.req("GetProfileList") or {}).get("currentProfileName")
    if profile == setup_obs.PROFILE_NAME:
        ok("profile %r is current" % profile)
    else:
        fail("profile is %r, expected %r - run setup_obs.py"
             % (profile, setup_obs.PROFILE_NAME))
    collection = (o.req("GetSceneCollectionList") or {}).get(
        "currentSceneCollectionName")
    if collection == setup_obs.COLLECTION_NAME:
        ok("scene collection %r is current" % collection)
    else:
        fail("scene collection is %r, expected %r - run setup_obs.py"
             % (collection, setup_obs.COLLECTION_NAME))
    studio = o.req("GetStudioModeEnabled").get("studioModeEnabled")
    if studio:
        warn("Studio Mode is ON - every scene switch needs the Take button; "
             "turn it off unless you use it deliberately")
    else:
        ok("Studio Mode is off (hotkeys switch straight to air)")


def check_video(o, args):
    step("Video / output")
    vs = o.req("GetVideoSettings")
    if (int(vs.get("baseWidth", 0)), int(vs.get("baseHeight", 0))) == (1920, 1080):
        ok("canvas 1920x1080")
    else:
        fail("canvas is %sx%s, expected 1920x1080"
             % (vs.get("baseWidth"), vs.get("baseHeight")))
    if (int(vs.get("outputWidth", 0)),
            int(vs.get("outputHeight", 0))) == (1920, 1080):
        ok("output scaled 1920x1080")
    else:
        fail("output is %sx%s, expected 1920x1080"
             % (vs.get("outputWidth"), vs.get("outputHeight")))

    fps_int = profile_param(o, "Video", "FPSInt")
    fps_common = profile_param(o, "Video", "FPSCommon")
    fps = 0
    for candidate in (fps_int, fps_common):
        try:
            value = float(candidate)
        except (TypeError, ValueError):
            continue
        if value > 0:
            fps = int(round(value))
            break
    if fps >= 60:
        ok("frame rate %d fps" % fps)
    elif fps == 30:
        warn("frame rate 30 fps (fallback) - use 60 if the machine holds it")
    else:
        fail("frame rate reads %r - set Video > FPS to 60 in OBS"
             % (fps_int or fps_common))
    return fps


def check_output_profile(o, args):
    step("Stream / recording profile")
    mode = profile_param(o, "Output", "Mode")
    if mode.lower() == "simple":
        ok("output mode: Simple (CBR stream, 2 s keyframes default)")
    else:
        warn("output mode is %r, expected Simple" % mode)
    stream_enc = profile_param(o, "SimpleOutput", "StreamEncoder")
    rec_enc = profile_param(o, "SimpleOutput", "RecEncoder")
    info("encoders: stream=%s recording=%s" % (stream_enc or "?", rec_enc or "?"))
    rec_format = profile_param(o, "SimpleOutput", "RecFormat2")
    rec_quality = profile_param(o, "SimpleOutput", "RecQuality")
    if rec_format in ("mkv", "hybrid_mp4"):
        ok("recording format %s (never the stream container)" % rec_format)
    else:
        warn("recording format %r - expected mkv or hybrid_mp4" % rec_format)
    if rec_quality == "HQ":
        ok("recording quality HQ")
    else:
        warn("recording quality %r - expected HQ (not 'Stream')" % rec_quality)
    rec_dir = os.path.join(os.environ.get("USERPROFILE", ""),
                           "Videos", "BGMI-Cup-Recordings")
    if os.path.isdir(rec_dir):
        ok("recording folder exists: %s" % rec_dir)
    else:
        warn("recording folder missing: %s (re-run setup_obs.py)" % rec_dir)
    stream = o.req("GetStreamStatus")
    if stream.get("outputActive"):
        warn("OBS IS STREAMING right now - scene-switching checks skipped")
        global OBS_LIVE
        OBS_LIVE = True
    else:
        ok("not streaming")
    if o.req("GetRecordStatus").get("outputActive"):
        OBS_LIVE = True
        warn("a recording is running")
    return rec_dir


def check_scenes(o, args, items_map):
    step("Scenes, layers, locks")
    scenes = [s.get("sceneName") for s in
              (o.req("GetSceneList") or {}).get("scenes", [])]
    missing = [s for s in setup_obs.SCENES if s not in scenes]
    if missing:
        fail("missing scenes: %s - run setup_obs.py" % ", ".join(missing))
    else:
        ok("all 8 broadcast scenes exist")
    extras = [s for s in scenes if s not in setup_obs.SCENES]
    if extras:
        info("other scenes in the collection: %s" % ", ".join(extras))
    if list(reversed(scenes)) == setup_obs.SCENES:
        ok("scene order matches the hotkey list (F1 PRE-SHOW ... F8 ENDING)")
    else:
        warn("scene order in OBS differs from the runbook order")

    inputs = [i.get("inputName") for i in
              (o.req("GetInputList") or {}).get("inputs", [])]
    cam_count = sum(1 for cam in setup_obs.SRC_CAMS if cam in inputs)
    if cam_count:
        ok("%d camera input(s) wired" % cam_count)
    else:
        warn("no camera inputs - the overlay runs with &frame=off")

    order_issues = []
    lock_issues = []
    for scene in setup_obs.SCENES:
        listed = sorted(items_map.get(scene, {}).items(),
                        key=lambda kv: kv[1]["index"])
        names = [name for name, _ in listed]
        want = setup_obs.planned_layers(scene, cam_count)
        if names != want:
            order_issues.append("%s: %s (want %s)" % (scene, names, want))
        for name, entry in listed:
            locked = o.try_req("GetSceneItemLocked",
                               {"sceneName": scene,
                                "sceneItemId": entry["id"]})
            if locked is None:
                continue
            want_locked = name not in setup_obs.UNLOCKED
            if want_locked and not locked.get("sceneItemLocked"):
                lock_issues.append("%s/%s" % (scene, name))
    if order_issues:
        fail("layer order wrong: %s" % "; ".join(order_issues))
    else:
        ok("layer order correct everywhere (bg -> phone -> cams -> overlay)")
    if lock_issues:
        fail("unlocked scene items (accidental drags): %s"
             % ", ".join(sorted(set(lock_issues))[:8]))
    else:
        ok("sources locked against accidental drags")

    gameplay = items_map.get("GAMEPLAY", {})
    notice = gameplay.get(setup_obs.SRC_NOTICE)
    if notice and notice["enabled"]:
        warn("'Phone Offline Notice' is visible - hide it unless the phone "
             "mirror is down")
    else:
        ok("'Phone Offline Notice' hidden (fallback card ready if needed)")
    return cam_count


def check_sources(o, args, cam_count, fps):
    step("Sources")
    settings = input_settings(o, setup_obs.SRC_PHONE)
    window = settings.get("window") or ""
    if "bgmi-phone" in window.lower():
        ok("phone capture targets the scrcpy window")
    else:
        warn("phone capture has no window - start "
             "scripts/obs/start_phone_capture.bat, then re-run setup_obs.py")
    if settings.get("cursor"):
        warn("cursor capture is ON for the phone - should be off")
    else:
        ok("phone capture: cursor off, method %s"
           % (settings.get("method", "auto")))

    proc = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq scrcpy.exe", "/FO", "CSV"],
        capture_output=True, text=True)
    if "scrcpy.exe" in (proc.stdout or ""):
        ok("scrcpy phone mirror is running")
    else:
        warn("scrcpy is NOT running - start "
             "scripts/obs/start_phone_capture.bat before going live")

    for cam in setup_obs.SRC_CAMS[:cam_count]:
        cam_set = input_settings(o, cam)
        if cam_set.get("video_device_id"):
            ok("%s -> %r" % (cam, cam_set.get("device_name")
                             or cam_set.get("video_device_id", "")[:40]))
        else:
            fail("%s has no device selected - plug the camera in and "
                 "re-run setup_obs.py" % cam)

    game = input_settings(o, setup_obs.SRC_GAME_AUDIO)
    if "scrcpy" in (game.get("window") or "").lower():
        ok("game audio captured from the scrcpy process")
    else:
        warn("game audio window not set - re-run setup_obs.py with the "
             "mirror running")

    over = input_settings(o, setup_obs.SRC_OVERLAY)
    url = over.get("url") or ""
    if "/overlay/program?token=" in url:
        ok("overlay URL: %s" % redact(url))
    else:
        fail("overlay URL is not the program URL: %s" % redact(url))
    want_frames = cam_count or 1
    if "frame=off" in url:
        got_frames = 0
    elif "frames=2" in url:
        got_frames = 2
    else:
        got_frames = 1
    if (cam_count == 0 and "frame=off" in url) or got_frames == want_frames:
        ok("overlay camera windows match the wired cameras (%s)"
           % ("frame off" if cam_count == 0 else "%d frame(s)" % cam_count))
    else:
        warn("overlay shows %s camera frame(s) but %d camera(s) are wired - "
             "re-run setup_obs.py" % (got_frames, cam_count))
    if int(over.get("fps") or 0) == fps:
        ok("overlay browser runs at %d fps" % fps)
    else:
        warn("overlay browser fps %r, stream at %d fps" % (over.get("fps"), fps))
    if over.get("shutdown") is False:
        ok("overlay keeps rendering when hidden (shutdown off)")
    else:
        warn("overlay 'shutdown when not visible' should be OFF")
    if over.get("restart_when_active") is False:
        ok("overlay does not refresh on scene switches")
    else:
        warn("overlay 'refresh when active' should be OFF")
    accel = {k: v for k, v in over.items() if "accel" in k.lower()}
    if accel and any(bool(v) for v in accel.values()):
        ok("overlay hardware acceleration on")
    elif accel:
        warn("overlay hardware acceleration is off (%s)" % accel)
    css = (over.get("css") or "").strip()
    if css:
        warn("overlay custom CSS is not empty (%d chars)" % len(css))
    else:
        ok("overlay custom CSS empty")
    return url


def check_audio(o, args):
    step("Audio")
    desk = input_settings(o, "Desktop Audio").get("device_id")
    if desk == "disabled":
        ok("desktop audio disabled (nothing else leaks to the stream)")
    elif desk is None:
        warn("no 'Desktop Audio' device in this collection")
    else:
        fail("Desktop Audio captures %r - set it to Disabled in OBS "
             "Settings > Audio" % desk)
    mic = input_settings(o, "Mic/Aux")
    if mic.get("device_id") == "default":
        ok("mic follows the Windows default input device")
    elif mic.get("device_id"):
        info("mic device is a fixed device id (fine, but it will not follow "
             "a device swap)")
    else:
        warn("mic has no device selected")

    filters = (o.try_req("GetSourceFilterList", {"sourceName": "Mic/Aux"})
               or {}).get("filters", [])
    kinds = {f.get("filterKind"): f for f in filters}
    wanted = ("noise_suppress_filter", "noise_gate_filter", "limiter_filter")
    missing = [k for k in wanted if k not in kinds]
    disabled = [k for k in wanted
                if k in kinds and not kinds[k].get("filterEnabled", True)]
    if missing:
        warn("mic filters missing: %s - run setup_obs.py" % ", ".join(missing))
    elif disabled:
        fail("mic filters disabled: %s" % ", ".join(disabled))
    else:
        ok("mic chain live: RNNoise + noise gate + limiter")

    monitor_bad = []
    for name in ("Mic/Aux", "Desktop Audio", setup_obs.SRC_GAME_AUDIO):
        data = o.try_req("GetInputAudioMonitorType", {"inputName": name})
        if data is None:
            continue
        if data.get("monitorType") != "OBS_MONITORING_TYPE_NONE":
            monitor_bad.append(name)
    if monitor_bad:
        warn("audio monitoring is ON for: %s (can echo on speakers; keep it "
             "off with headphones only)" % ", ".join(monitor_bad))
    else:
        ok("monitoring off on mic / desktop / game audio")


def audio_meter_check(o, args):
    if args.quick or OBS_LIVE:
        info("meter sample skipped (%s)"
             % ("--quick" if args.quick else "OBS is live"))
        return
    prev = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
    o.req("SetCurrentProgramScene", {"sceneName": "GAMEPLAY"})
    events = o.pump_events(3.0)
    o.req("SetCurrentProgramScene", {"sceneName": prev or setup_obs.SCENES[0]})
    peaks = {}
    for event in events:
        if event.get("eventType") != "InputVolumeMeters":
            continue
        for value in (event.get("eventData") or {}).values():
            if not isinstance(value, list):
                continue
            for entry in value:
                if not isinstance(entry, dict) or "inputName" not in entry:
                    continue
                levels = []
                _flatten_numbers(entry.get("inputLevelsMul") or [], levels)
                peak = max(levels) if levels else 0.0
                name = entry["inputName"]
                peaks[name] = max(peaks.get(name, 0.0), peak)
    for name in ("Mic/Aux", setup_obs.SRC_GAME_AUDIO):
        peak = peaks.get(name)
        if peak is None:
            warn("no level data for %r (source inactive or silent)" % name)
        elif peak > 0.0005:
            ok("%s meter is moving (peak %.3f)" % (name, peak))
        else:
            hint = ("the noise gate keeps silence at zero - talk into the mic"
                    if name == "Mic/Aux" else "play audio on the phone")
            warn("%s meter is silent right now (%s)" % (name, hint))
            if name == "Mic/Aux":
                info("(a Bluetooth headset mic cannot record while the same "
                     "headset plays audio - use a wired mic for casters)")


def check_cameras(o, args, cam_count, items_map):
    step("Camera feed + geometry")
    frames = obs_config.load_frames()
    measured = {}
    if cam_count and not args.quick and not OBS_LIVE:
        prev = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
        o.req("SetCurrentProgramScene", {"sceneName": "CASTERS"})
        time.sleep(3.0)
        for cam in setup_obs.SRC_CAMS[:cam_count]:
            transform = item_transform(o, "CASTERS", cam, items_map) or {}
            width = int(transform.get("sourceWidth") or 0)
            height = int(transform.get("sourceHeight") or 0)
            if width > 0:
                ok("%s is delivering %dx%d" % (cam, width, height))
            else:
                fail("%s is not delivering frames - check the USB camera "
                     "(Settings > Video Capture Device in OBS)" % cam)
            measured[cam] = (width, height)
        o.req("SetCurrentProgramScene",
              {"sceneName": prev or setup_obs.SCENES[0]})
    elif cam_count:
        info("camera feed probe skipped (%s)"
             % ("--quick" if args.quick else "OBS is live"))

    geom_issues = []
    for scene, family in setup_obs.CAM_FAMILY.items():
        for index, cam in enumerate(setup_obs.SRC_CAMS[:cam_count]):
            frame = frames["layouts"]["%s-%d" % (family, cam_count)][
                "frames"][index]
            transform = item_transform(o, scene, cam, items_map) or {}
            if not transform:
                geom_issues.append("%s/%s missing" % (scene, cam))
                continue
            if (int(transform.get("positionX") or -1) != frame["x"]
                    or int(transform.get("positionY") or -1) != frame["y"]
                    or int(transform.get("boundsWidth") or 0) != frame["w"]
                    or int(transform.get("boundsHeight") or 0) != frame["h"]
                    or transform.get("boundsType")
                    != "OBS_BOUNDS_SCALE_INNER"):
                geom_issues.append("%s/%s position/bounds off" % (scene, cam))
                continue
            width, height = measured.get(cam, (0, 0))
            if width > 0:
                want = setup_obs.cam_crop(width, height, frame)
                got = {k: int(transform.get(k) or 0)
                       for k in ("cropLeft", "cropRight",
                                 "cropTop", "cropBottom")}
                if got != want:
                    geom_issues.append("%s/%s crop %s != %s"
                                       % (scene, cam, got, want))
    for scene in setup_obs.SCENES:
        transform = item_transform(o, scene, setup_obs.SRC_PHONE, items_map)
        if transform and (int(transform.get("boundsWidth") or 0) != 1920
                          or int(transform.get("boundsHeight") or 0) != 1080
                          or transform.get("boundsType")
                          != "OBS_BOUNDS_SCALE_INNER"):
            geom_issues.append("%s/phone not fitting the canvas" % scene)
        transform = item_transform(o, scene, setup_obs.SRC_OVERLAY, items_map)
        if transform and (int(transform.get("positionX") or 0) != 0
                          or int(transform.get("positionY") or 0) != 0):
            geom_issues.append("%s/overlay moved off canvas" % scene)
    if geom_issues:
        fail("geometry mismatches: %s" % "; ".join(geom_issues[:8]))
    else:
        ok("camera/phone/overlay transforms match public/camera-frames.json")


def check_hotkeys(o, args):
    step("Hotkeys")
    path, data = setup_obs.find_collection_file()
    if not data:
        warn("scene collection file not found in %s" % setup_obs.SCENES_DIR)
        return
    by_name = {s.get("name"): s for s in data.get("sources", [])
               if s.get("id") == "scene"}
    missing = []
    for index, scene in enumerate(setup_obs.SCENES):
        entry = by_name.get(scene) or {}
        binding = (entry.get("hotkeys") or {}).get("OBSBasic.SelectScene")
        if binding != [{"key": setup_obs.HOTKEYS[index]}]:
            missing.append(scene)
    if missing:
        warn("hotkey bindings missing/changed for: %s - run setup_obs.py"
             % ", ".join(missing))
    else:
        ok("F1..F8 scene hotkeys bound in the saved collection")
    info("(file reflects the last time OBS saved; %s)"
         % os.path.basename(path))
    if args.keys and not OBS_LIVE:
        hotkey_press_test(o)


def send_keys(keys):
    """Focus OBS and send F-keys - only if OBS really is in front."""
    activate = (
        "$p = Get-Process obs64 -ErrorAction Stop; "
        "$ws = New-Object -ComObject WScript.Shell; "
        "$ws.AppActivate($p.Id) | Out-Null; Start-Sleep -Milliseconds 700; "
        "$fg = Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] "
        "public static extern int GetForegroundWindow(); [DllImport(\"user32.dll\")] "
        "public static extern int GetWindowThreadProcessId(int hWnd, out int lpdwProcessId);' "
        "-Name W -Namespace T -PassThru; "
        "$h = $fg::GetForegroundWindow(); $foreground = 0; "
        "$fg::GetWindowThreadProcessId($h, [ref]$foreground) | Out-Null; "
        "if ($foreground -eq $p.Id) { 'FOCUSED' } else { 'NOT_FOCUSED' }")
    result = subprocess.run(["powershell", "-NoProfile", "-Command", activate],
                            capture_output=True, text=True, timeout=30)
    if "FOCUSED" not in (result.stdout or "") \
            or "NOT_FOCUSED" in (result.stdout or ""):
        return False
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "$ws = New-Object -ComObject WScript.Shell; "
                    "$ws.SendKeys('%s')" % keys],
                   capture_output=True, text=True, timeout=30)
    return True


def hotkey_press_test(o):
    start = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
    if start == "INTERMISSION":
        start_restore = setup_obs.SCENES[0]
    else:
        start_restore = start
    if not send_keys("{F6}"):
        warn("hotkey press test skipped: could not focus the OBS window")
        return
    time.sleep(1.2)
    now = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
    if now == "INTERMISSION":
        ok("hotkey press test: F6 switched the program to INTERMISSION")
    elif now == start:
        fail("hotkey press test: F6 did nothing - hotkeys are not loaded")
    else:
        info("hotkey press test: F6 landed on %r" % now)
    index = setup_obs.SCENES.index(start_restore) \
        if start_restore in setup_obs.SCENES else None
    if index is not None:
        send_keys("{%s}" % setup_obs.HOTKEYS[index].replace("OBS_KEY_", ""))
    else:
        o.req("SetCurrentProgramScene",
              {"sceneName": start_restore or setup_obs.SCENES[0]})
    time.sleep(0.6)


def check_stats(o, args, fps):
    step("Performance")
    target = float(fps or 60)
    if args.soak <= 0:
        stats = o.req("GetStats")
        active = float(stats.get("activeFps") or 0)
        cpu = float(stats.get("cpuUsage") or 0)
        info("now: %.1f fps, %.1f%% CPU, output skipped %s/%s, render skipped %s/%s"
             % (active, cpu, stats.get("outputSkippedFrames"),
                stats.get("outputTotalFrames"), stats.get("renderSkippedFrames"),
                stats.get("renderTotalFrames")))
        if active and active < target * 0.9:
            warn("%.1f fps is below the %d fps target right now" % (active, fps))
        else:
            ok("frame rate holds close to target")
        if cpu > 80:
            warn("CPU at %.1f%% - check encoders if the stream stutters" % cpu)
        else:
            ok("CPU at %.1f%%" % cpu)
        return
    first = o.req("GetStats")
    start = time.time()
    samples = []
    while time.time() - start < args.soak:
        time.sleep(min(5.0, max(0.5, args.soak / 10.0)))
        samples.append((time.time(), o.req("GetStats")))
    end_time, last = samples[-1]
    duration = max(1.0, end_time - start)
    fps_avg = sum(float(s.get("activeFps") or 0)
                  for _, s in samples) / len(samples)
    cpu_avg = sum(float(s.get("cpuUsage") or 0)
                  for _, s in samples) / len(samples)
    out_skipped = (int(last.get("outputSkippedFrames") or 0)
                   - int(first.get("outputSkippedFrames") or 0))
    render_skipped = (int(last.get("renderSkippedFrames") or 0)
                      - int(first.get("renderSkippedFrames") or 0))
    out_frames = (int(last.get("outputTotalFrames") or 0)
                  - int(first.get("outputTotalFrames") or 0))
    info("over %.0f s: %.1f fps avg, %.1f%% CPU avg, %d output frames, "
         "%d output skipped, %d render skipped"
         % (duration, fps_avg, cpu_avg, out_frames, out_skipped,
            render_skipped))
    if fps_avg >= target * 0.95:
        ok("frame rate steady for %.0f s" % duration)
    elif fps_avg >= target * 0.85:
        warn("frame rate %.1f vs %d target - close, watch it" % (fps_avg, fps))
    else:
        fail("frame rate %.1f well below the %d fps target" % (fps_avg, fps))
    if out_skipped == 0 and render_skipped == 0:
        ok("no dropped frames in %.0f s" % duration)
    else:
        warn("%d output + %d render frames skipped in %.0f s"
             % (out_skipped, render_skipped, duration))
    if cpu_avg <= 65:
        ok("CPU average %.1f%%" % cpu_avg)
    elif cpu_avg <= 85:
        warn("CPU average %.1f%% - acceptable but warm" % cpu_avg)
    else:
        fail("CPU average %.1f%% - encoder/settings too heavy" % cpu_avg)


# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--quick", action="store_true",
                        help="skip checks that switch the program scene")
    parser.add_argument("--keys", action="store_true",
                        help="press F6 in a focused OBS to prove hotkeys work")
    parser.add_argument("--soak", type=int, default=0, metavar="SECONDS",
                        help="sample fps/CPU/dropped frames for this long")
    args = parser.parse_args()

    print("BGMI Cup broadcast check")
    step("Connection")
    try:
        o = Obs().connect(event_subscriptions=obs_ws.INPUT_VOLUME_METERS)
    except Exception as exc:                    # noqa: BLE001 - report any way
        fail("cannot reach obs-websocket: %s" % exc)
        info("is OBS running? is OBS_WEBSOCKET_PASSWORD set "
             "(setx, new terminal, or repo .env)?")
        return finish()
    ok("obs-websocket reachable on %s:%s" % (o.host, o.port))
    try:
        check_version_profile(o, args)
        fps = check_video(o, args)
        check_output_profile(o, args)
        items_map = build_items_map(o)
        cam_count = check_scenes(o, args, items_map)
        check_sources(o, args, cam_count, fps)
        check_audio(o, args)
        audio_meter_check(o, args)
        check_cameras(o, args, cam_count, items_map)
        check_hotkeys(o, args)
        check_stats(o, args, fps)
    finally:
        o.close()
    return finish()


def finish():
    print("\n" + "=" * 58)
    if FAILS:
        print("NOT READY - %d failure(s), %d warning(s)." % (FAILS, WARNS))
        print("Most reds fix themselves with: "
              "scripts\\obs\\.venv\\Scripts\\python.exe scripts\\obs\\setup_obs.py")
        print("Handbook: docs/obs-runbook.md (troubleshooting table).")
        return 1
    if WARNS:
        print("READY (with %d warning(s) above - read them)." % WARNS)
    else:
        print("READY - all checks green.")
    print("Never press 'Start Streaming' until the stream key is set on purpose.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
