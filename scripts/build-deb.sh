#!/bin/bash
# 本地工具直打 deb：无网络依赖，用 dpkg-deb 组装
# 前置：release/linux-unpacked（amd64）或 release/linux-arm64-unpacked（arm64）已存在
# 用法：bash scripts/build-deb.sh [版本，默认 1.0.0] [架构 amd64|arm64，默认 amd64]
set -e
VER="${1:-1.0.0}"
ARCH="${2:-amd64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUF=""
[ "$ARCH" = "arm64" ] && SUF="-arm64"
UNPACKED="$ROOT/release/linux${SUF}-unpacked"
OUT="$ROOT/release/1b1t-server-gui_${VER}_${ARCH}.deb"

[ -d "$UNPACKED" ] || { echo "缺少 $UNPACKED，先跑: npx electron-builder --linux dir"; exit 1; }
[ -f "$ROOT/resources/icon.png" ] || { echo "缺少图标，先跑: node scripts/gen-icons.mjs"; exit 1; }

BUILD="$ROOT/release/deb-root"
rm -rf "$BUILD"
mkdir -p "$BUILD/DEBIAN" "$BUILD/opt/1b1t-server-gui" \
         "$BUILD/usr/share/applications" "$BUILD/usr/share/icons/hicolor/512x512/apps"

cp -a "$UNPACKED/." "$BUILD/opt/1b1t-server-gui/"
# chrome-sandbox 需要 setuid root
chmod 4755 "$BUILD/opt/1b1t-server-gui/chrome-sandbox"

cat > "$BUILD/DEBIAN/control" <<EOF
Package: 1b1t-server-gui
Version: ${VER}
Section: games
Priority: optional
Architecture: ${ARCH}
Maintainer: 1B1T <admin@1b1t.cn>
Homepage: https://www.1b1t.cn
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0
Description: 1b1t Server - Minecraft 一键开服工具
 1B1T 一键开服工具（GUI 版）：向导开服、服务器管理、实时日志与控制台。
EOF

cat > "$BUILD/usr/share/applications/1b1t-server-gui.desktop" <<'EOF'
[Desktop Entry]
Name=1b1t Server
Comment=1b1t 一键开服工具（GUI）
Exec=/opt/1b1t-server-gui/1b1t-server-gui %U
Icon=1b1t-server-gui
Terminal=false
Type=Application
Categories=Game;
StartupWMClass=1b1t-server-gui
EOF

cp "$ROOT/resources/icon.png" "$BUILD/usr/share/icons/hicolor/512x512/apps/1b1t-server-gui.png"
dpkg-deb --build "$BUILD" "$OUT"
echo "deb 已生成: $OUT"
