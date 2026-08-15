#!/usr/bin/env bash
# dsh-desktop setup: pin the dsh binary path; optionally install a .desktop icon.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v dsh >/dev/null 2>&1; then
  echo "$(command -v dsh)" > "$DIR/dsh-path.txt"
  echo "dsh → $(command -v dsh)"
elif [[ -n "${DSH_BIN:-}" ]]; then
  echo "$DSH_BIN" > "$DIR/dsh-path.txt"
  echo "dsh → $DSH_BIN (DSH_BIN)"
else
  echo "错误: 未找到 dsh。请先安装 @deepseek-ai/dsh，或设置 DSH_BIN 环境变量。" >&2
  exit 1
fi

if [[ "${1:-}" == "--desktop" ]]; then
  ELECTRON="$DIR/node_modules/.bin/electron"
  if [[ ! -x "$ELECTRON" ]]; then
    echo "错误: electron 未安装，请先运行 npm install" >&2
    exit 1
  fi
  mkdir -p "$HOME/.local/share/applications"
  DESKTOP_FILE="$HOME/.local/share/applications/deepseek-harness.desktop"
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=DeepSeek Harness
Comment=DeepSeek Harness Web GUI — 点击启动，关闭窗口即停止
Exec="$ELECTRON" "$DIR/main.js"
Terminal=false
Categories=Development;Utility;
EOF
  chmod +x "$DESKTOP_FILE"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo ".desktop 已安装 → $DESKTOP_FILE"
fi

echo "完成。启动方式: npm start  或  $DIR/node_modules/.bin/electron $DIR/main.js"
