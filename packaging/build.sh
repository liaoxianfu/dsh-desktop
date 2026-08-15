#!/usr/bin/env bash
# build.sh — build the Arch package (dsh-desktop-*.pkg.tar.zst) with makepkg.
# Copies the app sources next to the PKGBUILD first (makepkg resolves local
# source files by basename), then runs makepkg with deps skipped.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$DIR/.."

for f in main.js preload.js settings.html onboarding.html; do
  cp "$APP/$f" "$DIR/$f"
done

cd "$DIR"
makepkg -f --nodeps "$@"
echo
echo "构建完成: $(ls -1 dsh-desktop-*.pkg.tar.zst 2>/dev/null | tail -1)"
echo "安装: sudo pacman -U dsh-desktop-*.pkg.tar.zst"
