#!/bin/sh
# Installs the latest Relay release into /Applications.
#   curl -fsSL https://raw.githubusercontent.com/saassteve/relay-studio/main/install.sh | sh
set -eu

URL="https://github.com/saassteve/relay-studio/releases/latest/download/Relay-mac-arm64.dmg"
APP="/Applications/Relay.app"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Relay's installer is for macOS. On other systems, see the README to run from source." >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "This build is for Apple Silicon Macs (M1 or later). Intel Macs can run Relay from source." >&2
  exit 1
fi

TMP="$(mktemp -d)"
MOUNT="$TMP/mount"
cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "→ Downloading Relay…"
curl -fL --progress-bar "$URL" -o "$TMP/Relay.dmg"

echo "→ Installing to /Applications…"
mkdir -p "$MOUNT"
hdiutil attach "$TMP/Relay.dmg" -nobrowse -readonly -mountpoint "$MOUNT" -quiet
if [ -d "$APP" ]; then
  osascript -e 'quit app "Relay"' 2>/dev/null || true
  rm -rf "$APP"
fi
ditto "$MOUNT/Relay.app" "$APP"

# Relay isn't notarized by Apple yet. Clearing the download flag lets it open
# without the "unidentified developer" prompt. The app's code is open on GitHub.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "✓ Relay is installed. Opening it now…"
open "$APP"
