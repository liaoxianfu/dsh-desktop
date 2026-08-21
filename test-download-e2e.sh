#!/usr/bin/env bash
# test-download-e2e.sh — simulate a machine with NO preinstalled dsh:
# force the app through its auto-download path (npm install into a fresh
# runtime dir), let it boot, auto-close, and assert clean shutdown.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DSH_APP_PORT:-4750}"
TEST_HOME="$DIR/.test-home-dl"
RUNTIME="$DIR/.test-runtime"

echo "== download-e2e: port=$PORT, runtime=$RUNTIME =="
mkdir -p "$TEST_HOME" "$DIR/.xdg-config"
rm -rf "$RUNTIME"

DSH_APP_PORT="$PORT" \
DSH_HOME="$TEST_HOME" \
DSH_APP_WORKSPACE="$DIR" \
DSH_APP_SKIP_LOCK=1 \
DSH_APP_AUTO_UPDATE=0 \
DSH_APP_AUTOCLOSE_MS=20000 \
DSH_APP_FORCE_DOWNLOAD=1 \
DSH_APP_NO_PROBE=1 \
DSH_APP_RUNTIME_DIR="$RUNTIME" \
DSH_APP_NPM_CACHE="$DIR/.npm-cache" \
DSH_APP_NPM_REGISTRY="https://registry.npmmirror.com/" \
XDG_CONFIG_HOME="$DIR/.xdg-config" \
ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-wayland}" \
ELECTRON_DISABLE_SANDBOX=1 \
timeout 360 "$DIR/node_modules/.bin/electron" "$DIR/main.js" > "$DIR/.e2e-dl.log" 2>&1
APP_EXIT=$?

echo "electron exit=$APP_EXIT"
echo "== checks =="

if grep -q "npm install" "$DIR/.e2e-dl.log"; then
  echo "PASS: auto-download triggered"
else
  echo "FAIL: no download triggered"
fi

if [[ -x "$RUNTIME/node_modules/.bin/dsh" ]]; then
  echo "PASS: runtime dsh installed at $RUNTIME/node_modules/.bin/dsh"
  "$RUNTIME/node_modules/.bin/dsh" --version 2>/dev/null | head -1
else
  echo "FAIL: runtime dsh missing"
fi

if grep -q "exited code=0" "$DIR/.e2e-dl.log"; then
  echo "PASS: dsh exited cleanly after window close"
else
  echo "FAIL: no clean dsh exit"
fi

if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  echo "FAIL: port $PORT still listening"
  exit 1
else
  echo "PASS: port $PORT released"
fi

echo "== download-e2e done =="
