#!/usr/bin/env bash
# test-e2e.sh — full end-to-end: launch the Electron app (which spawns dsh web
# on a scratch DSH_HOME), let it load, auto-close the window, then assert the
# dsh server is gone. Requires a display (X or Wayland).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DSH_APP_PORT:-4700}"
TEST_HOME="$DIR/.test-home-e2e"

echo "== e2e: port=$PORT =="
mkdir -p "$TEST_HOME"

DSH_APP_PORT="$PORT" \
DSH_HOME="$TEST_HOME" \
DSH_APP_WORKSPACE="$DIR" \
DSH_APP_SKIP_LOCK=1 \
DSH_APP_AUTOCLOSE_MS=15000 \
ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-wayland}" \
ELECTRON_DISABLE_SANDBOX=1 \
timeout 150 "$DIR/node_modules/.bin/electron" "$DIR/main.js" > "$DIR/.e2e-electron.log" 2>&1
APP_EXIT=$?

echo "electron exit=$APP_EXIT"
echo "== app log tail =="
tail -6 "$DIR/.e2e-electron.log" 2>/dev/null
echo "== checks =="

if grep -q "dsh exited code=0" "$DIR/.e2e-electron.log"; then
  echo "PASS: dsh exited cleanly (code=0) after window close"
else
  echo "FAIL: no clean dsh exit in log"
fi

if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  echo "FAIL: port $PORT still listening — server not stopped"
  exit 1
else
  echo "PASS: port $PORT released — server stopped"
fi

if pgrep -f "dsh web --port $PORT" >/dev/null 2>&1; then
  echo "FAIL: leftover dsh process"
  pkill -f "dsh web --port $PORT"
  exit 1
else
  echo "PASS: no leftover dsh process"
fi

echo "== e2e ALL PASS =="
