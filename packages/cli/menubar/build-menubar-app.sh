#!/usr/bin/env bash
# Build Iterate.app — a minimal menu-bar bundle from the two Swift files here.
# No Xcode project: swiftc compiles, then we hand-assemble the .app (LSUIElement
# so it's menu-bar-only). Run from anywhere.
#
#   ./build-menubar-app.sh [output-dir]      (default: ./build)
#
# Then: open "<output-dir>/Iterate.app"
# First launch reads ~/.config/iterate/menubar.json for the CLI + project;
# see menubar/README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/build}"
app="$out/Iterate.app"
macos="$app/Contents/MacOS"

rm -rf "$app"
mkdir -p "$macos"

echo "Compiling (swiftc)…"
swiftc -O -o "$macos/Iterate" "$here/Iterate.swift" "$here/IterateIcon.swift"

cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Iterate</string>
  <key>CFBundleDisplayName</key><string>Iterate</string>
  <key>CFBundleIdentifier</key><string>com.iterate.app</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Iterate</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signing gives LaunchServices a stable identity for the bundle.
codesign --force --deep --sign - "$app" >/dev/null 2>&1 || true

echo "Built: $app"
echo "Launch: open \"$app\""
