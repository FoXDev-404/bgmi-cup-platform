"""Restore a database backup. STOP THE SERVER FIRST.

Usage:
    python scripts/restore_db.py backups/registrations-<stamp>.db
    python scripts/restore_db.py <backup> --to other.db
    python scripts/restore_db.py <backup> --overwrite     # replace an existing target

The backup is integrity-checked before anything is written; the copy into
the target goes through a temporary file + os.replace so a crash mid-restore
cannot leave a half-written database in place.  The backup file itself is
never modified or deleted.  Only row counts are printed (no PII).
"""
import argparse
import os
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402  (respects BGMI_DB env override)


def restore(backup_path, target=None, overwrite=False):
    if not os.path.isfile(backup_path):
        raise SystemExit("Backup not found: %s" % backup_path)
    target = target or server.DB_PATH

    check = sqlite3.connect("file:%s?mode=ro" % backup_path, uri=True)
    try:
        result = check.execute("PRAGMA integrity_check").fetchone()[0]
        try:
            teams = check.execute("SELECT COUNT(*) FROM registrations").fetchone()[0]
        except sqlite3.Error:
            raise SystemExit("Backup has no registrations table - wrong file?")
    finally:
        check.close()
    if result != "ok":
        raise SystemExit("Backup is corrupt (%s); nothing restored." % result)

    if os.path.exists(target) and not overwrite:
        raise SystemExit("%s already exists. Stop the server and re-run with "
                         "--overwrite to replace it." % target)

    tmp = target + ".restore-tmp"
    src_conn = sqlite3.connect(backup_path, timeout=10)
    dst_conn = sqlite3.connect(tmp)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()
    os.replace(tmp, target)              # atomic on the same volume
    print("Restored %s -> %s (%d teams, integrity verified)"
          % (backup_path, target, teams))
    print("Old data (if any) was replaced at %s; the backup file is intact."
          % time.strftime("%Y-%m-%d %H:%M:%S"))
    return target


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("backup", help="backup file to restore from")
    ap.add_argument("--to", help="target database (default: the live DB)")
    ap.add_argument("--overwrite", action="store_true",
                    help="allow replacing an existing target")
    args = ap.parse_args()
    restore(args.backup, args.to, args.overwrite)
    return 0


if __name__ == "__main__":
    sys.exit(main())
