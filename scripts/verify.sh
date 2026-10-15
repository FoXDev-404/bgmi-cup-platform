#!/usr/bin/env bash
# ============================================================================
#  One-command verification for the BGMI project (bash; git-bash on Windows).
#
#  Runs, in order:
#    1. python tests/test_api.py / test_admin.py / test_broadcast.py
#       (each hosts its own throw-away server + DB)
#    2. npx playwright test            (specs host their own server + DB)
#    3. the nine stage scripts in tests/e2e/, each against a freshly seeded
#       throw-away DB on http://127.0.0.1:8090
#
#  Nothing here touches data/registrations.db, .env or the live 8080 demo
#  server; the throw-away DB lives in $TMPDIR/opencode/bgmi-verify.
#  Exits 0 only when everything is green.
# ============================================================================
set -u
cd "$(dirname "$0")/.."

VDIR="${TMPDIR:-/tmp}/opencode/bgmi-verify"
mkdir -p "$VDIR/uploads"
FAILED=""
SERVER_PID=""

# Phases A/B below (python suites + specs) each host their OWN throw-away
# server+DB. Clear every variable that could point them at the 8090 instance
# instead - BASE switches the suites into remote mode, which would share its
# rate-limit buckets and its database with the stage run.
unset BASE PORT BGMI_DB BGMI_UPLOADS BGMI_ADMIN_USER BGMI_ADMIN_PASSWORD \
      VERIFY_ADMIN_USER VERIFY_ADMIN_PASSWORD BGMI_RATE_LIMIT_TEST
BASE=http://127.0.0.1:8090

stop_server() {
  if command -v taskkill >/dev/null 2>&1 && command -v netstat >/dev/null 2>&1; then
    for pid in $(netstat -ano 2>/dev/null | grep -E ":8090[[:space:]]" \
        | grep LISTENING | awk '{print $5}' | sort -u); do
      taskkill //F //PID "$pid" >/dev/null 2>&1 || true
    done
  fi
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; fi
  sleep 1
}

start_server() {
  (PORT=8090 python server.py > "$VDIR/server.log" 2>&1 & echo $! > "$VDIR/server.pid")
  SERVER_PID="$(cat "$VDIR/server.pid" 2>/dev/null || true)"
  for _ in $(seq 1 50); do
    if python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8090/api/live/state',timeout=1)" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "[verify] server did not come up - see $VDIR/server.log"
  return 1
}

reset_env() {
  stop_server
  rm -f "$VDIR/verify.db" "$VDIR/verify.db-wal" "$VDIR/verify.db-shm"
  rm -rf "$VDIR/uploads"
  mkdir -p "$VDIR/uploads"
  python scripts/seed_demo.py >/dev/null || return 1
  python scripts/create_admin.py >/dev/null || return 1
  start_server || return 1
}

echo "==== python suites ===="
python tests/test_api.py || FAILED="$FAILED test_api"
python tests/test_admin.py || FAILED="$FAILED test_admin"
python tests/test_broadcast.py || FAILED="$FAILED test_broadcast"

echo "==== playwright specs ===="
npx playwright test --reporter=line || FAILED="$FAILED playwright"

# Phase C env: the stage scripts run against the one shared 8090 instance on
# purpose (see reset_env at the top).
export BGMI_DB="$VDIR/verify.db"
export BGMI_UPLOADS="$VDIR/uploads"
export BGMI_ADMIN_USER=verifyadmin
export BGMI_ADMIN_PASSWORD=verify-pass-2026
export VERIFY_ADMIN_USER=verifyadmin
export VERIFY_ADMIN_PASSWORD=verify-pass-2026

for S in public-site registration-flows status-lookup admin-flows \
         matches-flows control-desk scoring-check overlays security-a11y; do
  if ! reset_env; then exit 1; fi
  echo "==== stage $S ===="
  node "tests/e2e/$S.js" "$BASE" || FAILED="$FAILED $S"
done
stop_server

if [ -n "$FAILED" ]; then
  echo
  echo "FAILED:$FAILED"
  exit 1
fi
echo
echo "ALL GREEN"
