"""Create or update the admin account for the approval panel.

Usage:
    setx BGMI_ADMIN_USER "yourname"
    setx BGMI_ADMIN_PASSWORD "a-strong-password"
    python scripts/create_admin.py

Or run it and it will prompt for a username/password (never stored in code).
Re-running with the same username resets that account's password.
"""
import getpass
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402


def main():
    username = (os.environ.get("BGMI_ADMIN_USER") or "").strip()
    password = os.environ.get("BGMI_ADMIN_PASSWORD") or ""
    if not username:
        username = input("Admin username: ").strip()
    if not password:
        password = getpass.getpass("Admin password (min 8 chars): ")
    if len(password) < 8:
        print("Password must be at least 8 characters.")
        return 1

    pw_hash, salt = server.hash_password(password)
    with server.DB_LOCK:
        conn = server.db()
        try:
            row = conn.execute("SELECT id FROM admin_users WHERE username = ?",
                               (username,)).fetchone()
            if row:
                conn.execute(
                    "UPDATE admin_users SET pass_hash = ?, pass_salt = ? "
                    "WHERE id = ?", (pw_hash, salt, row["id"]))
                print("Updated existing admin '%s'." % username)
            else:
                conn.execute(
                    "INSERT INTO admin_users (username, pass_hash, pass_salt, "
                    "created_at) VALUES (?,?,?,?)",
                    (username, pw_hash, salt, server.now_iso()))
                print("Created admin '%s'." % username)
            conn.commit()
        finally:
            conn.close()
    print("Sign in at /admin")
    return 0


if __name__ == "__main__":
    sys.exit(main())
