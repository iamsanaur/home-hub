#!/usr/bin/env bash
# Try HomeHub on your own computer in a few minutes. No accounts, no keys, no cost.
#   scripts/quickstart.sh           install, start the local Firebase emulators and load a sample household
#   scripts/quickstart.sh status    is it running?
#   scripts/quickstart.sh stop      stop the emulators
#   scripts/quickstart.sh reseed    wipe the local data and load the sample household again
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
find_tools
mkdir -p "$LOG_DIR"
PIDFILE="$LOG_DIR/emulators.pid"
UI=http://127.0.0.1:4000

up() { curl -fsS --max-time 2 "http://127.0.0.1:8181/" >/dev/null 2>&1; }
pid_alive() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
wait_up() { local i; for i in $(seq 1 90); do up && curl -fsS --max-time 2 "$UI" >/dev/null 2>&1 && return 0; pid_alive || return 1; sleep 2; done; return 1; }

seed() {
  step "Loading the sample household"
  ( cd "$FN_DIR" && FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 GCLOUD_PROJECT=demo-homehub node lib/scripts/seed.js ) >"$LOG_DIR/seed.log" 2>&1 \
    || { tail -15 "$LOG_DIR/seed.log"; die "Seeding failed (log: .logs/seed.log)"; }
  ok "Sample household loaded"
}

stop() {
  pkill -INT -f "emulators:start --project demo-homehub" 2>/dev/null || true
  for _ in $(seq 1 15); do up || break; sleep 1; done
  rm -f "$PIDFILE"
  if up; then warn "The emulators are still shutting down — try again in a few seconds"; else ok "Emulators stopped"; fi
}

summary() {
  cat <<EOT

${B}${G}HomeHub is running locally.${Z}

  Emulator dashboard   $UI
  Sample logins        owner@homehub.test · adult@homehub.test · staff@homehub.test · child@homehub.test
  Password             homehub-demo-1

${B}Next: open an app${Z}
  Android   ${C}scripts/build-android.sh run${Z}      builds and installs on a running emulator or a plugged-in phone*
  iOS       ${C}scripts/run-ios.sh${Z}                builds and opens it in the iPhone simulator (Mac only)

  * a physical phone can't reach your computer's emulators — use an Android emulator, or follow docs/getting-started.md to use your own Firebase project.

The assistant's multi-step requests need a model key; everything else works now. Stop with ${C}scripts/quickstart.sh stop${Z}.
EOT
}

case "${1:-up}" in
  status) if up; then ok "Emulators are running ($UI)"; else warn "Emulators are not running — run scripts/quickstart.sh"; fi; exit 0 ;;
  stop) stop; exit 0 ;;
  reseed) up || die "Start the emulators first: scripts/quickstart.sh"; curl -fsS -X DELETE "http://127.0.0.1:8181/emulator/v1/projects/demo-homehub/databases/(default)/documents" >/dev/null; seed; summary; exit 0 ;;
  up) ;;
  *) die "usage: scripts/quickstart.sh [status|stop|reseed]" ;;
esac

"$(dirname "$0")/doctor.sh" local || exit 1
if up; then ok "Emulators already running"; else
  step "Installing the backend (first time takes a minute or two)"
  ( cd "$FN_DIR" && npm ci --no-audit --no-fund --silent && npm run build --silent ) >"$LOG_DIR/build.log" 2>&1 || { tail -20 "$LOG_DIR/build.log"; die "Backend build failed (log: .logs/build.log)"; }
  ok "Backend built"
  step "Starting the local Firebase emulators"
  cd "$FB_DIR"
  nohup bash -c 'source "'"$ROOT"'/scripts/lib/common.sh"; find_tools; exec bash -c "$(declare -f fb have); fb emulators:start --project demo-homehub"' >"$LOG_DIR/emulators.log" 2>&1 </dev/null &
  echo $! >"$PIDFILE"; cd "$ROOT"
  if wait_up; then ok "Emulators are up"; else tail -20 "$LOG_DIR/emulators.log"; die "The emulators didn't start (log: .logs/emulators.log). A port may be in use: 4000, 5001, 8181, 9099, 9199."; fi
  seed
fi
summary
