#!/usr/bin/env bash
# Build the iOS app and open it in the iPhone simulator (Mac with Xcode only).
# Uses your Firebase project if config/firebase/GoogleService-Info.plist exists, otherwise the local emulators.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
"$(dirname "$0")/doctor.sh" ios || exit 1
cd "$ROOT/ios"
if [[ "${HOMEHUB_LOCAL:-}" != 1 && -f "$ROOT/config/firebase/GoogleService-Info.plist" ]]; then cp "$ROOT/config/firebase/GoogleService-Info.plist" HomeHub/GoogleService-Info.plist; ok "Using your Firebase project"
else rm -f HomeHub/GoogleService-Info.plist; info "No Firebase project configured — the app will use the local emulators"; fi
step "Generating the Xcode project"; xcodegen generate >/dev/null
SIM="${HOMEHUB_SIMULATOR:-$(xcrun simctl list devices available | /usr/bin/grep -E "iPhone [0-9]+( Pro)? \(" | tail -1 | sed -E 's/^ *(.*) \(([0-9A-F-]{36})\).*/\2/')}"
[[ -n "$SIM" ]] || die "No iPhone simulator found. Open Xcode → Settings → Platforms and install an iOS runtime."
xcrun simctl boot "$SIM" 2>/dev/null || true; open -a Simulator
step "Building (first time takes a few minutes)"
xcodebuild -project HomeHub.xcodeproj -scheme HomeHub -destination "id=$SIM" -derivedDataPath build/dd -quiet build || die "Build failed"
APP="$(find build/dd/Build/Products -maxdepth 2 -name 'HomeHub.app' | head -1)"
xcrun simctl install "$SIM" "$APP" && xcrun simctl launch "$SIM" com.e404.homehub >/dev/null && ok "HomeHub is open in the simulator"
