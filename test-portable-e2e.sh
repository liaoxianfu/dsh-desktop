#!/usr/bin/env bash
# test-portable-e2e.sh — simulate a machine with NO Node.js at all:
# forces the app to download a portable Node runtime, then run npm install,
# native rebuild and dsh itself all on that bundled node.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DSH_APP_PORT:-4780}"
TEST_HOME="$DIR/.test-home-pt"
RUNTIME="$DIR/.test-runtime-pt"

echo "== portable-e2e: port=$PORT =="
mkdir -p "$TEST_HOME" "$DIR/.xdg-config-pt"
rm -rf "$RUNTIME"

DSH_APP_PORT="$PORT" \
DSH_HOME="$TEST_HOME" \
DSH_APP_WORKSPACE="$DIR" \
DSH_APP_SKIP_LOCK=1 \
DSH_APP_AUTOCLOSE_MS=25000 \
DSH_APP_FORCE_DOWNLOAD=1 \
DSH_APP_NO_PROBE=1 \
DSH_APP_FORCE_NODE_DOWNLOAD=1 \
DSH_APP_RUNTIME_DIR="$RUNTIME" \
DSH_APP_NPM_CACHE="$DIR/.npm-cache" \
DSH_APP_NPM_REGISTRY="https://registry.npmmirror.com/" \
XDG_CONFIG_HOME="$DIR/.xdg-config-pt" \
ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-wayland}" \
ELECTRON_DISABLE_SANDBOX=1 \
timeout 600 "$DIR/node_modules/.bin/electron" "$DIR/main.js" > "$DIR/.e2e-pt.log" 2>&1
APP_EXIT=$?

echo "electron exit=$APP_EXIT"
echo "== checks =="

if grep -q "bundled node ready" "$DIR/.e2e-pt.log"; then
  echo "PASS: portable Node downloaded & verified"
else
  echo "FAIL: portable Node not ready"
fi

if [[ -x "$RUNTIME/node/bin/node" ]]; then
  echo "PASS: bundled node binary at $RUNTIME/node/bin/node"
  "$RUNTIME/node/bin/node" --version 2>/dev/null | head -1
else
  echo "FAIL: bundled node binary missing"
fi

if grep -q "(bundled node)" "$DIR/.e2e-pt.log"; then
  echo "PASS: npm ran via bundled node (no system npm needed)"
else
  echo "FAIL: npm did not run via bundled node"
fi

if [[ -x "$RUNTIME/node_modules/.bin/dsh" ]]; then
  echo "PASS: dsh installed into runtime"
else
  echo "FAIL: dsh missing"
fi

if grep -q "exited code=0" "$DIR/.e2e-pt.log"; then
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

echo "== portable-e2e done =="
