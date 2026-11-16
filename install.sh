#!/bin/sh
# Installs the latest Relay release.
#   curl -fsSL https://raw.githubusercontent.com/saassteve/relay-studio/main/install.sh | sh
set -eu

# Everything runs inside main, called on the last line, so a download that is cut
# off part-way can never run half of this script.
main() {
REPO="saassteve/relay-studio"
BASE="https://github.com/$REPO/releases/latest/download"
# The Apple Developer team that signs official builds.
TEAM="KDN7P432GJ"

fail() {
  printf '\n✗ %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] ||
  fail "This installer is for macOS. On Windows or Linux, run Relay from source: https://github.com/$REPO#run-from-source"

MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MAJOR" -ge 13 ] || fail "Relay needs macOS 13 Ventura or later (this Mac has $(sw_vers -productVersion))."

# Apple Silicon reports arm64; a shell running under Rosetta still reports the real chip here.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
else
  ARCH="x64"
fi
FILE="Relay-mac-$ARCH.dmg"

# Prefer /Applications; fall back to ~/Applications for accounts without admin rights.
if [ -w /Applications ] && { [ ! -e /Applications/Relay.app ] || [ -w /Applications/Relay.app ]; }; then
  DEST="/Applications"
else
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi
APP="$DEST/Relay.app"

TMP="$(mktemp -d)"
MOUNT="$TMP/mount"
# The half-installed copy, once there is one.
STAGE=""
cleanup() {
  hdiutil detach "$MOUNT" -quiet -force 2>/dev/null || true
  rm -rf "$TMP"
  [ -z "$STAGE" ] || rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

printf '→ Downloading Relay for %s Macs…\n' "$([ "$ARCH" = arm64 ] && echo 'Apple Silicon' || echo 'Intel')"
curl -fL --retry 3 --progress-bar "$BASE/$FILE" -o "$TMP/$FILE" ||
  fail "Download failed. Check your connection, or download manually: https://github.com/$REPO/releases/latest"

printf '→ Verifying…\n'
if curl -fsL --retry 3 "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt"; then
  EXPECTED="$(awk -v f="$FILE" '$2 == f { print $1 }' "$TMP/SHA256SUMS.txt")"
  ACTUAL="$(shasum -a 256 "$TMP/$FILE" | awk '{ print $1 }')"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] ||
    fail "The download didn't match its published checksum. Nothing was installed. Please try again."
else
  fail "Couldn't fetch the release checksums to verify the download. Nothing was installed."
fi

printf '→ Installing to %s…\n' "$DEST"
mkdir -p "$MOUNT"
hdiutil attach "$TMP/$FILE" -nobrowse -readonly -noautoopen -mountpoint "$MOUNT" -quiet ||
  fail "Couldn't open the downloaded disk image."
# Copy next to the destination first, then swap, so a failed copy never
# leaves you without a working app.
STAGE="$DEST/.Relay.installing.app"
rm -rf "$STAGE"
ditto "$MOUNT/Relay.app" "$STAGE" || {
  rm -rf "$STAGE"
  fail "Couldn't copy Relay into $DEST. Is the disk full?"
}
# Relay is signed with its Developer ID and notarized by Apple. Make sure this copy
# is the real thing before it replaces anything: the signature must chain to Apple
# through a Developer ID certificate issued to Relay's team.
codesign --verify --deep --strict \
  -R='anchor apple generic and certificate leaf[subject.OU] = "'"$TEAM"'" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' \
  "$STAGE" 2>/dev/null || {
  rm -rf "$STAGE"
  fail "This download isn't signed by Relay's developer. Nothing was installed."
}
if pgrep -xq Relay; then
  printf '→ Closing the running copy of Relay…\n'
  osascript -e 'quit app "Relay"' >/dev/null 2>&1 || true
  i=0
  while pgrep -xq Relay && [ "$i" -lt 20 ]; do
    sleep 0.5
    i=$((i + 1))
  done
  if pgrep -xq Relay; then
    rm -rf "$STAGE"
    fail "Relay is still running. Quit it, then run this installer again. Nothing was changed."
  fi
fi
rm -rf "$APP" || {
  rm -rf "$STAGE"
  fail "Couldn't replace the Relay already in $DEST. macOS may be blocking Terminal from changing apps: allow it in System Settings > Privacy & Security > App Management, then run this installer again."
}
mv "$STAGE" "$APP" || fail "Couldn't move Relay into place in $DEST."

printf '✓ Relay is installed in %s. Opening it now…\n' "$DEST"
open "$APP"
}

main "$@"
