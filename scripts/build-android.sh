#!/usr/bin/env bash
# Build the Android app. Debug builds need nothing else; release builds create a signing key for you the first time.
#   scripts/build-android.sh run        build a debug APK and install it on a running emulator / plugged-in phone
#   scripts/build-android.sh debug      build the debug APK only
#   scripts/build-android.sh release    build a signed release APK (creates android/keystore.properties + a key on first use)
# The app talks to your Firebase project if config/firebase/google-services.json exists (see scripts/setup.sh),
# otherwise to the local emulators (scripts/quickstart.sh).
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
find_tools
MODE="${1:-run}"
"$(dirname "$0")/doctor.sh" android || exit 1
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"; [[ -z "$SDK" && -d "$HOME/Library/Android/sdk" ]] && SDK="$HOME/Library/Android/sdk"; [[ -z "$SDK" && -d "$HOME/Android/Sdk" ]] && SDK="$HOME/Android/Sdk"
export ANDROID_HOME="$SDK"
[[ -f "$ROOT/android/local.properties" ]] || echo "sdk.dir=$SDK" > "$ROOT/android/local.properties"
ADB="$(command -v adb || echo "$SDK/platform-tools/adb")"

if [[ "${HOMEHUB_LOCAL:-}" != 1 && -f "$ROOT/config/firebase/google-services.json" ]]; then
  cp "$ROOT/config/firebase/google-services.json" "$ROOT/android/app/google-services.json"; ok "Using your Firebase project"
else rm -f "$ROOT/android/app/google-services.json"; info "No Firebase project configured — the app will use the local emulators"; fi

cd "$ROOT/android"
case "$MODE" in
  debug|run)
    step "Building the debug app"; ./gradlew :app:assembleDebug -q || die "Build failed"
    APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"; ok "Built $APK"
    if [[ "$MODE" == run ]]; then
      step "Installing"
      "$ADB" devices | /usr/bin/grep -qE "device$" || die "No Android device found. Start an emulator in Android Studio (Device Manager) or plug in a phone with USB debugging on, then run this again."
      "$ADB" install -r "$APK" >/dev/null && ok "Installed — open HomeHub on the device"
      "$ADB" shell monkey -p com.e404.homehub -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
    fi ;;
  release)
    if [[ ! -f keystore.properties ]]; then
      have keytool || die "keytool not found (it comes with the JDK)"
      step "Creating your signing key (once)"
      PW="$(openssl rand -hex 16)"
      keytool -genkeypair -v -keystore homehub-release.jks -alias homehub -keyalg RSA -keysize 4096 -validity 10000 -storepass "$PW" -keypass "$PW" -dname "CN=HomeHub, O=Self-hosted" >/dev/null 2>&1
      printf 'storeFile=homehub-release.jks\nstorePassword=%s\nkeyAlias=homehub\nkeyPassword=%s\n' "$PW" "$PW" > keystore.properties; chmod 600 keystore.properties
      ok "Created android/homehub-release.jks — back it up; losing it means you can't update the app later"
    fi
    step "Building the release app"; ./gradlew :app:assembleRelease -q || die "Build failed"
    mkdir -p "$ROOT/dist/android"; cp app/build/outputs/apk/release/app-release.apk "$ROOT/dist/android/HomeHub-release.apk"
    ok "Built $ROOT/dist/android/HomeHub-release.apk — copy it to your phone and open it" ;;
  *) die "usage: scripts/build-android.sh [run|debug|release]" ;;
esac
