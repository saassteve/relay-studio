#!/bin/sh
# Builds the Mac app signed with a Developer ID and notarized by Apple, so it opens
# with a normal double-click.
#
#   npm run desktop:release
#
# Needs, once per Mac:
#   1. Xcode signed in (Settings → Apple Accounts) to a paid Apple Developer team
#      that may sign with a Developer ID. Signing goes through Xcode, which uses a
#      Developer ID certificate from the keychain or the team's cloud-managed one.
#   2. Notary credentials saved under the profile name below:
#        xcrun notarytool store-credentials relay-notary --apple-id YOU --team-id TEAM
#      It asks for an app-specific password from account.apple.com.
#
# Other teams: set RELAY_TEAM_ID to your team ID, and RELAY_NOTARY_PROFILE if you
# saved the credentials under another name.
#
# A release is built from committed code. Set RELAY_RELEASE_DIRTY=1 to build with
# uncommitted changes anyway.
set -eu

PROFILE="${RELAY_NOTARY_PROFILE:-relay-notary}"
TEAM="${RELAY_TEAM_ID:-KDN7P432GJ}"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="$(node -p "require('./package.json').version")"
BUNDLE_ID="org.relayvideo.studio"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/relay-release.XXXXXX")"
# The download being packaged, until it has passed its checks.
UNVERIFIED=""
cleanup() {
  rm -rf "$WORK"
  # A file that failed, or never reached, its checks must not be left in release/
  # looking finished.
  [ -z "$UNVERIFIED" ] || rm -f "$UNVERIFIED.dmg" "$UNVERIFIED.zip"
}
trap cleanup EXIT

fail() {
  printf '\n✗ %s\n' "$1" >&2
  exit 1
}

[ "${RELAY_RELEASE_DIRTY:-}" = "1" ] || git diff --quiet HEAD ||
  fail "There are uncommitted changes to tracked files. Commit or stash them, or set RELAY_RELEASE_DIRTY=1 to release anyway."

xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 ||
  fail "No working notary credentials under \"$PROFILE\". See the top of scripts/release-mac.sh."

echo "→ Building"
npm run build
rm -rf release
npx electron-builder --config electron-builder.config.cjs --mac dir --arm64 --x64 --publish never

cat >"$WORK/export.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>developer-id</string>
<key>teamID</key><string>$TEAM</string>
<key>signingStyle</key><string>automatic</string>
<key>destination</key><string>export</string>
</dict></plist>
EOF

# Every program inside the app must carry the Developer ID signature, or Apple refuses it.
audit() {
  find "$1" -type f -print0 | xargs -0 file | awk -F: '/Mach-O/ { print $1 }' | sort -u |
    while IFS= read -r BIN; do
      codesign -dvv "$BIN" 2>&1 | grep -q "^Authority=Developer ID Application" ||
        fail "Not signed with the Developer ID: $BIN"
    done
}

sign_and_notarize() {
  DIR="$1" ARCH="$2" XARCH="$3"
  APP="release/$DIR/Relay.app"
  [ -d "$APP" ] || fail "Missing $APP"
  ARCHIVE="$WORK/$ARCH/Relay.xcarchive"
  mkdir -p "$ARCHIVE/Products/Applications"
  ditto "$APP" "$ARCHIVE/Products/Applications/Relay.app"
  cat >"$ARCHIVE/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>ApplicationProperties</key><dict>
  <key>ApplicationPath</key><string>Applications/Relay.app</string>
  <key>Architectures</key><array><string>$XARCH</string></array>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>SigningIdentity</key><string>-</string>
  <key>Team</key><string>$TEAM</string>
</dict>
<key>ArchiveVersion</key><integer>2</integer>
<key>CreationDate</key><date>$(date -u +%Y-%m-%dT%H:%M:%SZ)</date>
<key>Name</key><string>Relay</string>
<key>SchemeName</key><string>Relay</string>
</dict></plist>
EOF
  echo "→ Signing the $ARCH app with the Developer ID (through Xcode)"
  xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$WORK/export.plist" \
    -exportPath "$WORK/$ARCH/out" -allowProvisioningUpdates >"$WORK/$ARCH/export.log" 2>&1 || {
    tail -20 "$WORK/$ARCH/export.log" >&2
    fail "Xcode could not sign the $ARCH app."
  }
  SIGNED="$WORK/$ARCH/out/Relay.app"
  codesign --verify --deep --strict "$SIGNED"
  audit "$SIGNED"
  # Xcode has just re-signed the app. Without these it cannot run its JavaScript
  # engine or ask for the camera and microphone.
  codesign -d --entitlements - --xml "$SIGNED" >"$WORK/$ARCH/entitlements.plist" 2>/dev/null ||
    fail "Could not read the entitlements of the signed $ARCH app."
  for KEY in com.apple.security.cs.allow-jit com.apple.security.device.camera \
    com.apple.security.device.audio-input; do
    [ "$(/usr/libexec/PlistBuddy -c "Print :$KEY" "$WORK/$ARCH/entitlements.plist" 2>/dev/null)" = "true" ] ||
      fail "The signed $ARCH app lost its $KEY entitlement."
  done

  echo "→ Notarizing the $ARCH app (Apple usually answers within a few minutes)"
  ditto -c -k --keepParent "$SIGNED" "$WORK/$ARCH/Relay.zip"
  xcrun notarytool submit "$WORK/$ARCH/Relay.zip" --keychain-profile "$PROFILE" --wait |
    tee "$WORK/$ARCH/notary.log"
  grep -q "status: Accepted" "$WORK/$ARCH/notary.log" || fail "Apple did not accept the $ARCH app."
  xcrun stapler staple "$SIGNED"

  rm -rf "$APP"
  ditto "$SIGNED" "$APP"
  spctl --assess --type execute --verbose=2 "$APP"

  echo "→ Packaging the $ARCH download"
  UNVERIFIED="release/Relay-mac-$ARCH"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "release/Relay-mac-$ARCH.zip"
  # The disk image is built around the finished app; nothing is signed again.
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.config.cjs \
    --mac dmg "--$ARCH" --prepackaged "$APP" --publish never
  [ -f "release/Relay-mac-$ARCH.dmg" ] || fail "The $ARCH disk image was not created."

  # The app inside the disk image must still be the notarized one.
  MOUNT="$WORK/$ARCH/mount"
  mkdir -p "$MOUNT"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "release/Relay-mac-$ARCH.dmg"
  xcrun stapler validate "$MOUNT/Relay.app" >/dev/null &&
    spctl --assess --type execute "$MOUNT/Relay.app" || {
    hdiutil detach -quiet "$MOUNT" || true
    fail "The app inside the $ARCH disk image is not the notarized one."
  }
  hdiutil detach -quiet "$MOUNT"
  UNVERIFIED=""
}

sign_and_notarize mac-arm64 arm64 arm64
sign_and_notarize mac x64 x86_64

(cd release && shasum -a 256 Relay-mac-arm64.dmg Relay-mac-x64.dmg Relay-mac-arm64.zip Relay-mac-x64.zip >SHA256SUMS.txt)
echo "✓ Signed, notarized and stapled. Files are in $ROOT/release."
