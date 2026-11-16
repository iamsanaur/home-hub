#!/usr/bin/env bash
# Switch both native apps between the local Emulator Suite and the real Firebase project.
#   scripts/use-firebase.sh prod       copy config/firebase/* into the apps (real project your-firebase-project-id)
#   scripts/use-firebase.sh emulator   remove them again (apps fall back to demo-homehub on the emulators)
# The config files are gitignored. Rebuild the apps after switching.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/config/firebase"
ANDROID="$ROOT/android/app/google-services.json"
IOS="$ROOT/ios/HomeHub/GoogleService-Info.plist"

case "${1:-}" in
  prod)
    [[ -f "$SRC/google-services.json" && -f "$SRC/GoogleService-Info.plist" ]] || { echo "Missing $SRC — download with: firebase apps:sdkconfig" >&2; exit 1; }
    cp "$SRC/google-services.json" "$ANDROID"
    cp "$SRC/GoogleService-Info.plist" "$IOS"
    echo "Apps now use the real Firebase project. (iOS: set HOMEHUB_USE_EMULATORS=1 in the scheme to point the real config at the emulators.)"
    ;;
  emulator)
    rm -f "$ANDROID" "$IOS"
    echo "Apps now use the local Emulator Suite (demo-homehub)."
    ;;
  *) echo "usage: $0 prod|emulator" >&2; exit 2 ;;
esac
(cd "$ROOT/ios" && xcodegen generate >/dev/null) && echo "Regenerated the Xcode project."
