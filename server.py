#!/usr/bin/env python3
"""
BGMI Cup Noida 2026 — fullstack registration server.

Pure Python stdlib (no pip installs). Serves the static site plus a JSON API:

  GET  /                      -> bgmi-team-registration.html
  GET  /api/health            -> {ok, count}
  GET  /api/csrf              -> {token}            (short-lived, IP-bound)
  POST /api/register          -> {ok, teamId}       (multipart or urlencoded)
  POST /api/status/lookup     -> {status, ...}      (reg code + captain hint)
  GET  /api/admin/...         -> approval workflow  (session cookie + CSRF)
  GET  /uploads/<file>        -> saved team logos

Storage: SQLite (registrations.db) with a UNIQUE index on team_tag and
roster_members.uid — "one account per player" is enforced at the DB level.

Run:  python server.py            (HOST=127.0.0.1 PORT=8080 by default)
Env:  PORT, HOST, BGMI_DB, BGMI_UPLOADS, BGMI_SMTP_* (optional mail),
      BGMI_RATE_LIMIT (submissions per window), BGMI_RATE_WINDOW (seconds)
"""

import base64
import hashlib
import hmac
import json
import os
import queue
import random
import re
import secrets
import sqlite3
import threading
import time
import zlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

import broadcast

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT, "public")   # web layer (pages, css, js, assets)
DATA_DIR = os.path.join(ROOT, "data")       # live data: database + uploads
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
DB_PATH = os.environ.get("BGMI_DB", os.path.join(DATA_DIR, "registrations.db"))
UPLOAD_DIR = os.environ.get("BGMI_UPLOADS", os.path.join(DATA_DIR, "uploads"))
RATE_LIMIT = int(os.environ.get("BGMI_RATE_LIMIT", "30"))
RATE_WINDOW = int(os.environ.get("BGMI_RATE_WINDOW", "3600"))
STATUS_RATE_LIMIT = int(os.environ.get("BGMI_STATUS_RATE_LIMIT", "5"))
STATUS_RATE_WINDOW = int(os.environ.get("BGMI_STATUS_RATE_WINDOW", "60"))
SESSION_TTL = int(os.environ.get("BGMI_SESSION_TTL", "1209600"))  # absolute cap
# Idle expiry: a session unused for this many seconds is revoked even if the
# absolute TTL has not elapsed.  Configurable so ops can tighten it for events.
SESSION_IDLE_TTL = int(os.environ.get("BGMI_SESSION_IDLE_TTL", "28800"))  # 8h
NOTIFY_MAX_ATTEMPTS = int(os.environ.get("BGMI_NOTIFY_ATTEMPTS", "5"))
SLOT_LIMIT = int(os.environ.get("BGMI_SLOT_LIMIT", "16"))

# Optional e-mail notifications (free SMTP, e.g. Gmail app password).
# When unset the notifier skips silently, as designed.
SMTP_HOST = os.environ.get("BGMI_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("BGMI_SMTP_PORT", "587"))
SMTP_USER = os.environ.get("BGMI_SMTP_USER", "")
SMTP_PASS = os.environ.get("BGMI_SMTP_PASS", "")
SMTP_FROM = os.environ.get("BGMI_SMTP_FROM", SMTP_USER or "noreply@bgmicup.local")
NOTIFY_POLL = int(os.environ.get("BGMI_NOTIFY_POLL", "30"))
MAX_BODY = 4 * 1024 * 1024          # logo base64 inflates ~4/3 over 2 MB
CSRF_TTL = 3600

INDEX_PAGE = "bgmi-team-registration.html"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

# ---------------------------------------------------------------------------
# Validation — mirrors js/bgmi-register.js validators
# ---------------------------------------------------------------------------

RE_TAG = re.compile(r"^[A-Z0-9]{2,5}$")
RE_IGN = re.compile(r"^[A-Za-z0-9_().\-\s]{3,16}$")
RE_UID = re.compile(r"^\d{6,12}$")
RE_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
RE_DISCORD = re.compile(r"^@?[A-Za-z0-9._]{2,32}(#\d{4})?$")


class ValidationError(Exception):
    def __init__(self, message, field=None):
        super().__init__(message)
        self.message = message
        self.field = field


def v_team_name(val):
    val = (val or "").strip()
    if len(val) < 3:
        raise ValidationError("Team name needs at least 3 characters.", "teamName")
    if len(val) > 24:
        raise ValidationError("Keep team names to 24 characters.", "teamName")
    if "<" in val or ">" in val:
        raise ValidationError("No angle brackets in team names.", "teamName")
    return val


def v_tag(val):
    tag = (val or "").strip().upper()
    if not RE_TAG.match(tag):
        raise ValidationError("Tag = 2-5 letters or numbers only.", "teamTag")
    return tag


def v_guild(val):
    val = (val or "").strip()
    if len(val) < 2:
        raise ValidationError("Enter your in-game guild name.", "guildName")
    if "<" in val or ">" in val:
        raise ValidationError("No angle brackets in guild names.", "guildName")
    return val


def v_ign(val, field=None):
    val = (val or "").strip()
    if not RE_IGN.match(val):
        raise ValidationError(
            "IGNs: 3-16 characters (letters, numbers, spaces, _ ( ) . -).", field)
    return val


def v_uid(val, field=None):
    val = (val or "").strip()
    if not RE_UID.match(val):
        raise ValidationError(
            "Character IDs are 6-12 digits. Check the profile screen.", field)
    return val


def v_email(val):
    val = (val or "").strip()
    if not RE_EMAIL.match(val):
        raise ValidationError("That email doesn't look right.", "capEmail")
    return val.lower()


def v_phone(val):
    cleaned = re.sub(r"\s", "", (val or ""))
    cleaned = re.sub(r"^\+91", "", cleaned)
    if not re.match(r"^\d{10}$", cleaned):
        raise ValidationError(
            "Phone number looks sus. Need exactly 10 digits.", "capPhone")
    return cleaned


def v_discord(val):
    val = (val or "").strip()
    if not val:
        return ""
    if not RE_DISCORD.match(val):
        raise ValidationError(
            "Discord handles: letters, numbers, dots, underscores.", "capDiscord")
    return val


LOGO_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "png", ("image/png",)),
    (b"\xff\xd8\xff", "jpg", ("image/jpeg", "image/jpg")),
)

# Upper dimension bounds only: they defuse decompression-bomb canvases long
# before any renderer touches the file.  No minimum is enforced because the
# original flow accepted tiny logos and a 1x1 image is harmless.
MAX_DIM, MAX_PIXELS = 8000, 40000000


def _png_info(raw):
    """Walk the PNG chunk stream: IHDR first, CRCs verified, IEND reached.

    Full pixel decoding needs a dependency this project refuses; chunk/CRC
    validation plus dimension bounds is the strongest stdlib-only check."""
    if len(raw) < 33:      # signature + IHDR chunk + IEND chunk
        raise ValidationError("That PNG is cut off.", "logo")
    pos = 8
    width = height = None
    while pos + 8 <= len(raw):
        length = int.from_bytes(raw[pos:pos + 4], "big")
        ctype = raw[pos + 4:pos + 8]
        data_start = pos + 8
        crc_start = data_start + length
        if crc_start + 4 > len(raw):
            raise ValidationError("That PNG is cut off.", "logo")
        payload = raw[data_start:crc_start]
        stored = int.from_bytes(raw[crc_start:crc_start + 4], "big")
        if stored != zlib.crc32(ctype + payload) & 0xFFFFFFFF:
            raise ValidationError("That PNG is corrupt.", "logo")
        if ctype == b"IHDR":
            if pos != 8 or len(payload) != 13:
                raise ValidationError("That PNG is malformed.", "logo")
            width = int.from_bytes(payload[0:4], "big")
            height = int.from_bytes(payload[4:8], "big")
        if ctype == b"IEND":
            if width is None:
                raise ValidationError("That PNG is malformed.", "logo")
            return width, height
        pos = crc_start + 4
    raise ValidationError("That PNG is cut off (no IEND).", "logo")


def _jpeg_info(raw):
    """Walk JPEG markers to the SOF frame header, then require an EOI."""
    if len(raw) < 4:
        raise ValidationError("That JPEG is cut off.", "logo")
    pos = 2                                   # past SOI
    while pos + 4 <= len(raw):
        if raw[pos] != 0xFF:
            raise ValidationError("That JPEG is malformed.", "logo")
        marker = raw[pos + 1]
        if marker == 0xD8 or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            pos += 2                          # standalone marker
            continue
        if marker == 0xD9:                    # EOI before any frame header
            break
        length = int.from_bytes(raw[pos + 2:pos + 4], "big")
        if length < 2 or pos + 2 + length > len(raw):
            raise ValidationError("That JPEG is cut off.", "logo")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            seg = raw[pos + 4:pos + 2 + length]
            if len(seg) < 5:
                raise ValidationError("That JPEG is malformed.", "logo")
            height = int.from_bytes(seg[1:3], "big")
            width = int.from_bytes(seg[3:5], "big")
            if b"\xff\xd9" not in raw[pos:]:
                raise ValidationError("That JPEG is cut off (no EOI).", "logo")
            return width, height
        pos += 2 + length
    raise ValidationError("That JPEG has no frame header.", "logo")


def _webp_info(raw):
    """WebP: RIFF container; VP8 / VP8L / VP8X chunk carries the size."""
    if len(raw) < 16:
        raise ValidationError("That WebP is cut off.", "logo")
    riff_size = int.from_bytes(raw[4:8], "little")
    if riff_size + 8 > len(raw) + 1:
        raise ValidationError("That WebP is cut off.", "logo")
    fourcc = raw[12:16]
    if fourcc == b"VP8 ":
        if len(raw) < 30 or raw[23:26] != b"\x9d\x01\x2a":
            raise ValidationError("That WebP is malformed.", "logo")
        width = int.from_bytes(raw[26:28], "little") & 0x3FFF
        height = int.from_bytes(raw[28:30], "little") & 0x3FFF
        return width, height
    if fourcc == b"VP8L":
        if len(raw) < 25 or raw[20] != 0x2F:
            raise ValidationError("That WebP is malformed.", "logo")
        bits = int.from_bytes(raw[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if fourcc == b"VP8X":
        if len(raw) < 30:
            raise ValidationError("That WebP is cut off.", "logo")
        return (int.from_bytes(raw[24:27], "little") + 1,
                int.from_bytes(raw[27:30], "little") + 1)
    raise ValidationError("That WebP has no image chunk.", "logo")


def validate_logo(data_url):
    """Return (bytes, ext) for a valid data-URL logo, else raise ValidationError.

    Content is verified from its own bytes (magic + container structure +
    dimension bounds); the declared data-URL MIME type is never trusted and
    must agree with what the bytes actually are.  Limitation: pixels are not
    decoded or re-encoded — that needs a dependency — so structure checks are
    the strongest guarantee available under the stdlib-only constraint."""
    m = re.match(r"^data:image/(png|jpe?g|webp);base64,(.+)$", data_url or "", re.S)
    if not m:
        raise ValidationError("Logo must be PNG, JPG or WEBP.", "logo")
    declared = m.group(1).lower()
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception:
        raise ValidationError("Logo data couldn't be decoded. Re-upload it.", "logo")
    if len(raw) > 2 * 1024 * 1024:
        raise ValidationError("Logo too thicc \u2014 max 2 MB.", "logo")

    if raw[:8] == LOGO_MAGIC[0][0]:
        ext, width, height = "png", *_png_info(raw)
    elif raw[:3] == LOGO_MAGIC[1][0]:
        ext, width, height = "jpg", *_jpeg_info(raw)
    elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        ext, width, height = "webp", *_webp_info(raw)
    else:
        raise ValidationError("That file isn't really a PNG, JPG or WEBP.", "logo")

    if width > MAX_DIM or height > MAX_DIM or width * height > MAX_PIXELS:
        raise ValidationError(
            "That image is bigger than %d px on a side - pick a smaller logo."
            % MAX_DIM, "logo")

    if (declared == "png" and ext != "png") or \
       (declared in ("jpg", "jpeg") and ext != "jpg") or \
       (declared == "webp" and ext != "webp"):
        raise ValidationError("Logo type doesn't match its file contents.", "logo")
    return raw, ext


def validate_roster(payload):
    """Validate the roster JSON array. Returns list of dicts (P1..P4 + 0-2 subs)."""
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            raise ValidationError("Roster payload is malformed.", "roster")
    if not isinstance(payload, list):
        raise ValidationError("Roster payload is malformed.", "roster")

    starters, subs = [], []
    for entry in payload:
        if not isinstance(entry, dict):
            raise ValidationError("Roster entries are malformed.", "roster")
        slot = str(entry.get("slot", "")).upper()
        role = str(entry.get("role", "")).strip() or "Starter"
        ign = str(entry.get("ign", "")).strip()
        uid = str(entry.get("uid", "")).strip()

        if not ign and not uid:
            continue                      # blank sub row — ignore

        if slot.startswith("S"):
            if not ign and uid:
                raise ValidationError(
                    "Substitute rows need an IGN alongside the Character ID.", "roster")
            if ign and not uid:
                raise ValidationError(
                    "Substitute rows need a Character ID alongside the IGN.", "roster")
            subs.append({"slot": slot, "role": "Substitute",
                         "ign": v_ign(ign), "uid": v_uid(uid)})
            continue

        # P1 is the captain — client shows those errors on the captain fields
        ign_field = "capIgn" if slot == "P1" else slot.lower() + "Ign"
        uid_field = "capUid" if slot == "P1" else slot.lower() + "Uid"
        starters.append({"slot": slot or "?", "role": role,
                         "ign": v_ign(ign, ign_field), "uid": v_uid(uid, uid_field)})

    if len(starters) != 4:
        raise ValidationError(
            "A squad needs exactly 4 starters (captain + 3).", "roster")
    slots = {s["slot"] for s in starters}
    if not {"P1", "P2", "P3", "P4"} <= slots:
        raise ValidationError("Roster slots P1-P4 are all required.", "roster")
    if len(subs) > 2:
        raise ValidationError("Max 2 substitutes.", "roster")

    seen_uid, seen_ign = {}, {}
    for m in starters + subs:
        if m["uid"] in seen_uid:
            raise ValidationError(
                "Character ID %s appears twice (%s & %s). One account per player."
                % (m["uid"], seen_uid[m["uid"]], m["slot"]), "roster")
        seen_uid[m["uid"]] = m["slot"]
        low = m["ign"].lower()
        if low in seen_ign:
            raise ValidationError(
                'IGN "%s" is registered twice (%s & %s).'
                % (m["ign"], seen_ign[low], m["slot"]), "roster")
        seen_ign[low] = m["slot"]

    return starters + subs


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

DB_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS registrations (
  team_id     TEXT PRIMARY KEY,
  team_name   TEXT NOT NULL,
  team_tag    TEXT NOT NULL UNIQUE,
  guild_name  TEXT NOT NULL,
  logo_path   TEXT,
  cap_ign     TEXT NOT NULL,
  cap_uid     TEXT NOT NULL,
  cap_email   TEXT NOT NULL,
  cap_phone   TEXT NOT NULL,
  cap_discord TEXT DEFAULT '',
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roster_members (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES registrations(team_id) ON DELETE CASCADE,
  slot    TEXT NOT NULL,
  role    TEXT NOT NULL,
  ign     TEXT NOT NULL,
  uid     TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_members_team ON roster_members(team_id);
CREATE TABLE IF NOT EXISTS admin_users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,
  pass_salt   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_login  TEXT
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash    TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  admin     TEXT NOT NULL,
  team_id   TEXT,
  action    TEXT NOT NULL,
  field     TEXT,
  old_value TEXT,
  new_value TEXT,
  at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL REFERENCES registrations(team_id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS groups (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  size   INTEGER NOT NULL DEFAULT 4,
  locked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL REFERENCES registrations(team_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,               -- status | group | schedule
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending/sent/skipped/failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    TEXT,
  last_error TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at    TEXT
);
-- at most one queued job per (team, kind) until it leaves 'pending'
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_pending
  ON notification_queue(team_id, kind) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_queue_status ON notification_queue(status);
CREATE INDEX IF NOT EXISTS idx_audit_team ON audit_log(team_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
"""

# Columns added to pre-existing registrations tables (idempotent migration).
REG_MIGRATION = {
    "reg_code": "TEXT",
    "status": "TEXT NOT NULL DEFAULT 'pending'",
    "status_note": "TEXT DEFAULT ''",
    "decided_at": "TEXT",
    "decided_by": "TEXT",
    "updated_at": "TEXT",
    "schedule_note": "TEXT DEFAULT ''",
    "group_id": "INTEGER REFERENCES groups(id) ON DELETE SET NULL",
    "admin_note": "TEXT DEFAULT ''",
}

DEFAULT_SETTINGS = {
    "slot_limit": str(SLOT_LIMIT),
    "public_teams": "0",
    "groups_locked": "0",
    "timezone": "Asia/Kolkata",
    "schedule_note": "",          # public day-of schedule text (/schedule)
    "schedule_updated": "",
}


def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with DB_LOCK:
        conn = db()
        try:
            conn.executescript(SCHEMA)
            # idempotent column migration for pre-existing installs
            existing = {r["name"] for r in conn.execute(
                "PRAGMA table_info(registrations)")}
            for col, decl in REG_MIGRATION.items():
                if col not in existing:
                    conn.execute(
                        "ALTER TABLE registrations ADD COLUMN %s %s" % (col, decl))
            # indexes over migrated columns — only safe once the columns exist
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_code "
                         "ON registrations(reg_code)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_reg_status "
                         "ON registrations(status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_reg_group "
                         "ON registrations(group_id)")
            # last_seen powers the session idle timeout (added late)
            sess_cols = {r["name"] for r in conn.execute(
                "PRAGMA table_info(admin_sessions)")}
            if "last_seen" not in sess_cols:
                conn.execute("ALTER TABLE admin_sessions "
                             "ADD COLUMN last_seen TEXT")
            # default settings (never overwrite existing values)
            for k, v in DEFAULT_SETTINGS.items():
                conn.execute("INSERT OR IGNORE INTO settings (key, value) "
                             "VALUES (?, ?)", (k, v))
            # broadcast tables (matches, results, player stats, events,
            # scoring rules, overlay settings) — additive, never destructive
            broadcast.migrate(conn)
            # backfill: rows without a public code predate the workflow —
            # they were accepted under the old first-come rule → approved
            for r in conn.execute(
                    "SELECT team_id, reg_code FROM registrations"):
                if not r["reg_code"]:
                    code = next_reg_code(conn)
                    conn.execute(
                        "UPDATE registrations SET reg_code = ?, "
                        "status = 'approved', "
                        "updated_at = COALESCE(updated_at, ?) WHERE team_id = ?",
                        (code, now_iso(), r["team_id"]))
            conn.commit()
        finally:
            conn.close()
    os.makedirs(UPLOAD_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# Approval workflow helpers
# ---------------------------------------------------------------------------

STATUSES = ("pending", "approved", "rejected", "waitlisted", "needs_changes")
STATUS_LABELS = {
    "pending": "Pending review",
    "approved": "Approved",
    "rejected": "Rejected",
    "waitlisted": "Waitlisted",
    "needs_changes": "Needs changes",
}
PII_FIELDS = ("cap_email", "cap_phone", "cap_uid", "uid")   # audit keeps no values


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def next_reg_code(conn):
    """Public-facing code like BGMI26-0042 (sequential, never reused)."""
    n = 1
    for r in conn.execute("SELECT reg_code FROM registrations "
                          "WHERE reg_code LIKE 'BGMI26-%'"):
        tail = (r["reg_code"] or "")[7:]
        if tail.isdigit():
            n = max(n, int(tail) + 1)
    return "BGMI26-%04d" % n


def hash_password(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.scrypt(pw.encode("utf-8"), salt=bytes.fromhex(salt),
                       n=16384, r=8, p=1).hex()
    return h, salt


def verify_password(pw, salt, expected):
    try:
        return hmac.compare_digest(hash_password(pw, salt)[0], expected)
    except Exception:
        return False


# Constant dummy hash: login attempts that name a missing user run the same
# scrypt work as real ones, so response timing cannot enumerate usernames.
LOGIN_DUMMY_SALT = secrets.token_hex(16)
LOGIN_DUMMY_HASH = hash_password("timing-equaliser", LOGIN_DUMMY_SALT)[0]


# ---- settings -------------------------------------------------------------

def get_setting(conn, key, default=""):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key, value):
    conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, str(value)))


# ---- audit ----------------------------------------------------------------

def audit(conn, admin, team_id, action, field=None, old=None, new=None):
    """Log an admin action. PII field values are never stored."""
    if field in PII_FIELDS:
        old = new = "(changed)"
    conn.execute(
        "INSERT INTO audit_log (admin, team_id, action, field, old_value, "
        "new_value, at) VALUES (?,?,?,?,?,?,?)",
        (admin, team_id, action, field,
         None if old is None else str(old)[:200],
         None if new is None else str(new)[:200], now_iso()))


# ---- sessions -------------------------------------------------------------

def session_create(admin_id):
    raw = secrets.token_urlsafe(32)
    sid = hashlib.sha256(raw.encode()).hexdigest()
    csrf = secrets.token_urlsafe(24)
    now = time.time()
    with DB_LOCK:
        conn = db()
        try:
            conn.execute(
                "INSERT INTO admin_sessions (id_hash, admin_id, csrf, "
                "created_at, expires_at, last_seen) VALUES (?,?,?,?,?,?)",
                (sid, admin_id, csrf,
                 datetime.fromtimestamp(now, timezone.utc).isoformat(),
                 datetime.fromtimestamp(now + SESSION_TTL,
                                        timezone.utc).isoformat(),
                 datetime.fromtimestamp(now, timezone.utc).isoformat()))
            conn.commit()
        finally:
            conn.close()
    return raw, csrf


def session_lookup(raw):
    """Return (admin_row, csrf) for a raw session cookie or None.

    Enforces both the absolute expiry (expires_at) and the idle timeout
    (last_seen): a session untouched for SESSION_IDLE_TTL seconds is
    revoked on the next request.  last_seen is only rewritten when it is
    more than a minute old to avoid a write on every API call."""
    if not raw:
        return None
    sid = hashlib.sha256(raw.encode()).hexdigest()
    with DB_LOCK:
        conn = db()
        try:
            row = conn.execute(
                "SELECT s.csrf, s.expires_at, s.last_seen, u.id, u.username "
                "FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_id "
                "WHERE s.id_hash = ?", (sid,)).fetchone()
            if not row:
                return None
            now = now_iso()
            cutoff = datetime.fromtimestamp(
                time.time() - SESSION_IDLE_TTL, timezone.utc).isoformat()
            stale = row["expires_at"] < now or (
                row["last_seen"] and row["last_seen"] < cutoff)
            if stale:
                conn.execute("DELETE FROM admin_sessions WHERE id_hash = ?", (sid,))
                conn.commit()
                return None
            if not row["last_seen"] or row["last_seen"] < (
                    datetime.fromtimestamp(time.time() - 60,
                                           timezone.utc).isoformat()):
                conn.execute(
                    "UPDATE admin_sessions SET last_seen = ? WHERE id_hash = ?",
                    (now, sid))
                conn.commit()
            return ({"id": row["id"], "username": row["username"]}, row["csrf"])
        finally:
            conn.close()


def session_revoke(raw):
    if not raw:
        return
    sid = hashlib.sha256(raw.encode()).hexdigest()
    with DB_LOCK:
        conn = db()
        try:
            conn.execute("DELETE FROM admin_sessions WHERE id_hash = ?", (sid,))
            conn.commit()
        finally:
            conn.close()


# ---- status transitions ---------------------------------------------------

def change_status(conn, team_id, new_status, note, admin, override=False):
    """Apply a status transition. Raises ValidationError when the slot
    limit would be exceeded and no override is given."""
    row = conn.execute("SELECT * FROM registrations WHERE team_id = ?",
                       (team_id,)).fetchone()
    if not row:
        raise ValidationError("Registration not found.", "teamId")
    if new_status not in STATUSES:
        raise ValidationError("Unknown status.", "status")
    if new_status == "approved":
        limit = int(get_setting(conn, "slot_limit", str(SLOT_LIMIT)))
        approved = conn.execute(
            "SELECT COUNT(*) AS c FROM registrations WHERE status = 'approved'"
        ).fetchone()["c"]
        if row["status"] != "approved" and approved >= limit and not override:
            raise ValidationError(
                "Slot limit reached (%d approved of %d). Override or waitlist."
                % (approved, limit), "slotLimit")
    old = row["status"] or "pending"
    # leaving Approved clears the group slot
    group_cleared = None
    if old == "approved" and new_status != "approved" and row["group_id"]:
        group_cleared = row["group_id"]
        conn.execute("UPDATE registrations SET group_id = NULL WHERE team_id = ?",
                     (team_id,))
    conn.execute(
        "UPDATE registrations SET status = ?, status_note = ?, decided_at = ?, "
        "decided_by = ?, updated_at = ? WHERE team_id = ?",
        (new_status, (note or "").strip(), now_iso(), admin, now_iso(), team_id))
    audit(conn, admin, team_id, "status", "status", old, new_status)
    if (note or "").strip() and "reason" not in (note or ""):
        pass  # note stored in status_note; value kept only in the row itself
    return group_cleared


# ---- notifications (silent when unconfigured) -----------------------------

# ---- notifications (durable SQLite queue, optional SMTP) -------------------

NOTIFY_TEMPLATES = {
    "status": ("[BGMI Cup] {reg_code} is now {label}",
               "Hey {cap_ign},\n\nYour team {team_name} ({reg_code}) status: "
               "{label}.\n{status_note}\n\nCheck anytime: /status with your "
               "ID {reg_code}.\n\nBGMI Cup Noida 2026"),
    "group": ("[BGMI Cup] {team_name} drew {group}",
              "Hey {cap_ign},\n\nYour team {team_name} ({reg_code}) has been "
              "placed in {group}.\n\nCheck /status for lobby instructions "
              "and your match schedule.\n\nBGMI Cup Noida 2026"),
    "schedule": ("[BGMI Cup] schedule update for {team_name}",
                 "Hey {cap_ign},\n\nSchedule update for {team_name} "
                 "({reg_code}):\n{schedule_note}\n\nCheck /status for the "
                 "latest.\n\nBGMI Cup Noida 2026"),
}


def enqueue_notification(conn, team_id, kind):
    """Queue an e-mail job inside the caller's transaction — the job commits
    atomically with the change it describes, so a committed status change
    can never be silently lost.  The partial unique index on (team_id, kind)
    while status='pending' makes duplicate sends impossible."""
    conn.execute(
        "INSERT OR IGNORE INTO notification_queue "
        "(team_id, kind, status, created_at) VALUES (?,?, 'pending', ?)",
        (team_id, kind, now_iso()))


def _render_notification(conn, job):
    """(recipient, subject, body) for a queued job, or None when the team
    is gone or has no address.  Content is rendered at send time from the
    current row — the queue itself never stores personal data."""
    row = conn.execute("SELECT * FROM registrations WHERE team_id = ?",
                       (job["team_id"],)).fetchone()
    if not row or not row["cap_email"]:
        return None
    group = ""
    if row["group_id"]:
        g = conn.execute("SELECT name FROM groups WHERE id = ?",
                         (row["group_id"],)).fetchone()
        group = g["name"] if g else ""
    label = STATUS_LABELS.get(row["status"], row["status"])
    subject_t, body_t = NOTIFY_TEMPLATES.get(
        job["kind"], NOTIFY_TEMPLATES["status"])
    values = {"reg_code": row["reg_code"] or row["team_id"],
              "team_name": row["team_name"], "cap_ign": row["cap_ign"],
              "label": label, "status_note": row["status_note"] or "",
              "group": group, "schedule_note": row["schedule_note"] or ""}
    return row["cap_email"], subject_t.format(**values), body_t.format(**values)


def smtp_configured():
    return bool(SMTP_HOST and SMTP_USER and SMTP_PASS)


def notify_counts(conn):
    return {s: conn.execute(
        "SELECT COUNT(*) AS c FROM notification_queue WHERE status = ?",
        (s,)).fetchone()["c"]
        for s in ("pending", "sent", "skipped", "failed")}


def process_notification_queue(limit=20):
    """One worker pass; returns how many jobs it handled.

    Unconfigured SMTP marks jobs 'skipped' — the app never withholds a
    registration because mail is off.  Real send failures are recorded with
    a truncated error and exponential next_at backoff; after
    NOTIFY_MAX_ATTEMPTS the job parks as 'failed' for an admin retry."""
    now = now_iso()
    if not smtp_configured():
        with DB_LOCK:
            conn = db()
            try:
                n = conn.execute(
                    "UPDATE notification_queue SET status = 'skipped', "
                    "sent_at = ? WHERE status = 'pending' AND attempts = 0",
                    (now,)).rowcount
                conn.commit()
            finally:
                conn.close()
        if n:
            print("[notify] SMTP not configured - %d job(s) marked skipped" % n)
        return n

    with DB_LOCK:
        conn = db()
        try:
            jobs = [dict(j) for j in conn.execute(
                "SELECT * FROM notification_queue WHERE status = 'pending' "
                "AND (next_at IS NULL OR next_at <= ?) "
                "ORDER BY created_at LIMIT ?", (now, limit))]
            renders = {j["id"]: _render_notification(conn, j) for j in jobs}
        finally:
            conn.close()

    import smtplib
    from email.mime.text import MIMEText
    handled = 0
    for job in jobs:
        handled += 1
        rendered = renders.get(job["id"])
        if rendered is None:
            with DB_LOCK:                     # team removed / no address
                conn = db()
                try:
                    conn.execute(
                        "UPDATE notification_queue SET status = 'skipped', "
                        "sent_at = ? WHERE id = ?", (now_iso(), job["id"]))
                    conn.commit()
                finally:
                    conn.close()
            continue
        recipient, subject, body = rendered
        error = None
        try:
            msg = MIMEText(body)
            msg["Subject"] = subject
            msg["From"] = SMTP_FROM
            msg["To"] = recipient
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
                s.starttls()
                s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        except Exception as e:
            error = str(e)[:200]
        with DB_LOCK:
            conn = db()
            try:
                if error is None:
                    conn.execute(
                        "UPDATE notification_queue SET status = 'sent', "
                        "attempts = attempts + 1, sent_at = ?, last_error = '' "
                        "WHERE id = ?", (now_iso(), job["id"]))
                    print("[notify] mail sent for %s (%s)"
                          % (job["team_id"], job["kind"]))
                else:
                    attempts = job["attempts"] + 1
                    if attempts >= NOTIFY_MAX_ATTEMPTS:
                        status, next_at = "failed", None
                    else:
                        status = "pending"
                        next_at = datetime.fromtimestamp(
                            time.time() + 60 * (2 ** (attempts - 1)),
                            timezone.utc).isoformat()
                    conn.execute(
                        "UPDATE notification_queue SET status = ?, "
                        "attempts = ?, next_at = ?, last_error = ? WHERE id = ?",
                        (status, attempts, next_at, error, job["id"]))
                    print("[notify] mail failed for %s: %s" % (job["team_id"], error))
                conn.commit()
            finally:
                conn.close()
    return handled


def notification_worker():
    """Background thread: drains the queue every NOTIFY_POLL seconds."""
    while True:
        try:
            process_notification_queue()
        except Exception as e:                 # never let the worker die
            print("[notify] worker error: %s" % e)
        time.sleep(NOTIFY_POLL)


def generate_team_id(conn):
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(50):
        tid = "CSM-BG-" + "".join(secrets.choice(chars) for _ in range(4))
        if not conn.execute(
                "SELECT 1 FROM registrations WHERE team_id = ?", (tid,)).fetchone():
            return tid
    raise RuntimeError("Could not allocate a unique team ID")


def insert_registration(data, members, ip, logo_path):
    """Atomic insert; raises ValidationError on conflicts.

    Runs under BEGIN IMMEDIATE: team_id and reg_code are allocated inside
    the write transaction, so two concurrent submissions can never claim
    the same identifier (single process via DB_LOCK, cross-process via
    SQLite's reserved lock)."""
    with DB_LOCK:
        conn = db()
        try:
            try:
                conn.execute("BEGIN IMMEDIATE")
                code = next_reg_code(conn)
                tid = generate_team_id(conn)
                data["teamId"] = tid
                conn.execute(
                    """INSERT INTO registrations
                       (team_id, team_name, team_tag, guild_name, logo_path,
                        cap_ign, cap_uid, cap_email, cap_phone, cap_discord,
                        ip, created_at, reg_code, status, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (tid, data["teamName"], data["teamTag"],
                     data["guildName"], logo_path, data["capIgn"], data["capUid"],
                     data["capEmail"], data["capPhone"], data["capDiscord"],
                     ip, datetime.now(timezone.utc).isoformat(),
                     code, "pending", now_iso()))
                data["regCode"] = code
                conn.executemany(
                    """INSERT INTO roster_members (team_id, slot, role, ign, uid)
                       VALUES (?,?,?,?,?)""",
                    [(data["teamId"], m["slot"], m["role"], m["ign"], m["uid"])
                     for m in members])
                conn.commit()
            except sqlite3.IntegrityError as e:
                conn.rollback()
                msg = str(e)
                if "team_tag" in msg:
                    raise ValidationError(
                        "That team tag is already registered. Pick another one.",
                        "teamTag")
                if "team_id" in msg or "reg_code" in msg:
                    # identifier collision from a parallel writer — the
                    # transaction never partially applied
                    raise ValidationError(
                        "A registration just went through — hit Register "
                        "again to get your own ID.", "teamName")
                if "uid" in msg.lower():
                    # find which uid in THIS submission already exists
                    for m in members:
                        row = conn.execute(
                            "SELECT team_id FROM roster_members WHERE uid = ?",
                            (m["uid"],)).fetchone()
                        if row:
                            raise ValidationError(
                                "Character ID %s is already on squad %s. One account per player."
                                % (m["uid"], row["team_id"]), "roster")
                    raise ValidationError(
                        "One of those Character IDs is already registered.",
                        "roster")
                raise
            return data["teamId"]
        finally:
            conn.close()


def count_registrations():
    with DB_LOCK:
        conn = db()
        try:
            return conn.execute(
                "SELECT COUNT(*) AS c FROM registrations").fetchone()["c"]
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# CSRF + rate limiting
# ---------------------------------------------------------------------------

csrf_tokens = {}       # token -> (ip, expiry)
csrf_lock = threading.Lock()
rate_hits = {}         # ip -> [timestamps]
rate_lock = threading.Lock()


def issue_csrf(ip):
    token = secrets.token_urlsafe(32)
    now = time.time()
    with csrf_lock:
        expired = [t for t, (_, exp) in csrf_tokens.items() if exp < now]
        for t in expired:
            del csrf_tokens[t]
        csrf_tokens[token] = (ip, now + CSRF_TTL)
    return token


def check_csrf(token, ip):
    if not token:
        return False
    with csrf_lock:
        entry = csrf_tokens.get(token)
        if not entry:
            return False
        bound_ip, exp = entry
        if exp < time.time() or bound_ip != ip:
            del csrf_tokens[token]
            return False
        return True


def consume_csrf(token):
    with csrf_lock:
        csrf_tokens.pop(token, None)


def rate_ok(ip, limit=None, window=None, bucket="register"):
    """Sliding-window limiter keyed by (bucket, ip)."""
    limit = RATE_LIMIT if limit is None else limit
    window = RATE_WINDOW if window is None else window
    key = bucket + "|" + ip
    now = time.time()
    with rate_lock:
        hits = [t for t in rate_hits.get(key, []) if t > now - window]
        if len(hits) >= limit:
            rate_hits[key] = hits
            return False
        hits.append(now)
        rate_hits[key] = hits
        return True


def rate_blocked(ip, limit, window, bucket):
    """Read-only check: is this key currently over its limit?"""
    key = bucket + "|" + ip
    now = time.time()
    with rate_lock:
        hits = [t for t in rate_hits.get(key, []) if t > now - window]
        rate_hits[key] = hits
        return len(hits) >= limit


def rate_note(ip, bucket):
    """Record one attempt against a key (used for failed logins only)."""
    key = bucket + "|" + ip
    with rate_lock:
        rate_hits.setdefault(key, []).append(time.time())


def rate_clear(ip, bucket):
    """Forget a key's attempts (a successful login clears the typos)."""
    key = bucket + "|" + ip
    with rate_lock:
        rate_hits.pop(key, None)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

def find_conflicts(rows):
    """team_id -> {flag: details} when a UID / phone / name repeats across
    registrations."""
    by_uid, by_phone, by_name = {}, {}, {}
    for d in rows:
        for m in d.get("roster", []):
            by_uid.setdefault(str(m.get("uid") or ""), set()).add(d["team_id"])
        by_phone.setdefault(
            re.sub(r"\D", "", str(d.get("cap_phone") or "")),
            set()).add(d["team_id"])
        by_name.setdefault(
            str(d.get("team_name") or "").strip().lower(),
            set()).add(d["team_id"])
    out = {}
    for d in rows:
        c = {}
        uids = {str(m.get("uid") or "") for m in d.get("roster", [])}
        dupe_uids = sorted(u for u in uids if u and len(by_uid.get(u, ())) > 1)
        if dupe_uids:
            c["uids"] = dupe_uids
            c["uidTeams"] = sorted({t for u in dupe_uids
                                    for t in by_uid[u] if t != d["team_id"]})
        ph = re.sub(r"\D", "", str(d.get("cap_phone") or ""))
        if ph and len(by_phone.get(ph, ())) > 1:
            c["phone"] = True
            c["phoneTeams"] = sorted(t for t in by_phone[ph]
                                     if t != d["team_id"])
        nm = str(d.get("team_name") or "").strip().lower()
        if nm and len(by_name.get(nm, ())) > 1:
            c["name"] = True
            c["nameTeams"] = sorted(t for t in by_name[nm]
                                    if t != d["team_id"])
        if c:
            out[d["team_id"]] = c
    return out


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """Suppress harmless tracebacks when clients (browsers, curl)
    close keep-alive connections before reading the full response."""

    def handle_error(self, request, client_address):
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError,
                            TimeoutError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = "BGMIReg/1.0"
    protocol_version = "HTTP/1.1"
    _head_only = False

    # ---- helpers ----------------------------------------------------------

    def send_json(self, obj, status=200, headers=None):
        self.drain_body()
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not self._head_only:
            self.wfile.write(body)

    def end_headers(self):
        # security headers on every response (JSON, CSV, pages, 404s):
        # uploaded images can never be sniffed into HTML/script
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        # Strict CSP — every script is external ('self'), no inline handlers.
        # inline style= attributes remain (style-src unsafe-inline only
        # affects CSS, not script); Google Fonts for the theme faces.
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src https://fonts.gstatic.com; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "frame-src 'self'; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "form-action 'self'")
        # admin pages must never be framed (clickjacking); overlay shells
        # stay frameable so the producer preview iframe works.
        path = getattr(self, "path", "") or ""
        self.send_header("X-Frame-Options",
                         "DENY" if path.startswith("/admin") else "SAMEORIGIN")
        super().end_headers()

    def send_csv(self, filename, rows):
        import csv
        import io
        self.drain_body()
        buf = io.StringIO()
        w = csv.writer(buf)
        for r in rows:
            w.writerow(r)
        body = buf.getvalue().encode("utf-8-sig")   # Excel-friendly BOM
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition",
                         'attachment; filename="%s"' % filename)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not self._head_only:
            self.wfile.write(body)

    # ---- request helpers ---------------------------------------------------

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        self._body_read = length
        return self.rfile.read(length)

    def drain_body(self):
        """Consume an unread request body before responding.

        On keep-alive connections an unread POST body stays in the socket
        buffer and prefixes the next request line (e.g. '{}GET /admin'),
        which the stdlib parser rejects with 501. Handlers may bail out
        early (401/403/404) before reading, so every response drains here."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return
        left = length - getattr(self, "_body_read", 0)
        if left > 0:
            if left > MAX_BODY:
                # too big to swallow - end the connection instead
                self.close_connection = True
                return
            try:
                self.rfile.read(left)
            except Exception:
                self.close_connection = True
        self._body_read = length

    def json_body(self):
        raw = self.read_body()
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def form_body(self):
        raw = self.read_body()
        if raw is None:
            return None
        try:
            return {k: v[0] for k, v in
                    parse_qs(raw.decode("utf-8")).items()}
        except Exception:
            return None

    def session_raw(self):
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "bgmi_admin":
                return v
        return None

    def admin_session(self):
        """Return (admin_row, csrf) when a valid session cookie is present."""
        return session_lookup(self.session_raw())

    def _same_origin(self):
        """True when Origin/Referer (when present) matches this host.

        CSRF tokens remain the primary defence; this is defence in depth
        against token leakage.  Non-browser clients that send neither
        header are allowed (the token still gates every write)."""
        host = (self.headers.get("Host") or "").strip().lower()
        for header in ("Origin", "Referer"):
            value = (self.headers.get(header) or "").strip()
            if not value:
                continue
            try:
                netloc = urlparse(value).netloc.lower()
            except ValueError:
                return False
            if not netloc or netloc != host:
                return False
            return True       # first present header decides
        return True

    def require_admin(self, write=False):
        """Gate an admin API call: session required, CSRF for writes.
        Returns (admin, csrf) or None after sending the error response."""
        sess = self.admin_session()
        if not sess:
            self.send_json({"ok": False, "error": "Not signed in."}, 401)
            return None
        admin, csrf = sess
        if write:
            if not self._same_origin():
                self.send_json(
                    {"ok": False, "error": "Blocked cross-site request."}, 403)
                return None
            if hmac.compare_digest(
                    self.headers.get("X-Admin-CSRF", ""), csrf) is False:
                self.send_json({"ok": False, "error": "CSRF failed. Reload."}, 403)
                return None
        return sess

    def set_session_cookie(self, raw):
        secure = (self.headers.get("X-Forwarded-Proto", "") == "https" or
                  self.headers.get("X-Forwarded-Proto", "").lower() == "https")
        return {
            "Set-Cookie": "bgmi_admin=%s; Path=/; HttpOnly; SameSite=Lax; "
                          "Max-Age=%d%s" % (raw, SESSION_TTL,
                                            "; Secure" if secure else "")}

    def clear_session_cookie(self):
        return {"Set-Cookie": "bgmi_admin=; Path=/; HttpOnly; SameSite=Lax; "
                              "Max-Age=0"}

    def client_ip(self):
        peer = self.client_address[0]
        # Behind the local cloudflared tunnel every request arrives from
        # loopback; trust the visitor IP Cloudflare forwards so the per-IP
        # rate limit stays per-visitor instead of one shared budget.
        if peer in ("127.0.0.1", "::1"):
            fwd = self.headers.get("Cf-Connecting-Ip")
            if fwd:
                return fwd.strip()
        return peer

    def log_message(self, fmt, *args):
        print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    # ---- static files -----------------------------------------------------

    def send_themed_404(self):
        """Serve 404.html (themed page) with a real 404 status."""
        page = os.path.join(PUBLIC_DIR, "404.html")
        if not os.path.isfile(page):
            return self.send_error(404)
        with open(page, "rb") as f:
            body = f.read()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not self._head_only:
            self.wfile.write(body)

    def redirect(self, location, status=302):
        self.drain_body()
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- server-sent events ------------------------------------------------

    SSE_KEEPALIVE = 15          # seconds between ": ping" comments

    def sse_stream(self, topic):
        """Stream broadcast.HUB events on `topic` as SSE.

        One connection per page; the client refetches its state endpoint on
        every event (the event itself is only a change signal). Cleaned up on
        any write failure so closed tabs never leak threads."""
        self.close_connection = True
        _, token, q = broadcast.HUB.subscribe(topic)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            if self._head_only:
                return
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    payload = q.get(timeout=self.SSE_KEEPALIVE)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                data = json.dumps(payload).encode("utf-8")
                self.wfile.write(b"data: " + data + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        finally:
            broadcast.HUB.unsubscribe(topic, token)

    # ---- overlay data (token gated) ----------------------------------------

    def overlay_api(self, path, qs):
        name = path.split("/api/overlay/", 1)[1]
        kind, _, name = name.partition("/")
        name = name.rstrip("/").lower()
        token = (qs.get("token", [""])[0] or "")
        state = None
        with DB_LOCK:
            conn = db()
            try:
                allowed = broadcast.check_overlay_token(conn, token)
                if allowed and kind == "state":
                    state = broadcast.overlay_state(conn, name)
            finally:
                conn.close()
        if not allowed:
            return self.send_json(
                {"ok": False, "error": "Invalid overlay token."}, 403)
        if name not in broadcast.OVERLAY_NAMES:
            return self.send_json({"ok": False, "error": "Unknown overlay."},
                                  404)
        if kind == "state":
            if state is None:
                return self.send_json({"ok": False, "error": "Unknown overlay."},
                                      404)
            return self.send_json(state)
        if kind == "stream":
            return self.sse_stream("overlay")
        return self.send_json({"ok": False, "error": "Not found."}, 404)

    def serve_static(self, rel):
        rel = unquote(rel).lstrip("/")
        if rel in ("", "/"):
            rel = INDEX_PAGE
        # never serve server internals
        blocked_ext = (".py", ".db", ".db-wal", ".db-shm", ".pyc")
        if any(rel.endswith(b) for b in blocked_ext) or rel.startswith("."):
            return self.send_themed_404()
        # legacy URLs from before the public/ restructure: the old /public/team/
        # photo dir now lives at /images/team/ (kept working for old links)
        low_rel = rel.replace("\\", "/")
        if low_rel == "public/team" or low_rel.startswith("public/team/"):
            tail = low_rel[len("public/team/"):].lstrip("/")
            self.send_response(301)
            self.send_header("Location", "/images/team/" + tail)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # team logos live in the configured upload dir (BGMI_UPLOADS may put
        # it anywhere — e.g. outside the web root in tests); everything else
        # is served from the public/ web layer
        low = rel.lower()
        if low.startswith("uploads/") or low.startswith("uploads\\"):
            base = UPLOAD_DIR
            full = os.path.normpath(
                os.path.join(UPLOAD_DIR, rel.split("/", 1)[-1].split("\\", 1)[-1]))
        else:
            base = PUBLIC_DIR
            full = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        if full != base and not full.startswith(base + os.sep):
            return self.send_error(404)          # traversal guard
        if not os.path.isfile(full):
            # friendly URLs: /about -> about.html (extensionless paths only)
            if not os.path.splitext(full)[1] and os.path.isfile(full + ".html"):
                full += ".html"
            else:
                return self.send_themed_404()
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(full, "rb") as f:
                body = f.read()
        except PermissionError:
            # Windows antivirus/indexer can briefly lock a fresh file;
            # retry once, then fail cleanly instead of aborting the socket.
            time.sleep(0.3)
            try:
                with open(full, "rb") as f:
                    body = f.read()
            except OSError:
                return self.send_themed_404()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if ext in (".html",):
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not self._head_only:
            self.wfile.write(body)

    # ---- GET / HEAD -------------------------------------------------------

    def do_HEAD(self):
        """HEAD returns the same headers as GET with no body."""
        self._head_only = True
        try:
            self.do_GET()
        finally:
            self._head_only = False

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/health":
            return self.send_json({"ok": True, "count": count_registrations()})

        if path == "/api/csrf":
            return self.send_json({"token": issue_csrf(self.client_ip())})

        # ---- live broadcast (public, PII-free) ----
        if path == "/api/live/state":
            with DB_LOCK:
                conn = db()
                try:
                    payload = broadcast.live_state(conn)
                finally:
                    conn.close()
            return self.send_json(payload)

        if path == "/api/live/stream":
            return self.sse_stream("live")

        # ---- overlays (token gated; no session, no PII) ----
        if path.startswith("/api/overlay/state/") or \
                path.startswith("/api/overlay/stream/"):
            return self.overlay_api(path, qs)

        # ---- public integration feed (serves overlays/match tools later) ----
        if path == "/api/public/approved":
            with DB_LOCK:
                conn = db()
                try:
                    if get_setting(conn, "public_teams", "0") != "1":
                        return self.send_json(
                            {"ok": False, "error": "Not found."}, 404)
                    rows = [dict(r) for r in conn.execute(
                        "SELECT r.team_name, r.team_tag, r.logo_path, "
                        "g.name AS group_name FROM registrations r "
                        "LEFT JOIN groups g ON g.id = r.group_id "
                        "WHERE r.status = 'approved' "
                        "ORDER BY g.name, r.team_name")]
                finally:
                    conn.close()
            return self.send_json({"ok": True, "teams": rows})

        if path == "/api/public/schedule":
            ip = self.client_ip()
            if not rate_ok(ip, 30, 300, "sched"):
                return self.send_json(
                    {"ok": False, "error": "Too many requests."}, 429)
            with DB_LOCK:
                conn = db()
                try:
                    if get_setting(conn, "public_teams", "0") != "1":
                        return self.send_json(
                            {"ok": False, "error": "Not found."}, 404)
                    payload = {
                        "ok": True,
                        "schedule": get_setting(conn, "schedule_note", ""),
                        "timezone": get_setting(conn, "timezone", "Asia/Kolkata"),
                        "updatedAt": get_setting(conn, "schedule_updated", ""),
                    }
                finally:
                    conn.close()
            return self.send_json(payload)

        # ---- admin APIs (session gated on the server) ----
        if path.startswith("/api/admin/"):
            return self.admin_get(path, qs)

        # ---- pages, gated server-side ----
        if path in ("/admin", "/admin/", "/admin.html", "/admin-login.html"):
            if self.admin_session():
                return self.serve_static("/admin.html")
            return self.serve_static("/admin-login.html")

        # broadcast admin pages — same session gate as the Control Room
        if path.startswith("/admin/"):
            sub = path[len("/admin/"):].rstrip("/").lower()
            page = {"matches": "admin-matches.html",
                    "control": "admin-control.html",
                    "overlays": "admin-overlays.html",
                    "caster": "admin-caster.html"}.get(sub)
            if page:
                if self.admin_session():
                    return self.serve_static("/" + page)
                return self.serve_static("/admin-login.html")

        if path in ("/status", "/status.html"):
            return self.serve_static("/status.html")

        if path in ("/teams", "/teams.html"):
            return self.serve_static("/teams.html")

        # legacy URLs from the old broadcast app keep working
        if path in ("/standings", "/standings.html"):
            return self.redirect("/results")
        if path in ("/operator", "/operator.html"):
            return self.redirect("/admin/control")
        if path in ("/login", "/login.html"):
            return self.redirect("/admin")

        # OBS overlay pages: /overlay/<name> serves the single overlay shell
        if path.startswith("/overlay/") or path == "/overlay":
            name = path[len("/overlay/"):].rstrip("/").lower()
            if path == "/overlay" or name not in broadcast.OVERLAY_NAMES:
                # bare /overlay or an unknown name: producer page explains them
                return self.redirect("/admin/overlays")
            return self.serve_static("/overlay.html")

        return self.serve_static(path)

    # ---- admin GET APIs ----------------------------------------------------

    def admin_get(self, path, qs):
        admin = self.require_admin()
        if not admin:
            return None
        rest = path[len("/api/admin/"):]

        if rest == "me":
            return self.send_json({"ok": True,
                                   "username": admin[0]["username"],
                                   "csrf": admin[1]})
        if rest == "registrations":
            return self.admin_queue(qs)
        if rest.startswith("registrations/"):
            return self.admin_detail(rest.split("/", 1)[1])
        if rest == "audit":
            return self.admin_audit(qs)
        if rest == "groups":
            return self.admin_groups()
        if rest == "notifications":
            return self.admin_notifications()

        # ---- broadcast admin reads ----
        if rest == "matches":
            with DB_LOCK:
                conn = db()
                try:
                    matches = broadcast.list_matches(conn)
                    groups = [dict(r) for r in conn.execute(
                        "SELECT id, name FROM groups ORDER BY name")]
                finally:
                    conn.close()
            return self.send_json({"ok": True, "matches": matches,
                                   "groups": groups})
        m = re.match(r"^matches/(\d+)$", rest)
        if m:
            with DB_LOCK:
                conn = db()
                try:
                    state = broadcast.match_state(conn, int(m.group(1)))
                    eligible = broadcast.eligible_teams(
                        conn, state["match"]["group_name"]) if state else []
                finally:
                    conn.close()
            if not state:
                return self.send_json({"ok": False, "error": "Not found."},
                                      404)
            return self.send_json({"ok": True, "state": state,
                                   "eligible": eligible})
        if rest == "overlay-settings":
            with DB_LOCK:
                conn = db()
                try:
                    pairs = {r["key"]: r["value"] for r in conn.execute(
                        "SELECT key, value FROM overlay_settings")}
                finally:
                    conn.close()
            try:
                pushed = json.loads(pairs.get("pushed_card") or "null")
            except ValueError:
                pushed = None
            try:
                disabled = json.loads(pairs.get("disabled") or "[]")
            except ValueError:
                disabled = []
            return self.send_json({
                "ok": True,
                "token": pairs.get("token", ""),
                "themeColor": pairs.get("theme_color", "#b6ff3e"),
                "logoPath": pairs.get("logo_path", ""),
                "sponsorText": pairs.get("sponsor_text", ""),
                "introTeam": pairs.get("intro_team", ""),
                "pushedCard": pushed,
                "disabled": disabled,
                "overlays": list(broadcast.OVERLAY_NAMES)})
        if rest == "scoring-rules":
            with DB_LOCK:
                conn = db()
                try:
                    rules = broadcast.load_rules(conn)
                finally:
                    conn.close()
            return self.send_json({"ok": True, "rules": rules})
        if rest == "stream":
            return self.sse_stream("admin")
        if rest.startswith("matches/") and rest.endswith("/stream"):
            return self.sse_stream("admin")
        if rest == "settings":
            with DB_LOCK:
                conn = db()
                try:
                    return self.send_json({
                        "ok": True,
                        "slot_limit": int(get_setting(
                            conn, "slot_limit", str(SLOT_LIMIT))),
                        "public_teams": get_setting(
                            conn, "public_teams", "0") == "1",
                        "groups_locked": get_setting(
                            conn, "groups_locked", "0") == "1",
                        "timezone": get_setting(
                            conn, "timezone", "Asia/Kolkata"),
                        "schedule_note": get_setting(conn, "schedule_note", ""),
                        "schedule_updated": get_setting(
                            conn, "schedule_updated", ""),
                        "smtp": smtp_configured(),
                        "notify": notify_counts(conn)})
                finally:
                    conn.close()
        who = admin[0]["username"]
        if rest == "export/approved.csv":
            return self.export_approved_csv(who)
        if rest == "export/groups.csv":
            return self.export_groups_csv(who)
        return self.send_json({"ok": False, "error": "Not found."}, 404)

    def admin_notifications(self):
        """Queue health for the dashboard: counts plus failure details
        (team id / reg code only — never the stored address)."""
        with DB_LOCK:
            conn = db()
            try:
                counts = notify_counts(conn)
                failures = [dict(r) for r in conn.execute(
                    "SELECT q.id, q.team_id, q.kind, q.attempts, q.last_error, "
                    "q.created_at, r.reg_code, r.team_name "
                    "FROM notification_queue q "
                    "LEFT JOIN registrations r ON r.team_id = q.team_id "
                    "WHERE q.status = 'failed' "
                    "ORDER BY q.created_at DESC LIMIT 100")]
            finally:
                conn.close()
        return self.send_json({"ok": True, "counts": counts,
                               "failures": failures})

    def admin_queue(self, qs):
        q = (qs.get("q", [""])[0] or "").strip().lower()
        status = qs.get("status", ["all"])[0] or "all"
        sort = qs.get("sort", ["date"])[0] or "date"
        with DB_LOCK:
            conn = db()
            try:
                rows = [dict(r) for r in conn.execute(
                    "SELECT * FROM registrations ORDER BY created_at DESC")]
                for d in rows:
                    d["roster"] = [dict(m) for m in conn.execute(
                        "SELECT slot, role, ign, uid FROM roster_members "
                        "WHERE team_id = ? ORDER BY slot", (d["team_id"],))]
                    g = (conn.execute("SELECT name FROM groups WHERE id = ?",
                                      (d["group_id"],)).fetchone()
                         if d["group_id"] else None)
                    d["group_name"] = g["name"] if g else None
                    d["open_requests"] = conn.execute(
                        "SELECT COUNT(*) AS c FROM change_requests "
                        "WHERE team_id = ? AND seen = 0",
                        (d["team_id"],)).fetchone()["c"]
                counts = {s: 0 for s in STATUSES}
                for d in rows:
                    key = d["status"] or "pending"
                    counts[key] = counts.get(key, 0) + 1
                limit = int(get_setting(conn, "slot_limit", str(SLOT_LIMIT)))
                notify_counts_values = notify_counts(conn)
            finally:
                conn.close()
        conflicts = find_conflicts(rows)
        if q:
            def hay(d):
                parts = [d["team_id"], d["team_name"], d["team_tag"],
                         d["guild_name"], d["cap_ign"], d["cap_email"],
                         d["cap_phone"], d["cap_discord"]]
                for m in d["roster"]:
                    parts += [m["ign"], m["uid"]]
                return " ".join(str(p or "") for p in parts).lower()
            rows = [d for d in rows if q in hay(d)]
        if status in STATUSES:
            rows = [d for d in rows if (d["status"] or "pending") == status]
        if sort == "name":
            rows.sort(key=lambda d: d["team_name"].lower())
        elif sort == "status":
            rows.sort(key=lambda d: STATUSES.index(d["status"] or "pending")
                      if (d["status"] or "pending") in STATUSES else 9)
        return self.send_json({"ok": True, "registrations": rows,
                               "counts": counts, "slot_limit": limit,
                               "approved": counts.get("approved", 0),
                               "remaining": max(0, limit - counts.get("approved", 0)),
                               "notify": notify_counts_values,
                               "conflicts": conflicts})

    def admin_detail(self, tid):
        with DB_LOCK:
            conn = db()
            try:
                row = conn.execute("SELECT * FROM registrations WHERE team_id = ?",
                                   (tid,)).fetchone()
                if not row:
                    return self.send_json({"ok": False, "error": "Not found."}, 404)
                d = dict(row)
                d["roster"] = [dict(m) for m in conn.execute(
                    "SELECT slot, role, ign, uid FROM roster_members "
                    "WHERE team_id = ? ORDER BY slot", (tid,))]
                d["requests"] = [dict(r) for r in conn.execute(
                    "SELECT id, message, created_at, seen FROM change_requests "
                    "WHERE team_id = ? ORDER BY created_at DESC", (tid,))]
            finally:
                conn.close()
        all_rows = [d]   # conflicts need the peer list; cheap enough via queue scan
        with DB_LOCK:
            conn = db()
            try:
                peers = [dict(r) for r in conn.execute(
                    "SELECT * FROM registrations WHERE team_id != ?", (tid,))]
                for p in peers:
                    p["roster"] = [dict(m) for m in conn.execute(
                        "SELECT slot, role, ign, uid FROM roster_members "
                        "WHERE team_id = ? ORDER BY slot", (p["team_id"],))]
            finally:
                conn.close()
        conflicts = find_conflicts(all_rows + peers).get(tid, {})
        d["conflicts"] = conflicts
        return self.send_json({"ok": True, "registration": d})

    def admin_audit(self, qs):
        limit = min(int(qs.get("limit", ["100"])[0] or 100), 500)
        tid = qs.get("teamId", [""])[0]
        with DB_LOCK:
            conn = db()
            try:
                if tid:
                    rows = [dict(r) for r in conn.execute(
                        "SELECT * FROM audit_log WHERE team_id = ? "
                        "ORDER BY at DESC LIMIT ?", (tid, limit))]
                else:
                    rows = [dict(r) for r in conn.execute(
                        "SELECT * FROM audit_log ORDER BY at DESC LIMIT ?",
                        (limit,))]
            finally:
                conn.close()
        return self.send_json({"ok": True, "audit": rows})

    def admin_groups(self):
        with DB_LOCK:
            conn = db()
            try:
                groups = [dict(g) for g in conn.execute(
                    "SELECT * FROM groups ORDER BY name")]
                for g in groups:
                    g["teams"] = [dict(r) for r in conn.execute(
                        "SELECT team_id, team_name, team_tag, logo_path, "
                        "reg_code FROM registrations WHERE group_id = ? "
                        "ORDER BY team_name", (g["id"],))]
                    g["count"] = len(g["teams"])
                unassigned = [dict(r) for r in conn.execute(
                    "SELECT team_id, team_name, team_tag, reg_code FROM "
                    "registrations WHERE status = 'approved' AND "
                    "group_id IS NULL ORDER BY team_name")]
                locked = get_setting(conn, "groups_locked", "0") == "1"
                limit = int(get_setting(conn, "slot_limit", str(SLOT_LIMIT)))
                approved = conn.execute(
                    "SELECT COUNT(*) AS c FROM registrations "
                    "WHERE status = 'approved'").fetchone()["c"]
            finally:
                conn.close()
        return self.send_json({"ok": True, "groups": groups,
                               "unassigned": unassigned, "locked": locked,
                               "slot_limit": limit, "approved": approved})

    # ---- CSV exports -------------------------------------------------------

    def export_approved_csv(self, who=None):
        with DB_LOCK:
            conn = db()
            try:
                rows = conn.execute(
                    "SELECT * FROM registrations WHERE status = 'approved' "
                    "ORDER BY team_name").fetchall()
                head = ["reg_code", "team_id", "team_name", "team_tag", "guild",
                        "group", "captain_ign", "captain_uid", "captain_email",
                        "captain_phone", "captain_discord"]
                head += ["p%d" % i for i in range(1, 5)] + ["subs"]
                out = [head]
                for r in rows:
                    members = conn.execute(
                        "SELECT slot, role, ign, uid FROM roster_members "
                        "WHERE team_id = ? ORDER BY slot", (r["team_id"],)).fetchall()
                    starters = ["%s (%s)" % (m["ign"], m["uid"])
                                for m in members if m["role"] != "Substitute"]
                    subs = ["%s (%s)" % (m["ign"], m["uid"])
                            for m in members if m["role"] == "Substitute"]
                    g = (conn.execute("SELECT name FROM groups WHERE id = ?",
                                      (r["group_id"],)).fetchone()
                         if r["group_id"] else None)
                    out.append([r["reg_code"], r["team_id"], r["team_name"],
                                r["team_tag"], r["guild_name"],
                                g["name"] if g else "", r["cap_ign"],
                                r["cap_uid"], r["cap_email"], r["cap_phone"],
                                r["cap_discord"] or ""] +
                               (starters + ["", "", "", ""])[:4] +
                               ["; ".join(subs)])
                if who:                       # exports are logged (PII-free)
                    audit(conn, who, None, "export", "approved_csv",
                          None, "%d rows" % (len(out) - 1))
                    conn.commit()
            finally:
                conn.close()
        return self.send_csv("approved-teams.csv", out)

    def export_groups_csv(self, who=None):
        with DB_LOCK:
            conn = db()
            try:
                groups = conn.execute("SELECT * FROM groups ORDER BY name").fetchall()
                out = [["group", "slot", "reg_code", "team_name", "team_tag"]]
                for g in groups:
                    teams = conn.execute(
                        "SELECT reg_code, team_name, team_tag FROM registrations "
                        "WHERE group_id = ? ORDER BY team_name",
                        (g["id"],)).fetchall()
                    if not teams:
                        out.append([g["name"], "-", "", "", ""])
                    for i, t in enumerate(teams, 1):
                        out.append([g["name"], i, t["reg_code"],
                                    t["team_name"], t["team_tag"]])
                if who:                       # exports are logged (PII-free)
                    audit(conn, who, None, "export", "groups_csv",
                          None, "%d rows" % (len(out) - 1))
                    conn.commit()
            finally:
                conn.close()
        return self.send_csv("groups.csv", out)

    # ---- POST -------------------------------------------------------------

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/register":
            return self.do_register()

        if path == "/api/status/lookup":
            return self.status_lookup()

        if path == "/api/status/request-change":
            return self.status_request_change()

        if path.startswith("/api/admin/"):
            return self.admin_post(path)

        return self.send_json({"ok": False, "error": "Not found."}, 404)

    # ---- public: status lookup ---------------------------------------------

    @staticmethod
    def _status_generic():
        return {"ok": False, "found": False,
                "error": "No registration found. Double-check the ID and the "
                         "phone or email you registered with."}

    def _match_registration(self, conn, code, hint):
        """Return the row only when the code AND phone/email match."""
        row = conn.execute("SELECT * FROM registrations WHERE reg_code = ?",
                           (code,)).fetchone()
        if not row:
            return None
        phone = re.sub(r"\D", "", row["cap_phone"] or "")
        given = re.sub(r"\D", "", hint)
        ok_phone = len(given) >= 6 and given == phone
        ok_email = ("@" in hint and
                    hint == (row["cap_email"] or "").strip().lower())
        return row if (ok_phone or ok_email) else None

    def status_lookup(self):
        ip = self.client_ip()
        if not rate_ok(ip, STATUS_RATE_LIMIT, STATUS_RATE_WINDOW, "status"):
            return self.send_json(
                {"ok": False, "error": "Too many lookups. Try again in a minute."},
                429)
        data = self.json_body() or {}
        code = (data.get("regCode") or "").strip().upper()
        hint = (data.get("hint") or "").strip().lower()
        if not code or not hint:
            return self.send_json(self._status_generic(), 404)
        with DB_LOCK:
            conn = db()
            try:
                row = self._match_registration(conn, code, hint)
                if not row:
                    return self.send_json(self._status_generic(), 404)
                group = None
                if row["group_id"]:
                    g = conn.execute("SELECT name FROM groups WHERE id = ?",
                                     (row["group_id"],)).fetchone()
                    group = g["name"] if g else None
                open_req = conn.execute(
                    "SELECT COUNT(*) AS c FROM change_requests "
                    "WHERE team_id = ? AND seen = 0",
                    (row["team_id"],)).fetchone()["c"]
            finally:
                conn.close()
        status = row["status"] or "pending"
        return self.send_json({
            "ok": True, "found": True, "regCode": row["reg_code"],
            "teamName": row["team_name"], "teamTag": row["team_tag"],
            "status": status, "statusLabel": STATUS_LABELS.get(status, status),
            "note": row["status_note"] or "", "group": group,
            "schedule": row["schedule_note"] or "", "openRequests": open_req,
            "updatedAt": row["updated_at"] or row["created_at"]})

    def status_request_change(self):
        ip = self.client_ip()
        if not rate_ok(ip, STATUS_RATE_LIMIT, STATUS_RATE_WINDOW, "status"):
            return self.send_json(
                {"ok": False, "error": "Too many attempts. Try again in a minute."},
                429)
        data = self.json_body() or {}
        code = (data.get("regCode") or "").strip().upper()
        hint = (data.get("hint") or "").strip().lower()
        message = (data.get("message") or "").strip()
        if not code or not hint:
            return self.send_json(self._status_generic(), 404)
        if not (5 <= len(message) <= 1000):
            return self.send_json(
                {"ok": False, "error": "Describe the correction in 5-1000 characters."},
                400)
        with DB_LOCK:
            conn = db()
            try:
                row = self._match_registration(conn, code, hint)
                if not row:
                    return self.send_json(self._status_generic(), 404)
                conn.execute(
                    "INSERT INTO change_requests (team_id, message, created_at) "
                    "VALUES (?,?,?)", (row["team_id"], message, now_iso()))
                conn.execute("UPDATE registrations SET updated_at = ? "
                             "WHERE team_id = ?", (now_iso(), row["team_id"]))
                conn.commit()
            finally:
                conn.close()
        return self.send_json({"ok": True})

    # ---- admin POST APIs ---------------------------------------------------

    def admin_login(self):
        ip = self.client_ip()
        if not rate_ok(ip, 10, 300, "adminlogin"):
            return self.send_json(
                {"ok": False, "error": "Too many attempts. Try again later."},
                429)
        data = self.json_body() or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not username or not password:
            return self.send_json(
                {"ok": False, "error": "Enter username and password."}, 400)
        # per-username throttle: rotating source IPs cannot grind one account.
        # Only failures are counted; a successful login clears the tally.
        user_key = username.lower()
        if rate_blocked(user_key, 5, 300, "adminlogin_user"):
            return self.send_json(
                {"ok": False,
                 "error": "Too many attempts for this account. "
                          "Try again in a few minutes."}, 429)
        with DB_LOCK:
            conn = db()
            try:
                row = conn.execute("SELECT * FROM admin_users WHERE username = ?",
                                   (username,)).fetchone()
                if row:
                    ok = verify_password(
                        password, row["pass_salt"], row["pass_hash"])
                else:
                    # identical scrypt work for unknown users (anti-enumeration)
                    verify_password(password, LOGIN_DUMMY_SALT, LOGIN_DUMMY_HASH)
                    ok = False
                if not ok:
                    rate_note(user_key, "adminlogin_user")
                    time.sleep(0.4)
                    return self.send_json(
                        {"ok": False, "error": "Wrong username or password."}, 401)
                conn.execute("UPDATE admin_users SET last_login = ? WHERE id = ?",
                             (now_iso(), row["id"]))
                audit(conn, username, None, "login")
                conn.commit()
            finally:
                conn.close()
        rate_clear(user_key, "adminlogin_user")
        raw, csrf = session_create(row["id"])
        return self.send_json({"ok": True, "username": username, "csrf": csrf},
                              headers=self.set_session_cookie(raw))

    def admin_post(self, path):
        rest = path[len("/api/admin/"):]

        if rest == "login":
            return self.admin_login()

        if rest == "logout":
            session_revoke(self.session_raw())
            return self.send_json({"ok": True},
                                  headers=self.clear_session_cookie())

        admin = self.require_admin(write=True)
        if not admin:
            return None
        who = admin[0]["username"]
        data = self.json_body() or {}

        # ---- status actions ----
        m = re.match(r"^registrations/([^/]+)/status$", rest)
        if m:
            return self.admin_set_status(m.group(1), data, who)

        if rest == "bulk-status":
            ids = [str(t)[:16] for t in (data.get("teamIds") or [])][:200]
            done, errors = [], []
            with DB_LOCK:
                conn = db()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    for tid in ids:
                        try:
                            change_status(conn, tid, data.get("status"),
                                          data.get("note") or "", who,
                                          bool(data.get("override")))
                            enqueue_notification(conn, tid, "status")
                            done.append(tid)
                        except ValidationError as e:
                            errors.append({"teamId": tid, "error": e.message})
                    conn.commit()
                finally:
                    conn.close()
            return self.send_json({"ok": True, "done": done, "errors": errors})

        m = re.match(r"^registrations/([^/]+)/note$", rest)
        if m:
            tid = m.group(1)
            note = (data.get("note") or "").strip()[:2000]
            with DB_LOCK:
                conn = db()
                try:
                    row = conn.execute("SELECT admin_note FROM registrations "
                                       "WHERE team_id = ?", (tid,)).fetchone()
                    if not row:
                        return self.send_json(
                            {"ok": False, "error": "Not found."}, 404)
                    conn.execute("UPDATE registrations SET admin_note = ?, "
                                 "updated_at = ? WHERE team_id = ?",
                                 (note, now_iso(), tid))
                    audit(conn, who, tid, "admin_note", "admin_note",
                          row["admin_note"], note)
                    conn.commit()
                finally:
                    conn.close()
            return self.send_json({"ok": True})

        m = re.match(r"^registrations/([^/]+)/requests/(\d+)/seen$", rest)
        if m:
            with DB_LOCK:
                conn = db()
                try:
                    conn.execute("UPDATE change_requests SET seen = 1 WHERE id = ?",
                                 (m.group(2),))
                    conn.commit()
                finally:
                    conn.close()
            return self.send_json({"ok": True})

        # ---- groups ----
        if rest == "groups":
            return self.admin_group_create(data, who)

        if rest == "groups/auto":
            return self.admin_groups_auto(data, who)

        if rest == "notifications/retry":
            raw_ids = data.get("ids")
            try:
                ids = [int(i) for i in (raw_ids or [])][:200]
            except (TypeError, ValueError):
                return self.send_json(
                    {"ok": False, "error": "ids must be numbers."}, 400)
            with DB_LOCK:
                conn = db()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    if raw_ids:
                        marks = ",".join("?" * len(ids))
                        n = conn.execute(
                            "UPDATE notification_queue SET status = 'pending', "
                            "next_at = NULL, attempts = 0 "
                            "WHERE status = 'failed' AND id IN (%s)" % marks,
                            ids).rowcount
                    else:
                        n = conn.execute(
                            "UPDATE notification_queue SET status = 'pending', "
                            "next_at = NULL, attempts = 0 "
                            "WHERE status = 'failed'").rowcount
                    audit(conn, who, None, "notify_retry", new="%d job(s)" % n)
                    conn.commit()
                finally:
                    conn.close()
            return self.send_json({"ok": True, "requeued": n})

        m = re.match(r"^groups/(\d+)/assign$", rest)
        if m:
            return self.admin_group_assign(int(m.group(1)), data, who)

        # ---- settings / purge ----
        if rest == "settings":
            with DB_LOCK:
                conn = db()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    old_limit = get_setting(conn, "slot_limit", str(SLOT_LIMIT))
                    old_pub = get_setting(conn, "public_teams", "0")
                    if "slot_limit" in data:
                        try:
                            lim = int(data["slot_limit"])
                        except (TypeError, ValueError):
                            lim = 0
                        if not (1 <= lim <= 256):
                            return self.send_json(
                                {"ok": False, "error": "Slot limit 1-256."}, 400)
                        set_setting(conn, "slot_limit", lim)
                        audit(conn, who, None, "setting", "slot_limit",
                              old_limit, lim)
                    if "public_teams" in data:
                        val = "1" if data["public_teams"] else "0"
                        set_setting(conn, "public_teams", val)
                        audit(conn, who, None, "setting", "public_teams",
                              old_pub, val)
                    if "groups_locked" in data:
                        old_lock = get_setting(conn, "groups_locked", "0")
                        val = "1" if data["groups_locked"] else "0"
                        set_setting(conn, "groups_locked", val)
                        audit(conn, who, None, "setting", "groups_locked",
                              old_lock, val)
                    if "timezone" in data:
                        tz = str(data["timezone"]).strip()[:40]
                        if not re.match(r"^[A-Za-z0-9_+\-/]+$", tz):
                            return self.send_json(
                                {"ok": False, "error": "Timezone looks odd."}, 400)
                        old_tz = get_setting(conn, "timezone", "Asia/Kolkata")
                        set_setting(conn, "timezone", tz)
                        audit(conn, who, None, "setting", "timezone", old_tz, tz)
                        set_setting(conn, "schedule_updated", now_iso())
                    if "schedule_note" in data:
                        note = str(data["schedule_note"]).strip()[:2000]
                        old_note = get_setting(conn, "schedule_note", "")
                        set_setting(conn, "schedule_note", note)
                        audit(conn, who, None, "setting", "schedule_note",
                              "(changed)", "%d chars" % len(note))
                        set_setting(conn, "schedule_updated", now_iso())
                    conn.commit()
                finally:
                    conn.close()
            return self.send_json({"ok": True})

        if rest == "purge":
            if (data.get("confirm") or "").strip().upper() != "PURGE":
                return self.send_json(
                    {"ok": False,
                     "error": "Type PURGE to confirm. This removes every team."},
                    400)
            with DB_LOCK:
                conn = db()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    n = conn.execute(
                        "SELECT COUNT(*) AS c FROM registrations").fetchone()["c"]
                    logos = [r["logo_path"] for r in conn.execute(
                        "SELECT logo_path FROM registrations "
                        "WHERE logo_path IS NOT NULL")]
                    # broadcast data references registrations via FK cascade,
                    # but clear explicitly first so nothing is left behind
                    conn.execute("DELETE FROM event_log")
                    conn.execute("DELETE FROM player_stats")
                    conn.execute("DELETE FROM match_team_results")
                    conn.execute("DELETE FROM matches")
                    conn.execute("DELETE FROM overlay_settings")
                    conn.execute("DELETE FROM change_requests")
                    conn.execute("DELETE FROM roster_members")
                    conn.execute("DELETE FROM registrations")
                    conn.execute("DELETE FROM groups")
                    audit(conn, who, None, "purge_all",
                          old="%d teams" % n, new="0")
                    # re-seed overlay defaults with a fresh token
                    broadcast.reseed_settings(conn)
                    conn.commit()
                finally:
                    conn.close()
            broadcast.publish_update()
            for lp in logos:
                target = os.path.join(UPLOAD_DIR, os.path.basename(lp))
                for attempt in range(3):
                    try:
                        os.remove(target)
                        break
                    except PermissionError:
                        time.sleep(0.3)
                    except OSError:
                        break
            return self.send_json({"ok": True, "removed": n})

        # ---- broadcast admin writes ----
        if rest == "matches":
            try:
                with DB_LOCK:
                    conn = db()
                    try:
                        conn.execute("BEGIN IMMEDIATE")
                        match = broadcast.create_match(
                            conn, data.get("group"), data.get("map", "Erangel"),
                            data.get("notes", ""), who)
                        if data.get("teamIds") is not None:
                            broadcast.set_lineup(conn, match["id"],
                                                 data.get("teamIds"))
                        audit(conn, who, None, "match_create",
                              new="match %d" % match["match_number"])
                        conn.commit()
                        state = broadcast.match_state(conn, match["id"])
                    except Exception:
                        conn.rollback()
                        raise
                    finally:
                        conn.close()
            except ValueError as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)
            broadcast.publish_update()
            return self.send_json({"ok": True, "state": state})

        m = re.match(r"^matches/(\d+)(?:/(checkin|status|publish|unpublish|reset))?$",
                     rest)
        if m:
            mid = int(m.group(1))
            action = m.group(2)
            try:
                with DB_LOCK:
                    conn = db()
                    try:
                        conn.execute("BEGIN IMMEDIATE")
                        if action is None and data.get("delete"):
                            match = broadcast.get_match(conn, mid)
                            broadcast.delete_match(conn, mid, who)
                            audit(conn, who, None, "match_delete",
                                  old="match %s" %
                                  (match["match_number"] if match else mid))
                        elif action == "checkin":
                            broadcast.set_lineup(conn, mid,
                                                 data.get("teamIds") or [])
                            audit(conn, who, None, "match_checkin",
                                  new="%d squads" %
                                  len(data.get("teamIds") or []))
                        elif action == "status":
                            status = data.get("status")
                            if status == "live":
                                broadcast.start_match(conn, mid, who)
                            elif status == "awaiting_verification":
                                broadcast.end_match(conn, mid, who)
                            else:
                                raise ValueError("Unknown status change.")
                            audit(conn, who, None, "match_status", new=status)
                        elif action == "publish":
                            broadcast.publish_match(conn, mid, who)
                            audit(conn, who, None, "match_publish")
                        elif action == "unpublish":
                            broadcast.unpublish_match(conn, mid, who)
                            audit(conn, who, None, "match_unpublish")
                        elif action == "reset":
                            broadcast.reset_match(conn, mid, who)
                            audit(conn, who, None, "match_reset")
                        else:
                            raise ValueError("Unknown match action.")
                        conn.commit()
                        state = broadcast.match_state(conn, mid)
                        matches = broadcast.list_matches(conn)
                    except Exception:
                        conn.rollback()
                        raise
                    finally:
                        conn.close()
            except ValueError as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)
            broadcast.publish_update()
            return self.send_json({"ok": True, "state": state,
                                   "matches": matches})

        # ---- live desk actions ----
        m = re.match(r"^match/(\d+)/team/([^/]+)"
                     r"(?:/(kills|eliminate|placement))?$", rest)
        if m:
            mid, tid, action = int(m.group(1)), m.group(2), m.group(3)
            try:
                with DB_LOCK:
                    conn = db()
                    try:
                        conn.execute("BEGIN IMMEDIATE")
                        if action == "kills":
                            broadcast.team_kill_delta(
                                conn, mid, tid, data.get("delta", 1), who)
                        elif action == "eliminate":
                            broadcast.eliminate_team(conn, mid, tid, who)
                        elif action == "placement":
                            broadcast.set_placement(
                                conn, mid, tid, data.get("placement"),
                                bool(data.get("manual", True)), who)
                        else:
                            raise ValueError("Unknown team action.")
                        conn.commit()
                        state = broadcast.match_state(conn, mid)
                    except Exception:
                        conn.rollback()
                        raise
                    finally:
                        conn.close()
            except ValueError as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)
            broadcast.publish_update()
            return self.send_json({"ok": True, "state": state})

        m = re.match(r"^match/(\d+)/player$", rest)
        if m:
            mid = int(m.group(1))
            try:
                with DB_LOCK:
                    conn = db()
                    try:
                        conn.execute("BEGIN IMMEDIATE")
                        broadcast.player_action(
                            conn, mid, data.get("teamId"),
                            data.get("playerId"), data.get("field"),
                            data.get("value"), who)
                        conn.commit()
                        state = broadcast.match_state(conn, mid)
                    except Exception:
                        conn.rollback()
                        raise
                    finally:
                        conn.close()
            except ValueError as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)
            broadcast.publish_update()
            return self.send_json({"ok": True, "state": state})

        m = re.match(r"^match/(\d+)/undo$", rest)
        if m:
            mid = int(m.group(1))
            try:
                with DB_LOCK:
                    conn = db()
                    try:
                        conn.execute("BEGIN IMMEDIATE")
                        broadcast.undo_last(conn, mid, who)
                        conn.commit()
                        state = broadcast.match_state(conn, mid)
                    except Exception:
                        conn.rollback()
                        raise
                    finally:
                        conn.close()
            except ValueError as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)
            broadcast.publish_update()
            return self.send_json({"ok": True, "state": state})

        if rest == "overlay-settings":
            with DB_LOCK:
                conn = db()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    if "themeColor" in data:
                        color = str(data.get("themeColor") or "").strip()
                        if not re.match(r"^#[0-9a-fA-F]{6}$", color):
                            return self.send_json(
                                {"ok": False,
                                 "error": "Theme color must be #rrggbb."},
                                400)
                        broadcast.set_bsetting(conn, "theme_color", color)
                    if "logoPath" in data:
                        broadcast.set_bsetting(
                            conn, "logo_path",
                            broadcast._clamp_str(data.get("logoPath"), 200))
                    if "sponsorText" in data:
                        broadcast.set_bsetting(
                            conn, "sponsor_text",
                            broadcast._clamp_str(data.get("sponsorText"), 120))
                    if "introTeam" in data:
                        broadcast.set_bsetting(
                            conn, "intro_team",
                            broadcast._clamp_str(data.get("introTeam"), 16))
                    if data.get("rotateToken"):
                        broadcast.set_bsetting(
                            conn, "token", secrets.token_urlsafe(24))
                    if "pushedCard" in data:
                        card = data.get("pushedCard")
                        if card is None:
                            broadcast.set_bsetting(conn, "pushed_card", "")
                        else:
                            # stamp the push time server-side: pushed_card()
                            # expires cards after PUSH_CARD_TTL seconds, and a
                            # client-supplied timestamp could never be trusted
                            if isinstance(card, dict):
                                card = dict(card)
                                card["at"] = time.time()
                            broadcast.set_bsetting(
                                conn, "pushed_card",
                                json.dumps(card)[:2000])
                    if "disabled" in data:
                        names = [n for n in (data.get("disabled") or [])
                                 if n in broadcast.OVERLAY_NAMES][:20]
                        broadcast.set_bsetting(conn, "disabled",
                                               json.dumps(names))
                    audit(conn, who, None, "overlay_settings",
                          new=str(sorted(k for k in data)))
                    conn.commit()
                    pairs = {r["key"]: r["value"] for r in conn.execute(
                        "SELECT key, value FROM overlay_settings")}
                finally:
                    conn.close()
            broadcast.publish_update()
            return self.send_json({"ok": True,
                                   "token": pairs.get("token", ""),
                                   "themeColor": pairs.get("theme_color",
                                                           "#b6ff3e")})

        if rest == "scoring-rules":
            try:
                with DB_LOCK:
                    conn = db()
                    try:
                        conn.execute("BEGIN IMMEDIATE")
                        old = broadcast.load_rules(conn)
                        broadcast.save_rules(conn, data)
                        new = broadcast.load_rules(conn)
                        audit(conn, who, None, "scoring_rules",
                              old=json.dumps(old), new=json.dumps(new))
                        conn.commit()
                    finally:
                        conn.close()
            except (TypeError, ValueError) as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)
            broadcast.publish_update()
            return self.send_json({"ok": True, "rules": new})

        return self.send_json({"ok": False, "error": "Not found."}, 404)

    def admin_set_status(self, tid, data, who):
        new_status = data.get("status")
        note = (data.get("note") or "").strip()[:1000]
        override = bool(data.get("override"))
        with DB_LOCK:
            conn = db()
            try:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    change_status(conn, tid, new_status, note, who, override)
                    # the mail job commits with the decision itself
                    enqueue_notification(conn, tid, "status")
                    conn.commit()
                except ValidationError as e:
                    conn.rollback()
                    return self.send_json(
                        {"ok": False, "error": e.message, "field": e.field}, 400)
                row = dict(conn.execute(
                    "SELECT * FROM registrations WHERE team_id = ?",
                    (tid,)).fetchone())
                counts = {s: conn.execute(
                    "SELECT COUNT(*) AS c FROM registrations WHERE status = ?",
                    (s,)).fetchone()["c"] for s in STATUSES}
                limit = int(get_setting(conn, "slot_limit", str(SLOT_LIMIT)))
            finally:
                conn.close()
        return self.send_json({"ok": True, "registration": row,
                               "counts": counts, "slot_limit": limit})

    # ---- group helpers -----------------------------------------------------

    def admin_group_create(self, data, who):
        name = (data.get("name") or "").strip()[:20]
        try:
            size = int(data.get("size") or 4)
        except (TypeError, ValueError):
            size = 0
        if not name or not (1 <= size <= 32):
            return self.send_json(
                {"ok": False, "error": "Group needs a name and size 1-32."}, 400)
        with DB_LOCK:
            conn = db()
            try:
                conn.execute("BEGIN IMMEDIATE")
                if get_setting(conn, "groups_locked", "0") == "1":
                    return self.send_json(
                        {"ok": False, "error": "Groups are locked."}, 403)
                existing = conn.execute("SELECT COUNT(*) AS c FROM groups "
                                        "WHERE name = ?", (name,)).fetchone()["c"]
                if existing:
                    return self.send_json(
                        {"ok": False, "error": "Group name already exists."}, 409)
                cur = conn.execute("INSERT INTO groups (name, size) VALUES (?,?)",
                                   (name, size))
                audit(conn, who, None, "group_create", name, None, str(size))
                conn.commit()
                gid = cur.lastrowid
            finally:
                conn.close()
        return self.send_json({"ok": True, "groupId": gid})

    def admin_groups_auto(self, data, who):
        """Randomly distribute approved teams across lettered groups.

        preview=True computes and returns the plan without writing anything.
        By default existing (non-locked) assignments are preserved and only
        unplaced teams are shuffled in; rebuild=True is the explicit admin
        choice to reshuffle everyone except locked-group members.  A team
        belongs to at most one group (single group_id column), so re-runs
        can never duplicate memberships."""
        try:
            count = int(data.get("count") or 0)
            size = int(data.get("size") or 4)
        except (TypeError, ValueError):
            count, size = 0, 0
        if not (1 <= count <= 26) or not (1 <= size <= 32):
            return self.send_json(
                {"ok": False, "error": "Need 1-26 groups of size 1-32."}, 400)
        preview = bool(data.get("preview"))
        rebuild = bool(data.get("rebuild"))
        letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        names = ["Group " + letters[i] for i in range(count)]
        with DB_LOCK:
            conn = db()
            try:
                conn.execute("BEGIN IMMEDIATE")
                if get_setting(conn, "groups_locked", "0") == "1":
                    return self.send_json(
                        {"ok": False, "error": "Groups are locked."}, 403)
                # (re)create the requested lettered groups if missing — only
                # those exact names are handled, other groups are untouched
                for i in range(count):
                    row = conn.execute("SELECT id FROM groups WHERE name = ?",
                                       (names[i],)).fetchone()
                    if row:
                        conn.execute("UPDATE groups SET size = ? WHERE id = ?",
                                     (size, row["id"]))
                    else:
                        conn.execute("INSERT INTO groups (name, size) VALUES (?,?)",
                                     (names[i], size))
                groups = [dict(g) for g in conn.execute(
                    "SELECT * FROM groups WHERE name IN (%s) ORDER BY name"
                    % ",".join("?" * len(names)), names)]
                movable = [dict(r) for r in conn.execute(
                    "SELECT r.team_id, r.team_name, r.group_id, g.locked "
                    "FROM registrations r "
                    "LEFT JOIN groups g ON g.id = r.group_id "
                    "WHERE r.status = 'approved'")]
                buckets = {g["id"]: [] for g in groups}
                fixed = set()
                for r in movable:               # locked-group members stay
                    if r["group_id"] in buckets and r["locked"]:
                        buckets[r["group_id"]].append(r["team_id"])
                        fixed.add(r["team_id"])
                if not rebuild:                 # keep manual placements too
                    for r in movable:
                        if (r["team_id"] not in fixed
                                and r["group_id"] in buckets):
                            buckets[r["group_id"]].append(r["team_id"])
                            fixed.add(r["team_id"])
                free = [r["team_id"] for r in movable
                        if r["team_id"] not in fixed]
                random.SystemRandom().shuffle(free)
                for tid in free:                # shuffle the rest in
                    for g in groups:
                        if len(buckets[g["id"]]) < g["size"]:
                            buckets[g["id"]].append(tid)
                            break
                    else:
                        buckets[groups[-1]["id"]].append(tid)  # keep, overflow
                names_by_id = {r["team_id"]: r["team_name"] for r in movable}
                overflow = sum(max(0, len(buckets[g["id"]]) - g["size"])
                               for g in groups)
                plan = [{"name": g["name"], "size": g["size"],
                         "teamIds": buckets[g["id"]],
                         "teams": [names_by_id.get(t, t)
                                   for t in buckets[g["id"]]]}
                        for g in groups]
                if preview:
                    conn.rollback()             # preview writes nothing
                    return self.send_json({"ok": True, "preview": True,
                                           "plan": plan, "unplaced": 0,
                                           "overflow": overflow})
                prev = {r["team_id"]: r["group_id"] for r in movable}
                moved = 0
                for g in groups:
                    for tid in buckets[g["id"]]:
                        if prev.get(tid) == g["id"]:
                            continue            # nothing changed for this team
                        conn.execute(
                            "UPDATE registrations SET group_id = ?, updated_at = ? "
                            "WHERE team_id = ?", (g["id"], now_iso(), tid))
                        enqueue_notification(conn, tid, "group")
                        moved += 1
                audit(conn, who, None, "groups_auto",
                      new="%d groups x %d, %d team(s)%s" % (
                          count, size, moved, " (rebuild)" if rebuild else ""))
                conn.commit()
            finally:
                conn.close()
        return self.send_json({"ok": True, "groups": count, "moved": moved,
                               "overflow": overflow})

    def admin_group_assign(self, gid, data, who):
        tid = (data.get("teamId") or "").strip()
        with DB_LOCK:
            conn = db()
            try:
                conn.execute("BEGIN IMMEDIATE")
                if get_setting(conn, "groups_locked", "0") == "1":
                    return self.send_json(
                        {"ok": False, "error": "Groups are locked."}, 403)
                row = conn.execute("SELECT status, group_id FROM registrations "
                                   "WHERE team_id = ?", (tid,)).fetchone()
                if not row:
                    return self.send_json(
                        {"ok": False, "error": "Registration not found."}, 404)
                if gid == 0:
                    # unassign
                    conn.execute("UPDATE registrations SET group_id = NULL, "
                                 "updated_at = ? WHERE team_id = ?",
                                 (now_iso(), tid))
                    audit(conn, who, tid, "group_clear",
                          old=str(row["group_id"]), new=None)
                    conn.commit()
                    return self.send_json({"ok": True})
                if row["status"] != "approved":
                    return self.send_json(
                        {"ok": False,
                         "error": "Only approved teams can be in groups."}, 400)
                g = conn.execute("SELECT * FROM groups WHERE id = ?",
                                 (gid,)).fetchone()
                if not g:
                    return self.send_json(
                        {"ok": False, "error": "Group not found."}, 404)
                if g["locked"]:
                    return self.send_json(
                        {"ok": False, "error": "%s is locked." % g["name"]}, 403)
                members = conn.execute(
                    "SELECT COUNT(*) AS c FROM registrations WHERE group_id = ?",
                    (gid,)).fetchone()["c"]
                if row["group_id"] != gid and members >= g["size"]:
                    return self.send_json(
                        {"ok": False,
                         "error": "%s is full (%d/%d)."
                                  % (g["name"], members, g["size"])}, 400)
                conn.execute("UPDATE registrations SET group_id = ?, updated_at = ? "
                             "WHERE team_id = ?", (gid, now_iso(), tid))
                enqueue_notification(conn, tid, "group")
                audit(conn, who, tid, "group_assign",
                      old=str(row["group_id"]), new="%d %s" % (gid, g["name"]))
                conn.commit()
            finally:
                conn.close()
        return self.send_json({"ok": True})

    # ---- registration submit (unchanged public flow) -----------------------

    def do_register(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self.send_json({"ok": False, "error": "Empty request."}, 400)
        if length > MAX_BODY:
            return self.send_json(
                {"ok": False, "error": "Payload too large."}, 413)

        body = self.rfile.read(length)
        self._body_read = length
        ctype = self.headers.get("Content-Type", "")

        try:
            if ctype.startswith("multipart/form-data"):
                fields = self._parse_multipart(body, ctype)
            else:
                fields = {k: v[0] for k, v in parse_qs(body.decode("utf-8")).items()}
        except Exception:
            return self.send_json(
                {"ok": False, "error": "Malformed form data."}, 400)

        ip = self.client_ip()

        # 1) honeypot — humans never fill this
        if (fields.get("company") or "").strip():
            return self.send_json(
                {"ok": False, "error": "Bot detected."}, 403)

        # 2) rate limit
        if not rate_ok(ip):
            return self.send_json(
                {"ok": False,
                 "error": "Too many submissions from this network. Try again later."},
                429)

        # 3) CSRF
        token = self.headers.get("X-CSRF-Token", "")
        if not check_csrf(token, ip):
            return self.send_json(
                {"ok": False, "error": "Session expired. Press Register again.",
                 "errorCode": "csrf"}, 403)
        consume_csrf(token)

        # 4) validate
        try:
            data = {
                "teamName": v_team_name(fields.get("teamName")),
                "teamTag": v_tag(fields.get("teamTag")),
                "guildName": v_guild(fields.get("guildName")),
                "capIgn": v_ign(fields.get("capIgn"), "capIgn"),
                "capUid": v_uid(fields.get("capUid"), "capUid"),
                "capEmail": v_email(fields.get("capEmail")),
                "capPhone": v_phone(fields.get("capPhone")),
                "capDiscord": v_discord(fields.get("capDiscord")),
            }
            members = validate_roster(fields.get("roster", "[]"))

            # validate the logo now, write it to disk only after the row
            # exists — a rejected registration can never leave a stray file
            logo_raw, logo_ext = None, None
            logo_data = fields.get("logoDataUrl", "")
            if logo_data:
                logo_raw, logo_ext = validate_logo(logo_data)
        except ValidationError as e:
            return self.send_json(
                {"ok": False, "error": e.message, "field": e.field}, 400)

        # 5) persist
        try:
            team_id = insert_registration(data, members, ip, None)
        except ValidationError as e:
            return self.send_json(
                {"ok": False, "error": e.message, "field": e.field}, 409)

        # 6) logo lands under the server-allocated team id (no user input
        #    touches the filename) after the registration is committed
        logo_path = None
        if logo_raw:
            fname = "%s.%s" % (team_id, logo_ext)
            try:
                with open(os.path.join(UPLOAD_DIR, fname), "wb") as f:
                    f.write(logo_raw)
                logo_path = "/uploads/" + fname
                with DB_LOCK:
                    conn = db()
                    try:
                        conn.execute(
                            "UPDATE registrations SET logo_path = ? "
                            "WHERE team_id = ?", (logo_path, team_id))
                        conn.commit()
                    finally:
                        conn.close()
            except OSError:
                logo_path = None     # registration stands; logo is optional

        return self.send_json(
            {"ok": True, "teamId": team_id, "logoPath": logo_path,
             "regCode": data.get("regCode"), "status": "pending",
             "statusLabel": STATUS_LABELS["pending"]}, 201)

    # ---- multipart (only text fields; logo travels as a data URL) ---------

    @staticmethod
    def _parse_multipart(body, ctype):
        m = re.search(r'boundary="?([^";]+)"?', ctype)
        if not m:
            raise ValueError("no boundary")
        boundary = ("--" + m.group(1)).encode()
        fields = {}
        for chunk in body.split(boundary):
            chunk = chunk.rstrip(b"\r\n")
            if not chunk or chunk == b"--":
                continue
            if b"\r\n\r\n" not in chunk:
                continue
            header_blob, _, value = chunk.partition(b"\r\n\r\n")
            headers = header_blob.decode("utf-8", "replace")
            nm = re.search(r'name="([^"]+)"', headers)
            if not nm:
                continue
            fields[nm.group(1)] = value.decode("utf-8", "replace")
        return fields

    def do_PUT(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/admin/"):
            return self.send_json(
                {"ok": False, "error": "Method not allowed."}, 405)
        admin = self.require_admin(write=True)
        if not admin:
            return None
        who = admin[0]["username"]
        rest = path[len("/api/admin/"):]
        data = self.json_body() or {}

        m = re.match(r"^registrations/([^/]+)$", rest)
        if m:
            return self.admin_edit_team(m.group(1), data, who)

        m = re.match(r"^groups/(\d+)$", rest)
        if m:
            return self.admin_group_update(int(m.group(1)), data, who)

        return self.send_json({"ok": False, "error": "Not found."}, 404)

    def admin_edit_team(self, tid, data, who):
        with DB_LOCK:
            conn = db()
            try:
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute("SELECT * FROM registrations "
                                   "WHERE team_id = ?", (tid,)).fetchone()
                if not row:
                    return self.send_json(
                        {"ok": False, "error": "Not found."}, 404)
                try:
                    updates = {}
                    if "teamName" in data:
                        updates["team_name"] = v_team_name(data["teamName"])
                    if "teamTag" in data:
                        tag = v_tag(data["teamTag"])
                        dupe = conn.execute(
                            "SELECT team_id FROM registrations WHERE team_tag = ? "
                            "AND team_id != ?", (tag, tid)).fetchone()
                        if dupe:
                            raise ValidationError(
                                "Team tag %s already belongs to %s."
                                % (tag, dupe["team_id"]), "teamTag")
                        updates["team_tag"] = tag
                    if "guildName" in data:
                        updates["guild_name"] = v_guild(data["guildName"])
                    if "capIgn" in data:
                        updates["cap_ign"] = v_ign(data["capIgn"], "capIgn")
                    if "capUid" in data:
                        uid = v_uid(data["capUid"], "capUid")
                        dupe = conn.execute(
                            "SELECT team_id FROM roster_members WHERE uid = ? "
                            "AND team_id != ?", (uid, tid)).fetchone()
                        if dupe:
                            raise ValidationError(
                                "UID %s is already on squad %s."
                                % (uid, dupe["team_id"]), "capUid")
                        updates["cap_uid"] = uid
                    if "capEmail" in data:
                        updates["cap_email"] = v_email(data["capEmail"])
                    if "capPhone" in data:
                        updates["cap_phone"] = v_phone(data["capPhone"])
                    if "capDiscord" in data:
                        updates["cap_discord"] = v_discord(data["capDiscord"])
                    if "scheduleNote" in data:
                        updates["schedule_note"] = str(data["scheduleNote"])[:300]
                    if "adminNote" in data:
                        updates["admin_note"] = str(data["adminNote"])[:2000]

                    changed = []
                    for col, new in updates.items():
                        old = row[col]
                        if (old or "") != (new or ""):
                            audit(conn, who, tid, "edit", col, old, new)
                            changed.append((col, new))
                    if changed:
                        sets = ", ".join("%s = ?" % c for c, _ in changed)
                        conn.execute(
                            "UPDATE registrations SET %s, updated_at = ? "
                            "WHERE team_id = ?" % sets,
                            [v for _, v in changed] + [now_iso(), tid])

                    if isinstance(data.get("roster"), list):
                        members = validate_roster(json.dumps(data["roster"]))
                        seen = set()
                        for mem in members:
                            if mem["uid"] in seen:
                                raise ValidationError(
                                    "Duplicate UID inside this roster.", "roster")
                            seen.add(mem["uid"])
                            dupe = conn.execute(
                                "SELECT team_id FROM roster_members WHERE uid = ? "
                                "AND team_id != ?", (mem["uid"], tid)).fetchone()
                            if dupe:
                                raise ValidationError(
                                    "UID %s is already on squad %s."
                                    % (mem["uid"], dupe["team_id"]), "roster")
                        old_members = [dict(x) for x in conn.execute(
                            "SELECT slot, role, ign, uid FROM roster_members "
                            "WHERE team_id = ? ORDER BY slot", (tid,))]
                        conn.execute("DELETE FROM roster_members WHERE team_id = ?",
                                     (tid,))
                        conn.executemany(
                            "INSERT INTO roster_members "
                            "(team_id, slot, role, ign, uid) VALUES (?,?,?,?,?)",
                            [(tid, x["slot"], x["role"], x["ign"], x["uid"])
                             for x in members])
                        audit(conn, who, tid, "edit", "roster",
                              "; ".join(m["ign"] for m in old_members),
                              "; ".join(m["ign"] for m in members))

                    if any(c == "schedule_note" for c, _ in changed):
                        enqueue_notification(conn, tid, "schedule")

                    conn.execute("UPDATE registrations SET updated_at = ? "
                                 "WHERE team_id = ?", (now_iso(), tid))
                    conn.commit()
                except ValidationError as e:
                    conn.rollback()
                    return self.send_json(
                        {"ok": False, "error": e.message, "field": e.field}, 400)
                except sqlite3.IntegrityError as e:
                    conn.rollback()
                    msg = str(e).lower()
                    field = ("roster" if "uid" in msg else
                             "teamTag" if "team_tag" in msg else None)
                    return self.send_json(
                        {"ok": False, "field": field,
                         "error": "That value collides with another "
                                  "registration."}, 409)
            finally:
                conn.close()
        return self.admin_detail(tid)

    def admin_group_update(self, gid, data, who):
        with DB_LOCK:
            conn = db()
            try:
                conn.execute("BEGIN IMMEDIATE")
                g = conn.execute("SELECT * FROM groups WHERE id = ?",
                                 (gid,)).fetchone()
                if not g:
                    return self.send_json(
                        {"ok": False, "error": "Not found."}, 404)
                if g["locked"] and ("name" in data or "size" in data):
                    return self.send_json(
                        {"ok": False, "error": "Unlock the group first."}, 403)
                if "name" in data:
                    name = str(data["name"]).strip()[:20]
                    if not name:
                        return self.send_json(
                            {"ok": False, "error": "Name required."}, 400)
                    conn.execute("UPDATE groups SET name = ? WHERE id = ?",
                                 (name, gid))
                    audit(conn, who, None, "group_edit", "name",
                          g["name"], name)
                if "size" in data:
                    try:
                        size = int(data["size"])
                    except (TypeError, ValueError):
                        size = 0
                    if not (1 <= size <= 32):
                        return self.send_json(
                            {"ok": False, "error": "Size must be 1-32."}, 400)
                    members = conn.execute(
                        "SELECT COUNT(*) AS c FROM registrations "
                        "WHERE group_id = ?", (gid,)).fetchone()["c"]
                    if size < members:
                        return self.send_json(
                            {"ok": False,
                             "error": "Group has %d teams; size can't go "
                                      "below that." % members}, 400)
                    conn.execute("UPDATE groups SET size = ? WHERE id = ?",
                                 (size, gid))
                    audit(conn, who, None, "group_edit", "size",
                          g["size"], size)
                if "locked" in data:
                    locked = 1 if data["locked"] else 0
                    conn.execute("UPDATE groups SET locked = ? WHERE id = ?",
                                 (locked, gid))
                    audit(conn, who, None, "group_edit", "locked",
                          bool(g["locked"]), bool(locked))
                conn.commit()
            finally:
                conn.close()
        return self.send_json({"ok": True})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/admin/"):
            return self.send_json(
                {"ok": False, "error": "Method not allowed."}, 405)
        admin = self.require_admin(write=True)
        if not admin:
            return None
        who = admin[0]["username"]
        rest = path[len("/api/admin/"):]

        m = re.match(r"^registrations/([^/]+)$", rest)
        if m:
            tid = m.group(1)
            with DB_LOCK:
                conn = db()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    row = conn.execute(
                        "SELECT logo_path FROM registrations WHERE team_id = ?",
                        (tid,)).fetchone()
                    if not row:
                        return self.send_json(
                            {"ok": False, "error": "Not found."}, 404)
                    conn.execute("DELETE FROM change_requests WHERE team_id = ?",
                                 (tid,))
                    conn.execute("DELETE FROM roster_members WHERE team_id = ?",
                                 (tid,))
                    conn.execute("DELETE FROM registrations WHERE team_id = ?",
                                 (tid,))
                    audit(conn, who, tid, "delete")
                    conn.commit()
                    logo = row["logo_path"]
                finally:
                    conn.close()
            if logo:
                target = os.path.join(UPLOAD_DIR, os.path.basename(logo))
                for attempt in range(3):
                    try:
                        os.remove(target)
                        break
                    except PermissionError:
                        time.sleep(0.3)
                    except OSError:
                        break
            return self.send_json({"ok": True})

        m = re.match(r"^groups/(\d+)$", rest)
        if m:
            gid = int(m.group(1))
            with DB_LOCK:
                conn = db()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    g = conn.execute("SELECT name FROM groups WHERE id = ?",
                                     (gid,)).fetchone()
                    if not g:
                        return self.send_json(
                            {"ok": False, "error": "Not found."}, 404)
                    conn.execute(
                        "UPDATE registrations SET group_id = NULL, "
                        "updated_at = ? WHERE group_id = ?", (now_iso(), gid))
                    conn.execute("DELETE FROM groups WHERE id = ?", (gid,))
                    audit(conn, who, None, "group_delete", g["name"])
                    conn.commit()
                finally:
                    conn.close()
            return self.send_json({"ok": True})

        return self.send_json({"ok": False, "error": "Not found."}, 404)


# ---------------------------------------------------------------------------

def main():
    init_db()
    # drain any jobs a previous run left behind before serving traffic
    try:
        process_notification_queue()
    except Exception as e:
        print("[notify] startup pass failed: %s" % e)
    threading.Thread(target=notification_worker, daemon=True).start()
    httpd = QuietThreadingHTTPServer((HOST, PORT), Handler)
    print("BGMI Cup registration server on http://%s:%d" % (HOST, PORT))
    print("Admin panel: http://%s:%d/admin   (create login: "
          "python scripts/create_admin.py)" % (HOST, PORT))
    print("Rate limit: %d submissions / %ds per IP" % (RATE_LIMIT, RATE_WINDOW))
    print("Notifications: %s (queue %ss)" % (
        "SMTP configured" if smtp_configured() else "SMTP off - mail skipped",
        NOTIFY_POLL))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBye.")
        httpd.server_close()


if __name__ == "__main__":
    main()
