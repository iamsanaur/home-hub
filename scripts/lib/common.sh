#!/usr/bin/env bash
# Shared helpers for the HomeHub setup scripts. Source it; don't run it. Works on macOS and Linux (bash 3.2+).
ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
FB_DIR="$ROOT/backend/firebase"
FN_DIR="$FB_DIR/functions"
LOG_DIR="$ROOT/.logs"
REGION="asia-south1"   # Functions and Firestore region (compiled into the apps and functions)

if [[ -t 1 ]]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; Z=$'\033[0m'; else B=; D=; G=; Y=; R=; C=; Z=; fi
step()  { printf '\n%s%s▸ %s%s\n' "$B" "$C" "$*" "$Z"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$Z" "$*"; }
info()  { printf '  %s%s%s\n' "$D" "$*" "$Z"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$Z" "$*"; }
die()   { printf '\n%s✗ %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }

# Non-interactive mode: HOMEHUB_YES=1 or no terminal. Every prompt then takes its default.
interactive() { [[ -t 0 && "${HOMEHUB_YES:-}" != 1 ]]; }
ask() { # ask "Question" default  -> echoes the answer
  local q="$1" d="${2:-}" a
  if ! interactive; then printf '%s' "$d"; return; fi
  read -r -p "  $q${d:+ [$d]}: " a </dev/tty; printf '%s' "${a:-$d}"
}
confirm() { # confirm "Question" [default y|n]
  local d="${2:-y}" a
  if ! interactive; then [[ "$d" == y ]]; return; fi
  read -r -p "  $1 [$( [[ $d == y ]] && echo Y/n || echo y/N )]: " a </dev/tty
  a="${a:-$d}"; [[ "$a" =~ ^[Yy] ]]
}
pause() { interactive && read -r -p "  Press Enter to continue… " _ </dev/tty || true; }
open_url() { info "Opening $1"; (open "$1" 2>/dev/null || xdg-open "$1" 2>/dev/null || true) >/dev/null 2>&1; }

have() { command -v "$1" >/dev/null 2>&1; }
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }   # ver_ge 22.12.1 22.12 -> true

# Make Node 22+ and JDK 21+ available when they are installed somewhere not on PATH (nvm, Homebrew, /usr/lib/jvm).
find_tools() {
  local n j
  if have node && ver_ge "$(node -v | tr -d v)" 22.12; then :; else
    n="$(ls -d "$HOME"/.nvm/versions/node/v22.* "$HOME"/.nvm/versions/node/v2[3-9].* 2>/dev/null | sort -V | tail -1)"
    [[ -n "$n" ]] && export PATH="$n/bin:$PATH"
  fi
  if ! have java || ! java_ok; then
    for j in /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
             /usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home /usr/lib/jvm/java-21-openjdk* /usr/lib/jvm/temurin-21* /usr/lib/jvm/java-2[2-9]*; do
      if [[ -x "$j/bin/java" ]]; then export JAVA_HOME="$j"; export PATH="$j/bin:$PATH"; break; fi
    done
  fi
}
java_ok() { have java && [[ "$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')" -ge 21 ]] 2>/dev/null; }

# Firebase CLI: use the installed one, or fetch it on demand with npx so nobody has to install it globally.
fb() {
  if have firebase; then firebase "$@"; else npx --yes firebase-tools@15 "$@"; fi
}

prod_project() { # project id from backend/firebase/.firebaserc ("prod" alias), empty if not set up
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["projects"].get("prod",""))' "$FB_DIR/.firebaserc" 2>/dev/null || true
}
