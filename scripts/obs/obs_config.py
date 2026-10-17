"""Shared configuration for the BGMI Cup OBS tooling (scripts/obs/).

Secrets are read from the process environment first, then from the repo's
gitignored .env file. Nothing in this module ever prints a secret value.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys

REPO_DIR = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
ENV_PATH = os.path.join(REPO_DIR, ".env")
FRAMES_PATH = os.path.join(REPO_DIR, "public", "camera-frames.json")
DEFAULT_DB = os.path.join(REPO_DIR, "data", "registrations.db")


def load_dotenv(path=ENV_PATH):
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                values[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


_DOTENV = load_dotenv()


def env(name, default=""):
    return os.environ.get(name) or _DOTENV.get(name) or default


def obs_ws_url():
    """(host, port, password) for obs-websocket, or exit with instructions."""
    host = env("OBS_WS_HOST", "127.0.0.1")
    port = env("OBS_WS_PORT", "4455")
    password = env("OBS_WEBSOCKET_PASSWORD")
    if not password:
        print("ERROR: OBS_WEBSOCKET_PASSWORD is not set.", file=sys.stderr)
        print('  Fix it once with:  setx OBS_WEBSOCKET_PASSWORD "<password>"',
              file=sys.stderr)
        print("  (or add OBS_WEBSOCKET_PASSWORD=... to the repo .env file)",
              file=sys.stderr)
        raise SystemExit(2)
    return host, port, password


def load_frames(path=None):
    """The single source of truth for camera-frame geometry.

    Read by BOTH this tooling (OBS source transforms) and the overlay
    itself (public/overlay.js fetches /camera-frames.json at runtime).
    """
    with open(path or FRAMES_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def local_overlay_token(db_path=None):
    """Overlay token from the local dev database (no value ever printed)."""
    try:
        conn = sqlite3.connect(db_path or env("BGMI_DB", DEFAULT_DB))
        try:
            row = conn.execute(
                "SELECT value FROM overlay_settings WHERE key = 'token'"
            ).fetchone()
            return row[0] if row else ""
        finally:
            conn.close()
    except sqlite3.Error:
        return ""


def overlay_target():
    """(base_url, token, origin).

    BGMI_BASE_URL + BGMI_OVERLAY_TOKEN from the environment take priority
    (production/Railway). If either is missing we fall back to the local
    dev server and the local database token so the setup still works on
    this machine - callers should tell the user how to set the env vars.
    """
    base = env("BGMI_BASE_URL").rstrip("/")
    token = env("BGMI_OVERLAY_TOKEN")
    if base and token:
        return base, token, "env"
    return "http://127.0.0.1:8080", local_overlay_token(), "local"


def program_url(frames=None):
    """One-URL program overlay (follows the producer desk scene switcher)."""
    base, token, origin = overlay_target()
    url = "%s/overlay/program?token=%s" % (base, token)
    if frames:
        url += "&frames=%d" % int(frames)
    return url, origin


def scene_url(scene, frames=None):
    base, token, origin = overlay_target()
    url = "%s/overlay/%s?token=%s" % (base, scene, token)
    if frames:
        url += "&frames=%d" % int(frames)
    return url, origin


def setx_hint(stream=sys.stdout):
    print("To point OBS at your deployed (Railway) overlays, set these once "
          "in a new terminal:", file=stream)
    print('  setx BGMI_BASE_URL "https://<your-app>.up.railway.app"', file=stream)
    print('  setx BGMI_OVERLAY_TOKEN "<paste from /admin/overlays>"', file=stream)
    print("Then re-run scripts/obs/setup_obs.py.", file=stream)
