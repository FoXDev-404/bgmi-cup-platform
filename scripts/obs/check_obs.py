"""Broadcast readiness check for the BGMI Cup v2 OBS setup.

One command, green/red output:

    scripts\\obs\\.venv\\Scripts\\python.exe scripts\\obs\\check_obs.py

Checks, per scene, that:

  * the scene exists and lists exactly the planned sources (top to bottom),
  * it owns its OWN browser source (unique name + unique URL) and that no
    browser source is shared with any other scene (root-cause rule),
  * the browser source URL path matches that scene's overlay name
    (/overlay/<name>), the token is present and matches the expected one
    (never printed - URLs are shown as token=***),
  * no source named "Program Overlay" exists and no URL uses /overlay/program,
  * "shutdown when not visible" / "refresh when scene becomes active" match
    the overlay type (ON for animated/event overlays, OFF for live panels),
  * camera windows sit exactly on public/camera-frames.json,
  * sources are locked, transition is Fade 300 ms, studio mode is off.

Every line is [ok] / [warn] / [fail]; the exit code is 0 only when no
[fail] line was printed. Secrets (the overlay token and the websocket
password) are never displayed.

Options:
    --quick   skip the checks that briefly switch the program scene
              (camera feed probe, audio-meter sample)
    --keys    functional hotkey test: focuses OBS, presses F1 and Ctrl+F3,
              then restores the scene (never runs blind - the foreground
              window must be OBS)
    --soak N  sample OBS stats + GPU for N seconds with GAMEPLAY active
    --shots   save one screenshot of every scene to docs/obs/screenshots/v2
              (also verifies every scene renders its own distinct content)
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import time

try:                                        # keep '·' readable on cp1252
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import obs_config
import obs_ws
import setup_obs
from obs_ws import Obs

FAILS = 0
WARNS = 0
OBS_LIVE = False                    # streaming or recording right now
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SHOTS_DIR = os.path.join(REPO, "docs", "obs", "screenshots", "v2")


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
    """{scene: {source: {"id":, "enabled":, "index":, "type":}}}"""
    out = {}
    for scene in [setup_obs.BASE_SCENE] + setup_obs.SCENES:
        data = o.try_req("GetSceneItemList", {"sceneName": scene}) or {}
        items = {}
        for item in data.get("sceneItems", []):
            items[item.get("sourceName")] = {
                "id": item.get("sceneItemId"),
                "enabled": bool(item.get("sceneItemEnabled", True)),
                "index": int(item.get("sceneItemIndex") or 0),
                "type": item.get("sourceType") or "",
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

    trans = o.req("GetCurrentSceneTransition")
    if trans.get("transitionName") == "Fade" \
            and int(trans.get("transitionDuration") or 0) == 300:
        ok("default transition: Fade, 300 ms")
    else:
        warn("transition is %r / %s ms - expected Fade 300 ms"
             % (trans.get("transitionName"), trans.get("transitionDuration")))
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


def check_scene_inventory(o, args, items_map):
    step("Scenes, layers, locks")
    scenes = [s.get("sceneName") for s in
              (o.req("GetSceneList") or {}).get("scenes", [])]
    missing = [s for s in setup_obs.SCENES if s not in scenes]
    if missing:
        fail("missing scenes: %s - run setup_obs.py" % ", ".join(missing))
    else:
        ok("all 16 broadcast scenes exist")
    if setup_obs.BASE_SCENE in scenes:
        ok("support scene %r exists" % setup_obs.BASE_SCENE)
    else:
        fail("missing support scene %r" % setup_obs.BASE_SCENE)
    extras = [s for s in scenes
              if s not in setup_obs.SCENES and s != setup_obs.BASE_SCENE]
    if extras:
        info("other scenes in the collection: %s" % ", ".join(extras))
    if list(reversed(scenes))[:len(setup_obs.SCENES)] == setup_obs.SCENES:
        ok("scene order matches the runbook (F1 PRE-SHOW ... Ctrl+F4 ENDING)")
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
    for scene in [setup_obs.BASE_SCENE] + setup_obs.SCENES:
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
        ok("layer order correct everywhere (background/BASE -> cams -> overlay)")
    if lock_issues:
        fail("unlocked scene items (accidental drags): %s"
             % ", ".join(sorted(set(lock_issues))[:8]))
    else:
        ok("sources locked against accidental drags")

    base_items = items_map.get(setup_obs.BASE_SCENE, {})
    notice = base_items.get(setup_obs.SRC_NOTICE)
    scr = setup_obs.scrcpy_running()
    if notice and notice["enabled"]:
        if scr:
            warn("'Phone Offline Notice' is visible but scrcpy IS running - "
                 "hide it (or re-run setup_obs.py)")
        else:
            ok("'Phone Offline Notice' visible (scrcpy is down - correct)")
    else:
        if scr:
            ok("'Phone Offline Notice' hidden (scrcpy is running)")
        else:
            warn("scrcpy is down and the 'Phone Offline Notice' is hidden - "
                 "reveal it (eye icon) or re-run setup_obs.py")

    # per-scene source listing
    info("sources per scene (bottom -> top):")
    for scene in setup_obs.SCENES:
        listed = sorted(items_map.get(scene, {}).items(),
                        key=lambda kv: kv[1]["index"])
        info("  %-22s %s" % (scene, " | ".join(n for n, _ in listed)))
    return cam_count


def check_browser_sources(o, args, items_map, cam_count, fps, origin):
    """The root-cause rule + per-scene overlay URL checks."""
    step("One browser source per scene (root-cause rule)")
    inputs = {i.get("inputName"): i
              for i in (o.req("GetInputList") or {}).get("inputs", [])}
    browser_sources = {name: i for name, i in inputs.items()
                       if i.get("inputKind") == "browser_source"}
    usage = {name: [] for name in browser_sources}
    for scene, items in items_map.items():
        for source in items:
            if source in usage:
                usage[source].append(scene)

    if "Program Overlay" in inputs:
        fail("a source named 'Program Overlay' still exists (the old shared "
             "overlay) - re-run setup_obs.py to remove it")
    else:
        ok("no 'Program Overlay' source exists")

    expected_token = obs_config.overlay_target()[1]
    planned = {setup_obs.overlay_name(s): s for s in setup_obs.SCENES}
    issues = []
    for index, scene in enumerate(setup_obs.SCENES):
        name = setup_obs.overlay_name(scene)
        overlay = setup_obs.OVERLAY_FOR_SCENE[scene]
        label = "%s %s" % (setup_obs.hotkey_label(index), scene)
        problems = []
        entry = browser_sources.get(name)
        settings = input_settings(o, name) if entry else {}
        if not entry:
            problems.append("browser source %r missing" % name)
        else:
            scenes_used = usage.get(name, [])
            if scenes_used != [scene]:
                problems.append("source %r is used in %s (must be only %r)"
                                % (name, scenes_used, scene))
            scenes_with_this_item = [s for s, items in items_map.items()
                                     if name in items]
            if scenes_with_this_item != [scene]:
                problems.append("scene item appears in %s"
                                % scenes_with_this_item)
            url = settings.get("url") or ""
            path = url.split("?", 1)[0]
            if not path.endswith("/overlay/" + overlay):
                problems.append("URL path is %s, expected /overlay/%s"
                                % (redact(path), overlay))
            if "/overlay/program" in url:
                problems.append("URL still uses /overlay/program")
            token = ""
            match = re.search(r"[?&]token=([^&\s]+)", url)
            if match:
                token = match.group(1)
            if not token:
                problems.append("token missing from URL")
            elif expected_token and token != expected_token:
                problems.append("token MISMATCH (wrong/old token)")
            if (int(settings.get("width") or 0),
                    int(settings.get("height") or 0)) != (1920, 1080):
                problems.append("browser size %sx%s, expected 1920x1080"
                                % (settings.get("width"),
                                   settings.get("height")))
            if (settings.get("css") or "").strip():
                problems.append("custom CSS is not empty")
            accel = {k: v for k, v in settings.items() if "accel" in k.lower()}
            if accel and not any(bool(v) for v in accel.values()):
                problems.append("hardware acceleration off")
            if int(settings.get("fps") or 0) != fps:
                problems.append("browser fps %r, stream fps %d"
                                % (settings.get("fps"), fps))
            always_on = overlay in setup_obs.ALWAYS_ON_OVERLAYS
            if always_on:
                if settings.get("shutdown") is not False \
                        or settings.get("restart_when_active") is not False:
                    problems.append("live panel must keep the browser warm "
                                    "(shutdown/refresh OFF)")
            else:
                if settings.get("shutdown") is not True \
                        or settings.get("restart_when_active") is not True:
                    problems.append("animated overlay must reload when its "
                                    "scene becomes active (shutdown/refresh ON)")
        if problems:
            issues.append("%s: %s" % (label, "; ".join(problems)))
            fail("%-24s <- %s" % (label, "; ".join(problems)))
        else:
            how = ("always on" if overlay in setup_obs.ALWAYS_ON_OVERLAYS
                   else "reload on activation")
            ok("%-24s -> \"%s\" /overlay/%s?token=*** (1 scene, %s)"
               % (label, name, overlay, how))
    if issues:
        fail("%d scene(s) with browser-source problems - re-run "
             "setup_obs.py" % len(issues))
    else:
        ok("every scene owns exactly one browser source, correct URL + "
           "token, no sharing (%d checked)" % len(setup_obs.SCENES))

    unplanned = [n for n in browser_sources if n not in planned]
    if unplanned:
        warn("browser sources that are not part of the plan: %s"
             % ", ".join(unplanned))
    if expected_token:
        ok("overlay token present in all URLs and matches the expected token "
           "(value never printed)")
    else:
        warn("cannot verify the token (set BGMI_OVERLAY_TOKEN or use the "
             "local dev database)")
    if origin == "local":
        info("overlays point at the local dev server (http://127.0.0.1:8080) "
             "- set BGMI_BASE_URL/BGMI_OVERLAY_TOKEN for the Railway site")
    return browser_sources


def check_sources(o, args, cam_count, fps):
    step("Phone, camera devices, audio sources")
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

    if setup_obs.scrcpy_running():
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
    for scene in [setup_obs.BASE_SCENE] + setup_obs.SCENES:
        transform = item_transform(o, scene, setup_obs.SRC_PHONE, items_map)
        if transform and (int(transform.get("boundsWidth") or 0) != 1920
                          or int(transform.get("boundsHeight") or 0) != 1080
                          or transform.get("boundsType")
                          != "OBS_BOUNDS_SCALE_INNER"):
            geom_issues.append("%s/phone not fitting the canvas" % scene)
    for scene in setup_obs.SCENES:
        transform = item_transform(o, scene, setup_obs.overlay_name(scene),
                                   items_map)
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
        if binding != [setup_obs.HOTKEYS[index]]:
            missing.append("%s (%s)" % (scene, setup_obs.hotkey_label(index)))
    if missing:
        warn("hotkey bindings missing/changed for: %s - run setup_obs.py"
             % ", ".join(missing))
    else:
        ok("F1..F12 + Ctrl+F1..F4 scene hotkeys bound in the saved collection")
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


def scene_sendkeys(scene):
    index = setup_obs.SCENES.index(scene)
    key = "F%d" % (index + 1 if index < 12 else index - 11)
    return "{%s}" % key if index < 12 else "^({%s})" % key


def hotkey_press_test(o):
    start = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
    if not send_keys("{F1}"):
        warn("hotkey press test skipped: could not focus the OBS window")
        return
    time.sleep(1.2)
    now = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
    if now == "PRE-SHOW":
        ok("hotkey press test: F1 switched the program to PRE-SHOW")
    elif now == start:
        fail("hotkey press test: F1 did nothing - hotkeys are not loaded")
    else:
        info("hotkey press test: F1 landed on %r" % now)
    if not send_keys("^({F3})"):
        warn("Ctrl hotkey test skipped: could not focus the OBS window")
    else:
        time.sleep(1.2)
        now = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
        if now == "TECHNICAL DIFFICULTIES":
            ok("hotkey press test: Ctrl+F3 switched the program to "
               "TECHNICAL DIFFICULTIES")
        else:
            warn("hotkey press test: Ctrl+F3 landed on %r - the Ctrl "
                 "combinations may need rebinding in OBS (File > Settings > "
                 "Hotkeys)" % now)
    if start in setup_obs.SCENES and start != "TECHNICAL DIFFICULTIES":
        send_keys(scene_sendkeys(start))
    else:
        o.req("SetCurrentProgramScene",
              {"sceneName": start or setup_obs.SCENES[0]})
    time.sleep(0.6)


def gpu_soak_command(seconds):
    """PowerShell one-liner that samples summed GPU engine utilisation."""
    count = max(2, int(seconds // 3))
    return ("$v = @(); for ($i = 0; $i -lt %d; $i++) { "
            "try { $s = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' "
            "-SampleInterval 1 -MaxSamples 1 -ErrorAction Stop).CounterSamples | "
            "Measure-Object -Property CookedValue -Sum | "
            "Select-Object -ExpandProperty Sum } catch { $s = -1 }; "
            "$v += $s; Start-Sleep -Seconds 2 }; $v -join ','" % count)


def check_stats(o, args, fps):
    step("Performance")
    target = float(fps or 60)
    if args.soak <= 0:
        time.sleep(1.5)                 # let the probe switches settle
        samples = []
        for _ in range(4):
            samples.append(o.req("GetStats"))
            time.sleep(1.0)
        stats = samples[-1]
        active = sum(float(s.get("activeFps") or 0)
                     for s in samples) / len(samples)
        cpu = sum(float(s.get("cpuUsage") or 0)
                  for s in samples) / len(samples)
        info("now: %.1f fps (avg of %d s), %.1f%% CPU, output skipped %s/%s, "
             "render skipped %s/%s"
             % (active, len(samples), cpu,
                stats.get("outputSkippedFrames"),
                stats.get("outputTotalFrames"),
                stats.get("renderSkippedFrames"),
                stats.get("renderTotalFrames")))
        if not active:
            info("no active output to measure right now (nothing is "
                 "streaming/recording)")
        elif active < target * 0.9:
            warn("%.1f fps is below the %d fps target right now"
                 % (active, fps))
        else:
            ok("frame rate holds close to target")
        if cpu > 80:
            warn("CPU at %.1f%% - check encoders if the stream stutters" % cpu)
        else:
            ok("CPU at %.1f%%" % cpu)
        return
    if OBS_LIVE:
        info("soak uses the active program scene (OBS is live - not "
             "switching to GAMEPLAY)")
        prev = None
    else:
        prev = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
        o.req("SetCurrentProgramScene", {"sceneName": "GAMEPLAY"})
        info("soaking with GAMEPLAY on screen for %d s..." % args.soak)
    gpu_proc = subprocess.Popen(
        ["powershell", "-NoProfile", "-Command",
         gpu_soak_command(args.soak)],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    first = o.req("GetStats")
    start = time.time()
    samples = []
    while time.time() - start < args.soak:
        time.sleep(min(5.0, max(0.5, args.soak / 10.0)))
        samples.append((time.time(), o.req("GetStats")))
    end_time, last = samples[-1]
    duration = max(1.0, end_time - start)
    gpu_out = ""
    try:
        gpu_out = gpu_proc.communicate(timeout=30)[0] or ""
    except subprocess.TimeoutExpired:
        gpu_proc.kill()
    if prev:
        o.req("SetCurrentProgramScene",
              {"sceneName": prev or setup_obs.SCENES[0]})
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
    gpu_values = []
    for chunk in (gpu_out or "").replace("\n", "").split(","):
        try:
            value = float(chunk)
        except (TypeError, ValueError):
            continue
        if value >= 0:
            gpu_values.append(value)
    if gpu_values:
        gpu_avg = sum(gpu_values) / len(gpu_values)
        info("GPU: %.1f%% avg (max %.1f%%) - sum of all GPU engines"
             % (gpu_avg, max(gpu_values)))
        if gpu_avg > 90:
            warn("GPU looks maxed out - watch for render lag during gameplay")
        else:
            ok("GPU headroom exists")
    else:
        warn("GPU counter unavailable on this machine (skipped)")
    if fps_avg >= target * 0.95:
        ok("frame rate steady for %.0f s" % duration)
    elif fps_avg >= target * 0.85:
        warn("frame rate %.1f vs %d target - close, watch it" % (fps_avg, fps))
    else:
        fail("frame rate %.1f well below the %d fps target" % (fps_avg, fps))
    rendered = (int(last.get("renderTotalFrames") or 0)
                - int(first.get("renderTotalFrames") or 0))
    skip_pct = (100.0 * render_skipped / rendered) if rendered else 0.0
    if out_skipped == 0 and skip_pct <= 0.5:
        ok("no dropped frames in %.0f s (render skipped %d of %d, %.2f%%)"
           % (duration, render_skipped, rendered, skip_pct))
    else:
        warn("%d output + %d render frames skipped in %.0f s (%.2f%% of "
             "rendered frames)" % (out_skipped, render_skipped, duration,
                                   skip_pct))
    if cpu_avg <= 65:
        ok("CPU average %.1f%%" % cpu_avg)
    elif cpu_avg <= 85:
        warn("CPU average %.1f%% - acceptable but warm" % cpu_avg)
    else:
        fail("CPU average %.1f%% - encoder/settings too heavy" % cpu_avg)


def save_scene_shots(o, items_map):
    """Screenshot every scene while it is on screen (so shutdown=on browser
    sources are actually rendering), then prove the images all differ.

    Uses SaveSourceScreenshot, so OBS writes the PNG straight to disk (the
    GetSourceScreenshot reply carries a data-URI prefix that is easy to
    mangle)."""
    step("Scene screenshots -> %s" % SHOTS_DIR)
    if OBS_LIVE:
        info("skipped while streaming/recording")
        return
    os.makedirs(SHOTS_DIR, exist_ok=True)
    prev = o.req("GetCurrentProgramScene").get("currentProgramSceneName")
    hashes = {}
    for index, scene in enumerate(setup_obs.SCENES):
        o.req("SetCurrentProgramScene", {"sceneName": scene})
        time.sleep(3.0)          # browser reload + entrance animation
        name = "%02d_%s.png" % (index + 1,
                                scene.lower().replace(" ", "_"))
        path = os.path.join(SHOTS_DIR, name)
        o.try_req("SaveSourceScreenshot",
                  {"sourceName": scene, "imageFormat": "png",
                   "imageFilePath": path,
                   "imageWidth": 1920, "imageHeight": 1080})
        if not os.path.isfile(path):
            fail("screenshot failed for %s (is the scene rendering?)"
                 % scene)
            continue
        with open(path, "rb") as fh:
            blob = fh.read()
        if not blob.startswith(b"\x89PNG"):
            fail("%s screenshot came back as something other than a PNG"
                 % scene)
            continue
        hashes[scene] = (hashlib.md5(blob).hexdigest(), len(blob), name)
    seen = {}
    dupes = []
    for scene, (digest, size, name) in hashes.items():
        if digest in seen:
            dupes.append("%s == %s" % (scene, seen[digest]))
        seen[digest] = scene
        if size < 2000:
            warn("%s screenshot is suspiciously tiny (%d bytes) - check the "
                 "scene renders" % (scene, size))
    if dupes:
        fail("scenes showing the SAME content: %s" % ", ".join(dupes))
    else:
        ok("all %d scenes render distinct content (%d screenshots saved)"
           % (len(hashes), len(hashes)))
    o.req("SetCurrentProgramScene",
          {"sceneName": prev or setup_obs.SCENES[0]})


# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--quick", action="store_true",
                        help="skip checks that switch the program scene")
    parser.add_argument("--keys", action="store_true",
                        help="press F1 + Ctrl+F3 in a focused OBS to prove "
                             "hotkeys work")
    parser.add_argument("--soak", type=int, default=0, metavar="SECONDS",
                        help="sample fps/CPU/GPU/dropped frames for this long "
                             "with GAMEPLAY active")
    parser.add_argument("--shots", action="store_true",
                        help="save a screenshot of every scene to "
                             "docs/obs/screenshots/v2")
    args = parser.parse_args()

    print("BGMI Cup v2 broadcast check")
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
        cam_count = check_scene_inventory(o, args, items_map)
        _, _, origin = obs_config.overlay_target()
        check_browser_sources(o, args, items_map, cam_count, fps, origin)
        check_sources(o, args, cam_count, fps)
        check_audio(o, args)
        audio_meter_check(o, args)
        check_cameras(o, args, cam_count, items_map)
        check_hotkeys(o, args)
        if args.shots:
            save_scene_shots(o, items_map)
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
