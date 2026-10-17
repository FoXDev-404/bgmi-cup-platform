#!/usr/bin/env python
"""BGMI Cup - one-command OBS build (profile + scene collection), idempotent.

Creates, on whatever machine this runs on:

  * OBS profile "BGMI Cup": 1920x1080 canvas/output, Simple output
    (CBR 8 Mbps, ~2 s keyframes, AAC 160 kbps @ 48 kHz), recording =
    hybrid MP4 in a separate folder (never stream settings by accident),
    hardware encoder auto-picked (NVENC / QSV / AMD / x264).
  * OBS scene collection "BGMI Cup": 8 scenes
    (PRE-SHOW, STARTING SOON, COUNTDOWN, GAMEPLAY, CASTERS, INTERMISSION,
    TECHNICAL DIFFICULTIES, ENDING) built from shared sources:
    black background, phone mirror capture (WGC, no cursor, fit to canvas),
    caster cameras positioned on public/camera-frames.json, scrcpy game
    audio (application capture), one URL Program overlay browser source.
  * F1..F8 scene hotkeys, source locking, studio mode off.

OBS has no websocket API for hotkey bindings (and a websocket-created
collection starts without global audio devices), so the script exits OBS
once, patches the scene-collection file (F1..F8 scene hotkeys, Desktop
Audio / Mic-Aux devices), writes a token-free copy to
scripts/obs/scene-collection-export.json and relaunches OBS.

Usage:  scripts/obs/.venv/Scripts/python.exe scripts/obs/setup_obs.py
Flags:  --fps 60|30   --cameras auto|0|1|2   --encoder auto|qsv|nvenc|amd|x264
        --cam1 NAME  --cam2 NAME   --no-restart

Nothing here ever prints or stores the overlay token or the websocket
password; the stream key is never touched.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import time
import uuid

import obs_config
from obs_ws import Obs, ObsError

# ---------------------------------------------------------------------------
# constants
# ---------------------------------------------------------------------------

PROFILE_NAME = "BGMI Cup"
COLLECTION_NAME = "BGMI Cup"
APPDATA = os.environ.get("APPDATA", "")
PROFILES_DIR = os.path.join(APPDATA, "obs-studio", "basic", "profiles")
SCENES_DIR = os.path.join(APPDATA, "obs-studio", "basic", "scenes")
HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT_PATH = os.path.join(HERE, "scene-collection-export.json")
REC_DIR = os.path.join(os.environ.get("USERPROFILE", ""), "Videos",
                       "BGMI-Cup-Recordings")

OBS_EXES = [
    r"C:\Program Files\obs-studio\bin\64bit\obs64.exe",
    r"C:\Program Files (x86)\obs-studio\bin\64bit\obs64.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs",
                 "obs-studio", "bin", "64bit", "obs64.exe"),
]

SCENES = ["PRE-SHOW", "STARTING SOON", "COUNTDOWN", "GAMEPLAY", "CASTERS",
          "INTERMISSION", "TECHNICAL DIFFICULTIES", "ENDING"]
HOTKEYS = ["OBS_KEY_F1", "OBS_KEY_F2", "OBS_KEY_F3", "OBS_KEY_F4",
           "OBS_KEY_F5", "OBS_KEY_F6", "OBS_KEY_F7", "OBS_KEY_F8"]

PHONE_SCENES = {"PRE-SHOW", "STARTING SOON", "GAMEPLAY", "INTERMISSION"}
CAM_FAMILY = {"COUNTDOWN": "caster", "GAMEPLAY": "live",
              "CASTERS": "caster", "ENDING": "caster"}

SRC_BG = "BGMI Black Background"
SRC_PHONE = "Phone Capture"
SRC_NOTICE = "Phone Offline Notice"
SRC_CAMS = ["Caster Cam 1", "Caster Cam 2"]
SRC_GAME_AUDIO = "Game Audio"
SRC_OVERLAY = "Program Overlay"
UNLOCKED = {SRC_NOTICE}          # the notice stays draggable on purpose

VIRTUAL_CAM_HINTS = ("virtual", "obs-camera", "snap camera", "manycam",
                     "droidcam", "epoccam", "iriun", "nvidia broadcast",
                     "streamlabs", "xsplit")

MIC_FILTERS = [
    ("Noise Suppression", "noise_suppress_filter",
     {"method": "rnnoise"}),
    ("Noise Gate", "noise_gate_filter",
     {"open_threshold": -26.0, "close_threshold": -32.0,
      "attack_time": 25.0, "hold_time": 200.0, "release_time": 150.0}),
    ("Limiter", "limiter_filter", {"limit": -6.0, "release_time": 60.0}),
]

# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def step(title):
    print("\n== %s ==" % title)


def ok(msg):
    print("  [ok]  " + msg)


def warn(msg):
    print("  [warn] " + msg)


def info(msg):
    print("  " + msg)


def ps(cmd, timeout=60):
    """Run PowerShell, return stdout (used for device/GPU discovery only)."""
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd],
                             capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip()
    except Exception:
        return ""


def scene_names(o):
    return [s["sceneName"] for s in o.req("GetSceneList").get("scenes", [])]


def scene_items(o, scene):
    return {i["sourceName"]: i
            for i in o.req("GetSceneItemList",
                           {"sceneName": scene}).get("sceneItems", [])}


def scene_item(o, scene, source):
    return scene_items(o, scene).get(source)


# ---------------------------------------------------------------------------
# OBS process control
# ---------------------------------------------------------------------------


def find_obs_exe():
    for path in OBS_EXES:
        if path and os.path.isfile(path):
            return path
    return ""


def obs_process_count():
    try:
        return int(ps("(Get-Process obs64 -ErrorAction SilentlyContinue | "
                      "Measure-Object).Count") or "0")
    except ValueError:
        return 0


def launch_obs(extra_args):
    exe = find_obs_exe()
    if not exe:
        raise SystemExit("obs64.exe not found - is OBS installed?")
    subprocess.Popen([exe] + list(extra_args), cwd=os.path.dirname(exe))
    ok("launched OBS: %s" % exe)


def wait_for_ws(timeout=60):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            return Obs().connect()
        except Exception as exc:            # websocket not up yet
            last = exc
            time.sleep(2)
    raise SystemExit("obs-websocket not reachable after %ss: %s"
                     % (timeout, last))


def hard_reconnect(tries=8):
    """Reconnect after an operation that can drop the websocket."""
    last = None
    for _ in range(tries):
        try:
            return Obs().connect()
        except Exception as exc:
            last = exc
            time.sleep(2)
    raise SystemExit("could not reconnect to obs-websocket: %s" % last)


def connect_or_launch():
    try:
        return Obs().connect()
    except Exception:
        pass
    if obs_process_count() == 0:
        args = []
        if os.path.isfile(os.path.join(PROFILES_DIR, PROFILE_NAME,
                                       "basic.ini")):
            args += ["--profile", PROFILE_NAME]
        launch_obs(args + ["--disable-shutdown-check"])
    return wait_for_ws()


def exit_obs(timeout=45):
    if obs_process_count() == 0:
        return
    info("asking OBS to exit (it saves the collection on the way out)...")
    subprocess.run(["taskkill", "/IM", "obs64.exe"], capture_output=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if obs_process_count() == 0:
            ok("OBS exited")
            return
        time.sleep(1)
    raise SystemExit("OBS did not exit after %ss - close it and re-run."
                     % timeout)


def restart_obs(collection=False):
    exit_obs()
    args = ["--profile", PROFILE_NAME]
    if collection:
        args += ["--collection", COLLECTION_NAME]
    launch_obs(args + ["--disable-shutdown-check"])
    return wait_for_ws()


# ---------------------------------------------------------------------------
# profile / collection
# ---------------------------------------------------------------------------


def basic_ini_text(fps, encoder):
    rec = REC_DIR.replace("\\", "\\\\")
    return (
        "[General]\nName={name}\n\n"
        "[Output]\nMode=Simple\n"
        "FilenameFormatting=BGMI-Cup %CCYY-%MM-%DD %hh-%mm-%ss\n"
        "Reconnect=true\nRetryDelay=2\nMaxRetries=25\nBindIP=default\n"
        "NewSocketLoopEnable=false\nLowLatencyEnable=false\n\n"
        "[SimpleOutput]\nFilePath={rec}\nRecFormat2=hybrid_mp4\n"
        "VBitrate=8000\nABitrate=160\nUseAdvanced=false\nPreset=veryfast\n"
        "RecQuality=HQ\nStreamAudioEncoder=aac\nRecAudioEncoder=aac\n"
        "RecTracks=1\nStreamEncoder={enc}\nRecEncoder={enc}\n\n"
        "[Video]\nBaseCX=1920\nBaseCY=1080\nOutputCX=1920\nOutputCY=1080\n"
        "FPSType=1\nFPSCommon={fps}\nFPSInt={fps}\nFPSNum={fps}\nFPSDen=1\n"
        "ScaleType=bicubic\nColorFormat=NV12\nColorSpace=709\n"
        "ColorRange=Partial\n\n"
        "[Audio]\nMonitoringDeviceId=default\nMonitoringDeviceName=Default\n"
        "SampleRate=48000\nChannelSetup=Stereo\nMeterDecayRate=23.53\n"
        "PeakMeterType=0\n"
    ).format(name=PROFILE_NAME, rec=rec, enc=encoder, fps=fps)


def ensure_profile(o, fps, encoder):
    """True when OBS must be restarted for the profile to become current."""
    basic = os.path.join(PROFILES_DIR, PROFILE_NAME, "basic.ini")
    if not os.path.isfile(basic):
        os.makedirs(os.path.dirname(basic), exist_ok=True)
        with io.open(basic, "w", encoding="utf-8") as fh:
            fh.write(basic_ini_text(fps, encoder))
        ok("created profile %r (needs a restart)" % PROFILE_NAME)
        return True
    current = o.req("GetProfileList").get("currentProfileName", "")
    if current == PROFILE_NAME:
        ok("profile %r is current" % PROFILE_NAME)
        return False
    try:
        o.req("SetCurrentProfile", {"profileName": PROFILE_NAME})
    except ObsError as exc:
        warn("profile switch: %s" % exc)
    current = o.req("GetProfileList").get("currentProfileName", "")
    if current == PROFILE_NAME:
        ok("switched to profile %r" % PROFILE_NAME)
        return False
    warn("profile %r not in OBS's list yet - restarting to load it"
         % PROFILE_NAME)
    return True


def ensure_collection(o):
    """True when OBS must be restarted for the collection to become current."""
    state = o.req("GetSceneCollectionList")
    if state.get("currentSceneCollectionName") == COLLECTION_NAME:
        ok("scene collection %r is current" % COLLECTION_NAME)
        return False
    if COLLECTION_NAME not in state.get("sceneCollections", []):
        try:
            o.req("CreateSceneCollection",
                  {"sceneCollectionName": COLLECTION_NAME})
            ok("created scene collection %r" % COLLECTION_NAME)
        except ObsError as exc:
            info("create collection: %s" % exc)
    try:
        o.req("SetCurrentSceneCollection",
              {"sceneCollectionName": COLLECTION_NAME})
    except ObsError as exc:
        warn("collection switch: %s" % exc)
    state = o.req("GetSceneCollectionList")
    if state.get("currentSceneCollectionName") == COLLECTION_NAME:
        ok("switched to scene collection %r" % COLLECTION_NAME)
        return False
    warn("scene collection %r not current yet - restarting to load it"
         % COLLECTION_NAME)
    return True


def set_profile_params(o, fps, encoder):
    params = [
        ("Output", "Mode", "Simple"),
        ("Output", "FilenameFormatting", "BGMI-Cup %CCYY-%MM-%DD %hh-%mm-%ss"),
        ("SimpleOutput", "FilePath", REC_DIR),
        ("SimpleOutput", "RecFormat2", "hybrid_mp4"),
        ("SimpleOutput", "VBitrate", "8000"),
        ("SimpleOutput", "ABitrate", "160"),
        ("SimpleOutput", "RecQuality", "HQ"),
        ("SimpleOutput", "RecEncoder", encoder),
        ("SimpleOutput", "StreamEncoder", encoder),
        ("SimpleOutput", "StreamAudioEncoder", "aac"),
        ("SimpleOutput", "RecAudioEncoder", "aac"),
        ("SimpleOutput", "RecTracks", "1"),
        ("SimpleOutput", "UseAdvanced", "false"),
        ("Video", "BaseCX", "1920"), ("Video", "BaseCY", "1080"),
        ("Video", "OutputCX", "1920"), ("Video", "OutputCY", "1080"),
        ("Video", "FPSType", "1"), ("Video", "FPSInt", str(fps)),
        ("Video", "FPSCommon", str(fps)),
        ("Video", "ScaleType", "bicubic"),
        ("Video", "ColorFormat", "NV12"),
        ("Video", "ColorSpace", "709"),
        ("Video", "ColorRange", "Partial"),
        ("Audio", "SampleRate", "48000"),
        ("Audio", "ChannelSetup", "Stereo"),
    ]
    for category, name, value in params:
        try:
            o.req("SetProfileParameter", {"parameterCategory": category,
                                          "parameterName": name,
                                          "parameterValue": value})
        except ObsError as exc:
            warn("profile parameter %s.%s: %s" % (category, name, exc))
    for category, name, expect in (("Video", "FPSInt", str(fps)),
                                   ("SimpleOutput", "RecQuality", "HQ"),
                                   ("SimpleOutput", "RecFormat2", "hybrid_mp4"),
                                   ("Output", "Mode", "Simple")):
        got = (o.try_req("GetProfileParameter",
                         {"parameterCategory": category,
                          "parameterName": name}) or {}).get("parameterValue")
        if got == expect:
            ok("%s.%s = %s" % (category, name, got))
        else:
            warn("%s.%s is %r, wanted %r" % (category, name, got, expect))


# ---------------------------------------------------------------------------
# device / encoder discovery
# ---------------------------------------------------------------------------


def physical_cameras():
    raw = ps("Get-CimInstance Win32_PnPEntity | Where-Object { "
             "$_.PNPClass -in @('Camera','Image') -and "
             "$_.Status -eq 'OK' } | Select-Object -ExpandProperty Name")
    names = [n.strip() for n in raw.splitlines() if n.strip()]
    return [n for n in names
            if not any(h in n.lower() for h in VIRTUAL_CAM_HINTS)]


def pick_encoder(preference):
    if preference and preference != "auto":
        return preference
    gpus = ps("(Get-CimInstance Win32_VideoController).Name").lower()
    if "nvidia" in gpus:
        return "nvenc"
    if "intel" in gpus:
        return "qsv"
    if "amd" in gpus or "radeon" in gpus:
        return "amd"
    return "x264"


def resolve_cameras(args):
    if args.cameras == "0":
        return []
    physical = physical_cameras()
    if args.cameras == "auto":
        want = 2 if len(physical) >= 2 else (1 if physical else 0)
    else:
        want = int(args.cameras)
    overrides = [args.cam1, args.cam2]
    picked = []
    for index in range(want):
        name = overrides[index] or (physical[index]
                                    if index < len(physical) else "")
        if name:
            picked.append(name)
    if not picked:
        warn("no physical camera found (virtual cameras excluded)")
    return picked


# ---------------------------------------------------------------------------
# sources
# ---------------------------------------------------------------------------


def ensure_input(o, name, kind, settings, scene):
    existing = {i["inputName"]: i
                for i in o.req("GetInputList").get("inputs", [])}
    if name in existing:
        entry = existing[name]
        wanted = kind.split("_v")[0]        # color_source_v3 -> color_source
        if entry.get("unversionedInputKind") not in (kind, wanted):
            warn("%r exists with kind %r (wanted %r)" %
                 (name, entry.get("unversionedInputKind"), kind))
        if settings:
            o.req("SetInputSettings", {"inputName": name,
                                       "inputSettings": settings,
                                       "overlay": True})
        ok("input %r ready" % name)
        return False
    o.req("CreateInput", {"inputName": name, "inputKind": kind,
                          "sceneName": scene, "inputSettings": settings,
                          "sceneItemEnabled": False})
    ok("created input %r" % name)
    return True


def pick_property_item(o, input_name, prop, *needles):
    """First property item whose display name contains any of the needles."""
    data = o.try_req("GetInputPropertiesListPropertyItems",
                     {"inputName": input_name,
                      "propertyName": prop}) or {}
    for item in data.get("propertyItems", []):
        label = (item.get("itemName") or "").lower()
        if any(needle.lower() in label for needle in needles):
            return item.get("itemValue")
    return None


def configure_window_capture(o, name, title_hint="BGMI-PHONE"):
    window = pick_property_item(o, name, "window", title_hint) or \
        pick_property_item(o, name, "window", "scrcpy")
    if window is None:
        warn("no window matching %r - start the phone mirror "
             "(scripts/obs/start_phone_capture.bat) and re-run setup"
             % title_hint)
    method = pick_property_item(o, name, "method", "2004") or \
        pick_property_item(o, name, "method", "1903") or \
        pick_property_item(o, name, "method", "windows 10")
    priority = pick_property_item(o, name, "priority", "must match")
    settings = {"cursor": False, "client_area": True}
    if window is not None:
        settings["window"] = window
    if method is not None:
        settings["method"] = method
    if priority is not None:
        settings["priority"] = priority
    o.req("SetInputSettings", {"inputName": name,
                               "inputSettings": settings,
                               "overlay": True})
    ok("window capture: %r (method %s)" % (window, method))


def configure_app_audio(o, name, exe_hint="scrcpy"):
    window = pick_property_item(o, name, "window", exe_hint)
    if window is None:
        warn("scrcpy process not found for application audio capture - "
             "start the phone mirror and re-run setup")
        return
    o.req("SetInputSettings", {"inputName": name,
                               "inputSettings": {"window": window},
                               "overlay": True})
    ok("application audio capture: %r" % window)


def configure_camera(o, name, device_hint):
    """dshow inputs identify devices by the encoded `video_device_id`
    value (display-name:path) taken from the property list. Setting the
    plain name in `device`/`device_name` fails - the OBS log shows
    'DecodeDeviceId failed / Video configuration failed'.
    """
    data = o.try_req("GetInputPropertiesListPropertyItems",
                     {"inputName": name,
                      "propertyName": "video_device_id"}) or {}
    items = data.get("propertyItems", [])
    hint = device_hint.strip().lower()
    chosen = None
    for item in items:                       # exact display-name match
        if (item.get("itemName") or "").strip().lower() == hint:
            chosen = item.get("itemValue")
            break
    if chosen is None:                       # relaxed contains-match
        for item in items:
            label = (item.get("itemName") or "").strip().lower()
            if hint and (hint in label or label in hint):
                chosen = item.get("itemValue")
                break
    if chosen is None:
        available = ", ".join(sorted((i.get("itemName") or "?")
                                     for i in items)) or "none detected"
        warn("camera %r not found among dshow devices (%s) - plug it in "
             "and re-run, or pick it manually: source %r > Properties"
             % (device_hint, available, name))
        return
    settings = {"video_device_id": chosen}
    res_items = (o.try_req("GetInputPropertiesListPropertyItems",
                           {"inputName": name,
                            "propertyName": "resolution"}) or {}) \
        .get("propertyItems", [])
    values = [i.get("itemValue") for i in res_items]
    if "1280x720" in values:
        settings.update({"res_type": 1, "resolution": "1280x720"})
        ok("camera %r configured @1280x720" % device_hint)
    else:
        ok("camera %r configured (device-preferred resolution)"
           % device_hint)
    o.req("SetInputSettings", {"inputName": name,
                               "inputSettings": settings, "overlay": True})


def notice_settings():
    amber = (0xFF << 24) | (0x48 << 16) | (0xCA << 8) | 0xFF      # #FFCA48
    return {"text": "PHONE MIRROR OFFLINE - run "
                     "scripts\\obs\\start_phone_capture.bat",
            "font": {"face": "Arial", "size": 44, "style": "Regular",
                     "flags": 0},
            "color": amber,
            "extents_wrap": False}


def remove_stale_sources(o, cam_count):
    existing = {i["inputName"]
                for i in o.req("GetInputList").get("inputs", [])}
    for extra in SRC_CAMS[cam_count:]:
        if extra in existing:
            o.req("RemoveInput", {"inputName": extra})
            ok("removed stale camera source %r" % extra)


# ---------------------------------------------------------------------------
# scenes / items / transforms
# ---------------------------------------------------------------------------


def planned_layers(scene, cam_count):
    layers = [SRC_BG]
    if scene in PHONE_SCENES:
        layers.append(SRC_PHONE)
        layers.append(SRC_GAME_AUDIO)
    if scene == "GAMEPLAY":
        layers.append(SRC_NOTICE)
    if scene in CAM_FAMILY:
        layers.extend(SRC_CAMS[:cam_count])
    layers.append(SRC_OVERLAY)
    return layers


def ensure_scene(o, name):
    if name in scene_names(o):
        return
    o.req("CreateScene", {"sceneName": name})
    ok("created scene %r" % name)


def ensure_scene_item(o, scene, source):
    item = scene_item(o, scene, source)
    if item:
        return item
    created = o.req("CreateSceneItem", {"sceneName": scene,
                                        "sourceName": source,
                                        "sceneItemEnabled": True})
    ok("added %r to %r" % (source, scene))
    return {"sceneItemId": created.get("sceneItemId"),
            "sourceName": source}


def phone_transform():
    """Scale To Inner Bounds 1920x1080, centered: the phone fits whole,
    black background shows as clean side bars, whatever its DPI."""
    return {"positionX": 0, "positionY": 0, "scaleX": 1.0, "scaleY": 1.0,
            "rotation": 0.0, "alignment": 5,
            "boundsType": "OBS_BOUNDS_SCALE_INNER",
            "boundsWidth": 1920.0, "boundsHeight": 1080.0,
            "boundsAlignment": 0}


def fill_transform():
    return {"positionX": 0, "positionY": 0, "scaleX": 1.0, "scaleY": 1.0,
            "rotation": 0.0, "alignment": 5,
            "boundsType": "OBS_BOUNDS_NONE"}


def notice_transform():
    return {"positionX": 420, "positionY": 960, "scaleX": 1.0, "scaleY": 1.0,
            "rotation": 0.0, "alignment": 5,
            "boundsType": "OBS_BOUNDS_NONE"}


def raw_cam_transform():
    """Pre-measurement: camera shown raw, no crop, no scaling."""
    return {"positionX": 0, "positionY": 0, "scaleX": 1.0, "scaleY": 1.0,
            "rotation": 0.0, "alignment": 5,
            "cropLeft": 0, "cropRight": 0, "cropTop": 0, "cropBottom": 0,
            "boundsType": "OBS_BOUNDS_NONE"}


def cam_crop(native_w, native_h, frame):
    """Crop the camera to the frame's aspect ratio (center crop)."""
    target = frame["w"] / float(frame["h"])
    source = native_w / float(native_h)
    if source > target:                       # source wider -> crop sides
        crop_w = max(2, min(native_w, int(round(native_h * target))))
        left = (native_w - crop_w) // 2
        return {"cropLeft": left, "cropRight": native_w - crop_w - left,
                "cropTop": 0, "cropBottom": 0}
    crop_h = max(2, min(native_h, int(round(native_w / target))))
    top = (native_h - crop_h) // 2
    return {"cropLeft": 0, "cropRight": 0,
            "cropTop": top, "cropBottom": native_h - crop_h - top}


def cam_transform(frame, crop):
    """Crop + Scale To Inner Bounds of the frame box = pixel-exact fill of
    the overlay window defined in public/camera-frames.json."""
    transform = {"positionX": frame["x"], "positionY": frame["y"],
                 "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0,
                 "alignment": 5,
                 "boundsType": "OBS_BOUNDS_SCALE_INNER",
                 "boundsWidth": float(frame["w"]),
                 "boundsHeight": float(frame["h"]),
                 "boundsAlignment": 0}
    transform.update(crop)
    return transform


def measure_cameras(o, cam_count):
    """Park cameras raw, activate the CASTERS scene and read the real
    device resolution from the scene item (DPI-proof crop math)."""
    if cam_count <= 0:
        return {}
    for scene in CAM_FAMILY:
        for cam in SRC_CAMS[:cam_count]:
            item = scene_item(o, scene, cam)
            if item:
                o.req("SetSceneItemTransform",
                      {"sceneName": scene,
                       "sceneItemId": item["sceneItemId"],
                       "sceneItemTransform": raw_cam_transform()})
    o.req("SetCurrentProgramScene", {"sceneName": "CASTERS"})
    time.sleep(3.5)                    # let DirectShow devices start
    measured = {}
    for cam in SRC_CAMS[:cam_count]:
        item = scene_item(o, "CASTERS", cam)
        width = height = 0
        if item:
            for _attempt in range(3):  # USB webcams can take a few seconds
                got = (o.try_req("GetSceneItemTransform",
                                 {"sceneName": "CASTERS",
                                  "sceneItemId": item["sceneItemId"]})
                       or {}).get("sceneItemTransform", {})
                width = int(got.get("sourceWidth") or 0)
                height = int(got.get("sourceHeight") or 0)
                if width > 0:
                    break
                time.sleep(2.0)
        measured[cam] = (width, height)
        info("%s reports %sx%s" % (cam, width or "?", height or "?"))
    return measured


def apply_cam_transforms(o, cam_count, measured):
    frames_cfg = obs_config.load_frames()
    for scene, family in CAM_FAMILY.items():
        layout = frames_cfg["layouts"]["%s-%d" % (family, cam_count)]
        for index in range(cam_count):
            cam = SRC_CAMS[index]
            frame = layout["frames"][index]
            native = measured.get(cam) or (0, 0)
            if native[0] > 0 and native[1] > 0:
                crop = cam_crop(native[0], native[1], frame)
            else:
                warn("%s is not delivering video - skipping its crop "
                     "(check the device, then re-run setup)" % cam)
                crop = {"cropLeft": 0, "cropRight": 0,
                        "cropTop": 0, "cropBottom": 0}
            item = scene_item(o, scene, cam)
            if item:
                o.req("SetSceneItemTransform",
                      {"sceneName": scene,
                       "sceneItemId": item["sceneItemId"],
                       "sceneItemTransform": cam_transform(frame, crop)})


def ensure_scenes(o):
    step("Scenes")
    for scene in SCENES:
        ensure_scene(o, scene)
    if "Scene" in scene_names(o) and "Scene" not in SCENES:
        o.req("RemoveScene", {"sceneName": "Scene"})
        ok("removed the default 'Scene'")
    ok("scenes ready: %s" % ", ".join(SCENES))


def build_layers(o, cam_count):
    step("Scenes and layers")
    for scene in SCENES:
        layers = planned_layers(scene, cam_count)
        for index, source in enumerate(layers):
            item = ensure_scene_item(o, scene, source)
            o.req("SetSceneItemIndex",
                  {"sceneName": scene, "sceneItemId": item["sceneItemId"],
                   "sceneItemIndex": index})
            o.req("SetSceneItemEnabled",
                  {"sceneName": scene, "sceneItemId": item["sceneItemId"],
                   "sceneItemEnabled": source != SRC_NOTICE})
    # static transforms
    for scene in SCENES:
        for source in planned_layers(scene, cam_count):
            item = scene_item(o, scene, source)
            if not item:
                continue
            if source == SRC_PHONE:
                transform = phone_transform()
            elif source == SRC_NOTICE:
                transform = notice_transform()
            elif source in (SRC_BG, SRC_OVERLAY):
                transform = fill_transform()
            else:
                continue                      # cameras: measured later
            o.req("SetSceneItemTransform",
                  {"sceneName": scene, "sceneItemId": item["sceneItemId"],
                   "sceneItemTransform": transform})
    ok("laid out %d scenes" % len(SCENES))


def lock_sources(o, cam_count):
    locked = 0
    for scene in SCENES:
        for source in planned_layers(scene, cam_count):
            if source in UNLOCKED:
                continue
            item = scene_item(o, scene, source)
            if item:
                o.req("SetSceneItemLocked",
                      {"sceneName": scene, "sceneItemId": item["sceneItemId"],
                       "sceneItemLocked": True})
                locked += 1
    ok("locked %d scene items (phone, cams, overlay, background)" % locked)


# ---------------------------------------------------------------------------
# audio
# ---------------------------------------------------------------------------


def ensure_mic_filters(o, input_name):
    data = o.try_req("GetSourceFilterList", {"sourceName": input_name})
    if data is None:
        warn("%r does not exist yet (fresh collection) - mic filters "
             "are applied right after the OBS restart in this same run"
             % input_name)
        return
    existing = {f["filterKind"]: f
                for f in data.get("filters", [])}
    for name, kind, settings in MIC_FILTERS:
        if kind in existing:
            entry = existing[kind]
            o.req("SetSourceFilterSettings",
                  {"sourceName": input_name,
                   "filterName": entry["filterName"],
                   "filterSettings": settings})
            if not entry.get("filterEnabled", True):
                o.req("SetSourceFilterEnabled",
                      {"sourceName": input_name,
                       "filterName": entry["filterName"],
                       "filterEnabled": True})
            ok("filter %r updated" % name)
        else:
            o.req("CreateSourceFilter",
                  {"sourceName": input_name, "filterName": name,
                   "filterKind": kind, "filterSettings": settings})
            ok("filter %r created" % name)


def configure_audio(o):
    step("Audio")
    data = o.try_req("SetInputSettings", {"inputName": "Desktop Audio",
                                          "inputSettings":
                                              {"device_id": "disabled"}})
    got = (o.try_req("GetInputSettings", {"inputName": "Desktop Audio"})
           or {}).get("inputSettings", {}).get("device_id")
    if got == "disabled":
        ok("desktop audio disabled (no desktop audio on stream)")
    elif data is None:
        warn("no 'Desktop Audio' input in this collection")
    else:
        warn("desktop audio still %r - disable it in OBS Settings > Audio"
             % got)
    o.try_req("SetInputSettings", {"inputName": "Mic/Aux",
                                   "inputSettings": {"device_id": "default"}})
    ok("mic follows the Windows default input device")
    for name in ("Mic/Aux", "Desktop Audio", SRC_GAME_AUDIO):
        o.try_req("SetInputAudioMonitorType",
                  {"inputName": name,
                   "monitorType": "OBS_MONITORING_TYPE_NONE"})
    ok("monitoring off on mic / desktop / game audio")
    ensure_mic_filters(o, "Mic/Aux")


# ---------------------------------------------------------------------------
# phase B: hotkeys + export (OBS closed)
# ---------------------------------------------------------------------------


def audio_device_entry(name, kind, device_id):
    """One global audio device, in the exact shape OBS saves itself
    (top-level DesktopAudioDevice1 / AuxAudioDevice1 entries). A collection
    created over websocket has no such entries, so we add them - OBS then
    creates the 'Desktop Audio' / 'Mic/Aux' devices at startup as real
    output sources (this keeps mic filters working and persistent).
    """
    return {
        "prev_ver": 537001986,
        "name": name,
        "uuid": str(uuid.uuid4()),
        "id": kind,
        "versioned_id": kind,
        "settings": {"device_id": device_id},
        "mixers": 255,
        "sync": 0,
        "flags": 0,
        "volume": 1.0,
        "balance": 0.5,
        "enabled": True,
        "muted": False,
        "push-to-mute": False,
        "push-to-mute-delay": 0,
        "push-to-talk": False,
        "push-to-talk-delay": 0,
        "hotkeys": {"libobs.mute": [], "libobs.unmute": [],
                    "libobs.push-to-mute": [], "libobs.push-to-talk": []},
        "deinterlace_mode": 0,
        "deinterlace_field_order": 0,
        "monitoring_type": 0,
        "private_settings": {},
    }


def find_collection_file():
    """OBS sanitizes the collection name for the file on disk (spaces
    become underscores: 'BGMI Cup' -> 'BGMI_Cup.json'), so locate the file
    by the 'name' field inside it instead of guessing the filename."""
    candidates = []
    try:
        names = os.listdir(SCENES_DIR)
    except OSError:
        return None, None
    for fname in names:
        if not fname.endswith(".json"):
            continue
        path = os.path.join(SCENES_DIR, fname)
        try:
            with io.open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("name") == COLLECTION_NAME:
            candidates.append((os.path.getmtime(path), path, data))
    if not candidates:
        return None, None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1], candidates[0][2]


def patch_collection_and_export():
    path, data = find_collection_file()
    if not path:
        raise SystemExit("could not find the scene collection file for %r "
                         "in %s (did OBS save on exit?)"
                         % (COLLECTION_NAME, SCENES_DIR))
    by_name = {s.get("name"): s for s in data.get("sources", [])
               if s.get("id") == "scene"}
    patched = 0
    for index, scene in enumerate(SCENES):
        entry = by_name.get(scene)
        if not entry:
            warn("collection json has no scene %r" % scene)
            continue
        entry["hotkeys"] = {"OBSBasic.SelectScene":
                            [{"key": HOTKEYS[index]}]}
        patched += 1
    data["scene_order"] = [{"name": s} for s in SCENES]
    data["current_scene"] = SCENES[0]
    data["current_program_scene"] = SCENES[0]
    added = []
    if "DesktopAudioDevice1" not in data:
        data["DesktopAudioDevice1"] = audio_device_entry(
            "Desktop Audio", "wasapi_output_capture", "disabled")
        added.append("Desktop Audio (disabled)")
    if "AuxAudioDevice1" not in data:
        data["AuxAudioDevice1"] = audio_device_entry(
            "Mic/Aux", "wasapi_input_capture", "default")
        added.append("Mic/Aux (system default input)")
    with io.open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=4)
        fh.write("\n")
    ok("hotkeys F1-F8 bound to the 8 scenes (%d patched)" % patched)
    if added:
        ok("global audio devices added: %s" % ", ".join(added))

    _, token, _ = obs_config.overlay_target()
    text = json.dumps(data, ensure_ascii=False, indent=4) + "\n"
    if token:
        text = text.replace(token, "${BGMI_OVERLAY_TOKEN}")
    with io.open(EXPORT_PATH, "w", encoding="utf-8") as fh:
        fh.write(text)
    ok("token-free export -> %s" % EXPORT_PATH)


# ---------------------------------------------------------------------------
# verification / summary
# ---------------------------------------------------------------------------


def final_verify(o, cam_count):
    step("Verify")
    names = scene_names(o)
    missing = [s for s in SCENES if s not in names]
    if missing:
        warn("missing scenes: %s" % ", ".join(missing))
    else:
        ok("all 8 scenes present")
    try:
        program = o.req("GetCurrentProgramScene").get(
            "currentProgramSceneName")
        ok("program scene: %s" % program)
    except ObsError:
        pass
    studio = (o.req("GetStudioModeEnabled") or {}).get("studioModeEnabled")
    if studio:
        o.req("SetStudioModeEnabled", {"studioModeEnabled": False})
        info("studio mode was on - turned it off")
    ok("studio mode off (direct program switching)")
    state = o.req("GetSceneCollectionList")
    ok("collection: %s" % state.get("currentSceneCollectionName"))
    profile = o.req("GetProfileList")
    ok("profile: %s" % profile.get("currentProfileName"))


def print_summary(cams, cam_count, fps, encoder, origin, measured):
    step("Summary")
    info("profile  : %s (encoder %s, 1920x1080@%d, CBR 8000 kbps, "
         "AAC 160 kbps)" % (PROFILE_NAME, encoder, fps))
    info("recording: %s (hybrid MP4, HQ preset, separate from stream)"
         % REC_DIR)
    info("collection: %s - 8 scenes" % COLLECTION_NAME)
    for index, scene in enumerate(SCENES):
        info("  F%d -> %s" % (index + 1, scene))
    if cams:
        for index, device in enumerate(cams):
            size = measured.get(SRC_CAMS[index]) or (0, 0)
            info("camera %d : %s (%s) -> frame %d with name plate CAM 0%d"
                 % (index + 1, device,
                    ("%dx%d" % size) if size[0] else "no signal yet",
                    index + 1, index + 1))
    else:
        warn("no camera configured - overlay URL got &frame=off")
    info("fallback : 'Phone Offline Notice' (GAMEPLAY) is hidden by "
         "default - reveal it (eye icon) if the phone mirror dies")
    if origin == "env":
        info("overlay  : BGMI_BASE_URL from the environment (production)")
    else:
        info("overlay  : local dev server (http://127.0.0.1:8080), "
             "token redacted")
        print()
        obs_config.setx_hint()
    print()
    info("stream key: NEVER touched - set service + key yourself in OBS "
         "Settings > Stream before going live.")
    info("start streaming is never automated by these scripts.")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fps", choices=("60", "30"), default="60")
    parser.add_argument("--cameras", choices=("auto", "0", "1", "2"),
                        default="auto")
    parser.add_argument("--encoder",
                        choices=("auto", "qsv", "nvenc", "amd", "x264"),
                        default="auto")
    parser.add_argument("--cam1", default="")
    parser.add_argument("--cam2", default="")
    parser.add_argument("--no-restart", action="store_true",
                        help="skip the exit/patch/relaunch phase (fast "
                             "iterations; hotkeys+export are written on "
                             "the next full run)")
    args = parser.parse_args()

    if not os.path.isdir(SCENES_DIR):
        raise SystemExit("OBS config dir not found: %s" % SCENES_DIR)
    os.makedirs(REC_DIR, exist_ok=True)
    fps = int(args.fps)
    encoder = pick_encoder(args.encoder)
    cams = resolve_cameras(args)
    cam_count = len(cams)

    step("Connect")
    o = connect_or_launch()
    ok("obs-websocket reachable")
    if ensure_profile(o, fps, encoder):
        o.close()
        o = restart_obs(collection=False)
    set_profile_params(o, fps, encoder)
    try:
        needs_restart = ensure_collection(o)
    except ObsError as exc:
        warn("collection switch dropped the websocket (%s)" % exc)
        o = hard_reconnect()
        needs_restart = (o.req("GetSceneCollectionList").get(
            "currentSceneCollectionName") != COLLECTION_NAME)
    if needs_restart:
        o.close()
        o = restart_obs(collection=True)

    ensure_scenes(o)

    step("Sources")
    ensure_input(o, SRC_BG, "color_source_v3",
                 {"color": 0xFF000000, "width": 1920, "height": 1080},
                 "PRE-SHOW")
    ensure_input(o, SRC_PHONE, "window_capture", {}, "PRE-SHOW")
    configure_window_capture(o, SRC_PHONE)
    ensure_input(o, SRC_NOTICE, "text_gdiplus_v3", notice_settings(),
                 "GAMEPLAY")
    for index, device in enumerate(cams):
        ensure_input(o, SRC_CAMS[index], "dshow_input", {}, "COUNTDOWN")
        ok("camera %d = %r" % (index + 1, device))
        configure_camera(o, SRC_CAMS[index], device)
    ensure_input(o, SRC_GAME_AUDIO, "wasapi_process_output_capture", {},
                 "PRE-SHOW")
    configure_app_audio(o, SRC_GAME_AUDIO)
    url, origin = obs_config.program_url(frames=cam_count or None)
    if cam_count == 0:
        url += "&frame=off"
    ensure_input(o, SRC_OVERLAY, "browser_source",
                 {"url": url, "width": 1920, "height": 1080,
                  "fps": fps, "fps_custom": True, "shutdown": False,
                  "restart_when_active": False, "hwaccel": True},
                 "PRE-SHOW")
    remove_stale_sources(o, cam_count)

    build_layers(o, cam_count)
    measured = measure_cameras(o, cam_count)
    apply_cam_transforms(o, cam_count, measured)
    lock_sources(o, cam_count)
    configure_audio(o)
    o.req("SetStudioModeEnabled", {"studioModeEnabled": False})
    o.req("SetCurrentProgramScene", {"sceneName": SCENES[0]})

    if not args.no_restart:
        step("Hotkeys + export (OBS restart)")
        o.close()
        exit_obs()
        patch_collection_and_export()
        o = restart_obs(collection=True)
        configure_audio(o)          # global audio devices exist again now

    final_verify(o, cam_count)
    print_summary(cams, cam_count, fps, encoder, origin, measured)
    o.close()


if __name__ == "__main__":
    main()
