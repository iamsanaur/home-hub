#!/usr/bin/env bash
# Checks that this computer has what HomeHub needs and tells you exactly how to install anything missing.
#   scripts/doctor.sh [local|cloud|android|ios|all]      (default: local)
set -uo pipefail
source "$(dirname "$0")/lib/common.sh"
find_tools
WHAT="${1:-local}"
MISSING=0
case "$(uname -s)" in
  Darwin) OS=mac ;; Linux) OS=linux ;; *) OS=other ;;
esac
hint() { # hint "mac cmd" "linux cmd" "other"
  case "$OS" in mac) echo "$1" ;; linux) echo "$2" ;; *) echo "${3:-see the tool website}" ;; esac
}
check() { # check <ok?> "label" "found" "install hint" [required=1]
  local good="$1" label="$2" found="$3" how="$4" req="${5:-1}"
  if [[ "$good" == 1 ]]; then printf '  %s✓%s %-22s %s%s%s\n' "$G" "$Z" "$label" "$D" "$found" "$Z"
  elif [[ "$req" == 1 ]]; then printf '  %s✗%s %-22s %smissing%s\n      → %s\n' "$R" "$Z" "$label" "$R" "$Z" "$how"; MISSING=1
  else printf '  %s–%s %-22s %snot found (optional)%s\n      → %s\n' "$Y" "$Z" "$label" "$D" "$Z" "$how"; fi
}
want() { [[ "$WHAT" == all || "$WHAT" == "$1" || ( "$1" == local && "$WHAT" == cloud ) ]]; }

step "Checking this computer ($(uname -s))"
# --- everything needs Node ---
if have node && ver_ge "$(node -v | tr -d v)" 22.12; then check 1 "Node.js ≥ 22.12" "$(node -v)" ""
else check 0 "Node.js ≥ 22.12" "" "$(hint 'brew install node@22' 'install Node 22 from https://nodejs.org or with nvm: nvm install 22' 'https://nodejs.org')"; fi
have npm && check 1 "npm" "$(npm -v)" "" || check 0 "npm" "" "comes with Node.js"
if have firebase; then check 1 "Firebase CLI" "$(firebase --version 2>/dev/null | tail -1)" ""
elif have npx; then check 1 "Firebase CLI" "will be fetched on demand with npx" ""
else check 0 "Firebase CLI" "" "npm install -g firebase-tools"; fi
have python3 && check 1 "python3" "$(python3 --version 2>&1)" "" || check 0 "python3" "" "$(hint 'brew install python' 'sudo apt install python3' 'https://python.org')"

# --- the local emulators need Java 21+ ---
if want local || want cloud || [[ "$WHAT" == android ]]; then
  if java_ok; then check 1 "Java ≥ 21 (emulators)" "$(java -version 2>&1 | head -1)" ""
  else check 0 "Java ≥ 21 (emulators)" "" "$(hint 'brew install openjdk' 'sudo apt install openjdk-21-jdk' 'https://adoptium.net')"; fi
fi
if want cloud; then
  have curl && check 1 "curl" "" "" || check 0 "curl" "" "$(hint 'preinstalled on macOS' 'sudo apt install curl')"
  have openssl && check 1 "openssl" "" "" || check 0 "openssl" "" "$(hint 'preinstalled on macOS' 'sudo apt install openssl')"
fi
# --- Android ---
if [[ "$WHAT" == android || "$WHAT" == all ]]; then
  SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"; [[ -z "$SDK" && -d "$HOME/Library/Android/sdk" ]] && SDK="$HOME/Library/Android/sdk"; [[ -z "$SDK" && -d "$HOME/Android/Sdk" ]] && SDK="$HOME/Android/Sdk"
  [[ -n "$SDK" && -d "$SDK" ]] && check 1 "Android SDK" "$SDK" "" || check 0 "Android SDK" "" "install Android Studio (https://developer.android.com/studio); it installs the SDK. Then re-run this."
  have adb || [[ -x "$SDK/platform-tools/adb" ]] && check 1 "adb" "" "" "" || check 0 "adb" "" "Android Studio → SDK Manager → Platform-Tools" 0
fi
# --- iOS ---
if [[ "$WHAT" == ios || "$WHAT" == all ]]; then
  if [[ "$OS" != mac ]]; then check 0 "macOS (for iOS)" "" "iOS apps can only be built on a Mac"
  else
    have xcodebuild && xcodebuild -version >/dev/null 2>&1 && check 1 "Xcode" "$(xcodebuild -version 2>/dev/null | head -1)" "" || check 0 "Xcode" "" "install Xcode from the App Store, open it once, then: sudo xcode-select -s /Applications/Xcode.app"
    have xcodegen && check 1 "XcodeGen" "" "" || check 0 "XcodeGen" "" "brew install xcodegen"
  fi
fi
# --- optional extras ---
if [[ "$WHAT" == all || "$WHAT" == cloud ]]; then
  have docker && check 1 "Docker (optional)" "for the server assistant" "" 0 || check 0 "Docker (optional)" "" "only needed for the optional server Hermes: https://docs.docker.com/get-docker/" 0
fi

echo
if [[ "$MISSING" == 0 ]]; then printf '%s%sAll set.%s\n' "$B" "$G" "$Z"; exit 0; else printf '%s%sInstall the items marked ✗, then run this again.%s\n' "$B" "$R" "$Z"; exit 1; fi
