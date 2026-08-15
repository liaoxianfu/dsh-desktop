#!/usr/bin/env bash
# test-settings-e2e.sh — verify the GUI settings store end to end:
#   1. a pre-written settings.json is read and applied (port, workspace, registry)
#   2. the save path (same one the settings UI triggers) writes the file back
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="4790"
XDG="$DIR/.xdg-config-st"
SETTINGS_FILE="$XDG/Electron/settings.json"
TEST_HOME="$DIR/.test-home-st"

echo "== settings-e2e: port=$PORT =="
mkdir -p "$XDG/Electron" "$TEST_HOME"

# Step 1 — pre-write settings the way the UI would (read path)
cat > "$SETTINGS_FILE" <<EOF
{
  "port": "$PORT",
  "workspace": "$TEST_HOME",
  "npmRegistry": "cn"
}
EOF

DSH_HOME="$TEST_HOME" \
DSH_APP_SKIP_LOCK=1 \
DSH_APP_AUTOCLOSE_MS=15000 \
XDG_CONFIG_HOME="$XDG" \
ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-wayland}" \
ELECTRON_DISABLE_SANDBOX=1 \
timeout 120 "$DIR/node_modules/.bin/electron" "$DIR/main.js" > "$DIR/.e2e-st.log" 2>&1
APP_EXIT=$?

echo "electron exit=$APP_EXIT"
echo "== checks =="

if grep -q "settings: port=$PORT" "$DIR/.e2e-st.log"; then
  echo "PASS: settings.json port applied ($PORT)"
else
  echo "FAIL: settings port not applied"
fi

if grep -q "workspace=$TEST_HOME" "$DIR/.e2e-st.log"; then
  echo "PASS: settings.json workspace applied"
else
  echo "FAIL: settings workspace not applied"
fi

if grep -q "npmRegistry=https://registry.npmmirror.com/" "$DIR/.e2e-st.log"; then
  echo "PASS: npmRegistry=cn resolved to npmmirror"
else
  echo "FAIL: registry alias not applied"
fi

if grep -q "spawning: .*--port $PORT" "$DIR/.e2e-st.log"; then
  echo "PASS: dsh spawned on settings port $PORT"
else
  echo "FAIL: dsh not spawned on settings port"
fi

if grep -q "exited code=0" "$DIR/.e2e-st.log"; then
  echo "PASS: clean shutdown"
else
  echo "FAIL: no clean shutdown"
fi

# Step 2 — write path (same function the settings UI calls via IPC)
DSH_APP_TEST_SAVE_SETTINGS='{"port":"4791","npmRegistry":"cn"}' \
DSH_HOME="$TEST_HOME" \
DSH_APP_SKIP_LOCK=1 \
DSH_APP_AUTOCLOSE_MS=10000 \
XDG_CONFIG_HOME="$XDG" \
ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-wayland}" \
ELECTRON_DISABLE_SANDBOX=1 \
timeout 90 "$DIR/node_modules/.bin/electron" "$DIR/main.js" > "$DIR/.e2e-st2.log" 2>&1

if grep -q "test: settings saved via saveSettings()" "$DIR/.e2e-st2.log"; then
  echo "PASS: save path executed"
else
  echo "FAIL: save path not executed"
fi

if grep -q '"port": "4791"' "$SETTINGS_FILE" 2>/dev/null; then
  echo "PASS: settings.json updated to port 4791"
else
  echo "FAIL: settings.json not updated"
fi

echo "== settings-e2e done =="
