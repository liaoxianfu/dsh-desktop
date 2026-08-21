#!/usr/bin/env bash
# test-onboarding-e2e.sh — first-run flow: with no dsh and no download-source
# configured, the app must show the onboarding page; submitting it saves the
# choices (npm source, port) and bootstraps with them.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="4800"
XDG="$DIR/.xdg-config-ob"
TEST_HOME="$DIR/.test-home-ob"
RUNTIME="$DIR/.test-runtime-ob"

echo "== onboarding-e2e: port=$PORT =="
mkdir -p "$XDG/Electron" "$TEST_HOME"
# Keep the test repeatable: a previous run's saved sources would skip the
# first-run page entirely, producing a false failure on subsequent runs.
rm -f "$XDG/Electron/settings.json"
rm -rf "$RUNTIME"

DSH_HOME="$TEST_HOME" \
DSH_APP_PORT="$PORT" \
DSH_APP_SKIP_LOCK=1 \
DSH_APP_AUTO_UPDATE=0 \
DSH_APP_AUTOCLOSE_MS=15000 \
DSH_APP_NO_PROBE=1 \
DSH_APP_RUNTIME_DIR="$RUNTIME" \
DSH_APP_NPM_CACHE="$DIR/.npm-cache" \
DSH_APP_AUTO_ONBOARDING='{"npmRegistry":"cn"}' \
XDG_CONFIG_HOME="$XDG" \
ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-wayland}" \
ELECTRON_DISABLE_SANDBOX=1 \
timeout 300 "$DIR/node_modules/.bin/electron" "$DIR/main.js" > "$DIR/.e2e-ob.log" 2>&1
APP_EXIT=$?

echo "electron exit=$APP_EXIT"
echo "== checks =="

if grep -q "showing first-run onboarding" "$DIR/.e2e-ob.log"; then
  echo "PASS: onboarding page shown"
else
  echo "FAIL: onboarding not shown"
fi

if grep -q "onboarding submitted" "$DIR/.e2e-ob.log"; then
  echo "PASS: onboarding submitted"
else
  echo "FAIL: onboarding not submitted"
fi

if grep -q '"npmRegistry": "cn"' "$XDG/Electron/settings.json" 2>/dev/null; then
  echo "PASS: npmRegistry saved from onboarding"
else
  echo "FAIL: settings not saved"
fi

if grep -q "npmRegistry=https://registry.npmmirror.com/" "$DIR/.e2e-ob.log"; then
  echo "PASS: cn alias resolved to npmmirror"
else
  echo "FAIL: registry not applied"
fi

if grep -q "spawning: .*--port $PORT" "$DIR/.e2e-ob.log"; then
  echo "PASS: dsh spawned on onboarding port $PORT"
else
  echo "FAIL: dsh not on onboarding port"
fi

if grep -q "exited code=0" "$DIR/.e2e-ob.log"; then
  echo "PASS: clean shutdown"
else
  echo "FAIL: no clean shutdown"
fi

echo "== onboarding-e2e done =="
