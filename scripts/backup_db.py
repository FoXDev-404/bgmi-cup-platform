"""Consistent SQLite backup for the BGMI Cup database.

Usage:
    python scripts/backup_db.py                  # -> backups/registrations-<stamp>.db
    python scripts/backup_db.py --out mycopy.db
    python scripts/backup_db.py --keep 20        # prune older copies (default 10)

Safety properties:
  * Uses sqlite3's online backup API, so it is correct while the server is
    running and includes any WAL/journal content.
  * The copy is verified with PRAGMA integrity_check before it is kept; a
    corrupt copy is deleted and reported, never silently stored.
  * Backups land in backups/ (outside uploads/); the server refuses to serve
    .db files, so backups are never web-accessible.
  * Only row COUNTS are printed — no registration data appears in logs.
  * A failed backup never touches, truncates or replaces the live database.

Restore: see scripts/restore_db.py (stop the server first).
"""
import argparse
import glob
import os
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402  (respects BGMI_DB env override)

BACKUP_DIR = os.path.join(ROOT, "backups")


def backup(src=None, out=None, keep=10):
    """Snapshot `src` (default: the live DB) into `out`; returns the path."""
    src = src or server.DB_PATH
    if not os.path.isfile(src):
        raise SystemExit("No database at %s - nothing to back up." % src)
    out = out or os.path.join(
        BACKUP_DIR, "registrations-%s.db" % time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(os.path.dirname(out) or BACKUP_DIR, exist_ok=True)

    src_conn = sqlite3.connect(src, timeout=10)
    dst_conn = sqlite3.connect(out)
    try:
        src_conn.backup(dst_conn)        # consistent snapshot, safe online
    except Exception as e:
        dst_conn.close()
        src_conn.close()
        if os.path.isfile(out):
            os.remove(out)               # never keep a partial copy
        raise SystemExit("Backup failed (%s); live database untouched." % e)
    finally:
        try:
            src_conn.close()
        except Exception:
            pass

    check = sqlite3.connect(out)
    try:
        result = check.execute("PRAGMA integrity_check").fetchone()[0]
        try:
            teams = check.execute("SELECT COUNT(*) FROM registrations").fetchone()[0]
        except sqlite3.Error:
            teams = 0
    finally:
        check.close()
    if result != "ok":
        os.remove(out)                   # corrupt copies are not kept
        raise SystemExit("Backup failed integrity check (%s); live database "
                         "untouched." % result)

    if keep > 0:                         # prune old backups, newest kept
        old = sorted(glob.glob(os.path.join(BACKUP_DIR, "registrations-*.db")))
        for path in old[:-keep]:
            try:
                os.remove(path)
            except OSError:
                pass
    print("Backup OK: %s (%d teams, integrity verified)" % (out, teams))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", help="destination file (default backups/<stamp>.db)")
    ap.add_argument("--keep", type=int, default=10,
                    help="prune to this many backups (0 = keep all)")
    args = ap.parse_args()
    backup(out=args.out, keep=args.keep)
    return 0


if __name__ == "__main__":
    sys.exit(main())
