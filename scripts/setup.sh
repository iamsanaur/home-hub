#!/usr/bin/env bash
# Guided setup of HomeHub on YOUR OWN Firebase project. It does everything the command line can do for you, asks
# before anything that costs money or changes your account, and tells you exactly what to click for the few steps
# only a person can do. Safe to run again: finished steps are detected and skipped.
#
#   scripts/setup.sh                      interactive
#   scripts/setup.sh --project my-id      use (or create) this project id
#   scripts/setup.sh --yes                accept every default (also enables billing linking and email sign-in)
#   scripts/setup.sh --dry-run            show what would happen; changes nothing
#   scripts/setup.sh --skip-deploy        prepare the project and app config, but don't deploy the backend yet
# Optional environment: HOMEHUB_PROJECT_ID, HOMEHUB_OPENROUTER_KEY (assistant model key), HOMEHUB_BILLING_ACCOUNT.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
find_tools

PROJECT="${HOMEHUB_PROJECT_ID:-}"; DRY=0; SKIP_DEPLOY=0
while [[ $# -gt 0 ]]; do case "$1" in
  --project) PROJECT="${2:?project id}"; shift 2 ;;
  --yes|-y) export HOMEHUB_YES=1; shift ;;
  --dry-run) DRY=1; shift ;;
  --skip-deploy) SKIP_DEPLOY=1; shift ;;
  -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "Unknown option $1 (try --help)" ;;
esac; done
run() { if [[ "$DRY" == 1 ]]; then info "[dry-run] $*"; else "$@"; fi; }
gcp() { node "$ROOT/scripts/lib/gcp.mjs" "$@"; }

cat <<EOT
${B}HomeHub setup${Z}
This will set up the backend (database, sign-in, file storage, serverless functions) in your own Google/Firebase
account and connect the Android and iOS apps to it. About 10–15 minutes, mostly waiting for the deploy.
EOT
[[ "$DRY" == 1 ]] && warn "Dry run: nothing will be changed."

# ---------------------------------------------------------------- 1. tools
step "1/9  Checking your computer"
"$ROOT/scripts/doctor.sh" cloud

# ---------------------------------------------------------------- 2. login
step "2/9  Signing in to Firebase"
if fb login:list 2>&1 | /usr/bin/grep -q "Logged in as"; then ok "Already signed in: $(fb login:list 2>&1 | /usr/bin/grep -o 'Logged in as .*' | head -1)"
else
  info "A browser window will open. Sign in with the Google account that should own the project."
  [[ "$DRY" == 1 ]] || fb login
fi

# ---------------------------------------------------------------- 3. project
step "3/9  Choosing your Firebase project"
[[ -z "$PROJECT" ]] && PROJECT="$(prod_project)"
[[ "$PROJECT" == "your-firebase-project-id" ]] && PROJECT=""
if [[ -z "$PROJECT" ]]; then
  info "Project ids are global and permanent. Use lowercase letters, numbers and dashes."
  PROJECT="$(ask "Project id to create or use" "homehub-$(openssl rand -hex 3)")"
fi
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "'$PROJECT' isn't a valid project id (6–30 characters, lowercase letters, digits, dashes)."
if [[ "$DRY" == 1 ]]; then info "[dry-run] would use or create project $PROJECT"
elif fb projects:list --json 2>/dev/null | python3 -c 'import json,sys;p=sys.argv[1];sys.exit(0 if any(x.get("projectId")==p for x in json.load(sys.stdin).get("result",[])) else 1)' "$PROJECT"; then ok "Using your existing project $PROJECT"
else
  info "Creating project $PROJECT…"
  fb projects:create "$PROJECT" --display-name "HomeHub AI" >/dev/null || die "Couldn't create the project. The id may already be taken — pick another with --project."
  ok "Created $PROJECT"
fi
if [[ "$DRY" != 1 ]]; then
  printf '{\n  "projects": {\n    "default": "demo-homehub",\n    "prod": "%s"\n  }\n}\n' "$PROJECT" > "$FB_DIR/.firebaserc"; ok "Saved to backend/firebase/.firebaserc (private, not committed)"
fi
CONSOLE="https://console.firebase.google.com/project/$PROJECT"

# ---------------------------------------------------------------- 4. billing
step "4/9  Billing (Blaze plan)"
cat <<EOT
  Cloud Functions need Google's pay-as-you-go ${B}Blaze${Z} plan. It includes a free monthly allowance; a small household
  usually stays inside it, but you pay for anything beyond. Set a budget alert so there are no surprises.
EOT
BILL="$(gcp billing-status "$PROJECT" 2>/dev/null || echo unknown)"
if [[ "$DRY" == 1 ]]; then info "[dry-run] billing is: $BILL"
elif [[ "$BILL" == enabled ]]; then ok "Billing is on"
else
  ACCTS="$(gcp billing-accounts 2>/dev/null || true)"; N=$(printf '%s' "$ACCTS" | /usr/bin/grep -c . || true)
  if [[ "$N" -ge 1 ]]; then
    ACCT="${HOMEHUB_BILLING_ACCOUNT:-$(printf '%s\n' "$ACCTS" | head -1 | cut -f1)}"
    NAME="$(printf '%s\n' "$ACCTS" | /usr/bin/grep "^$ACCT" | cut -f2)"
    if confirm "Link billing account “${NAME:-$ACCT}” to $PROJECT now?" y; then gcp billing-link "$PROJECT" "$ACCT" >/dev/null && ok "Billing linked"; fi
  fi
  if [[ "$(gcp billing-status "$PROJECT" 2>/dev/null || echo unknown)" != enabled ]]; then
    warn "Billing still needs to be switched on (a person has to do this once)."
    info "Click ‘Upgrade’ / ‘Blaze’ and add a payment method:"; open_url "$CONSOLE/usage/details"
    for _ in $(seq 1 60); do
      [[ "$(gcp billing-status "$PROJECT" 2>/dev/null || echo unknown)" == enabled ]] && break
      interactive || die "Billing isn't enabled yet: $CONSOLE/usage/details — then run this script again."
      printf '  waiting for billing… (Ctrl-C to stop, re-run any time)\r'; sleep 10
    done
    [[ "$(gcp billing-status "$PROJECT" 2>/dev/null || echo unknown)" == enabled ]] || die "Billing isn't enabled yet. Finish it at $CONSOLE/usage/details and run this again."
    ok "Billing is on"
  fi
fi

# ---------------------------------------------------------------- 5. services
step "5/9  Turning on the Google services"
if [[ "$DRY" == 1 ]]; then info "[dry-run] would enable Firestore, Functions, Storage, Auth, Secret Manager, Scheduler…"
else
  gcp enable-apis "$PROJECT" >/dev/null && ok "Cloud APIs enabled"
  if fb firestore:databases:create "(default)" --location "$REGION" --project "$PROJECT" >/tmp/hh-fs.out 2>&1 || /usr/bin/grep -qi "already exists" /tmp/hh-fs.out; then ok "Firestore database ready ($REGION)"
  else cat /tmp/hh-fs.out; die "Couldn't create the Firestore database."; fi
  R="$(gcp storage-bucket "$PROJECT" 2>&1)" && ok "File storage ready" || { warn "$R"; info "Open $CONSOLE/storage and click ‘Get started’ (choose $REGION), then run this again."; die "Storage isn't ready."; }
  if confirm "Turn on email + password sign-in for your project?" y; then
    R="$(gcp auth-email "$PROJECT" 2>&1)" && ok "Email sign-in enabled" || { warn "$R"; info "Open $CONSOLE/authentication/providers → Email/Password → Enable, then run this again."; die "Sign-in isn't enabled."; }
  else warn "Skipped — nobody can sign in until you enable Email/Password at $CONSOLE/authentication/providers"; fi
fi

# ---------------------------------------------------------------- 6. apps
step "6/9  Registering the Android and iOS apps"
mkdir -p "$ROOT/config/firebase"
if [[ "$DRY" == 1 ]]; then info "[dry-run] would register com.e404.homehub for Android and iOS and download their config files"
else
  appid() { fb apps:list --project "$PROJECT" --json 2>/dev/null | python3 -c 'import json,sys;pl,ns=sys.argv[1:3];print(next((a["appId"] for a in json.load(sys.stdin).get("result",[]) if a.get("platform")==pl and a.get("namespace")==ns),""))' "$1" "com.e404.homehub"; }
  AND="$(appid ANDROID)"; [[ -n "$AND" ]] || { fb apps:create ANDROID "HomeHub Android" --package-name com.e404.homehub --project "$PROJECT" >/dev/null; AND="$(appid ANDROID)"; }
  IOS="$(appid IOS)";     [[ -n "$IOS" ]] || { fb apps:create IOS "HomeHub iOS" --bundle-id com.e404.homehub --project "$PROJECT" >/dev/null; IOS="$(appid IOS)"; }
  [[ -n "$AND" && -n "$IOS" ]] || die "Couldn't register the apps. Add them at $CONSOLE/settings/general and re-run."
  fb apps:sdkconfig ANDROID "$AND" --project "$PROJECT" --out "$ROOT/config/firebase/google-services.json" >/dev/null
  fb apps:sdkconfig IOS "$IOS" --project "$PROJECT" --out "$ROOT/config/firebase/GoogleService-Info.plist" >/dev/null
  ok "App config saved to config/firebase/ (private, not committed)"
fi

# ---------------------------------------------------------------- 7. settings + secrets
step "7/9  Settings and secrets"
ENVF="$FN_DIR/.env.$PROJECT"
if [[ "$DRY" == 1 ]]; then info "[dry-run] would write functions/.env.$PROJECT and store secrets in Secret Manager"
else
  if [[ ! -f "$ENVF" ]]; then
    cat > "$ENVF" <<EOT
# Non-secret settings for your project. Secrets live in Secret Manager (set by scripts/setup.sh).
PUBLIC_GATEWAY_URL=https://$REGION-$PROJECT.cloudfunctions.net/api
HERMES_API_URL=
ENFORCE_APP_CHECK=false
FCM_ENABLED=true
MODEL_API_BASE_URL=https://openrouter.ai/api/v1
MODEL_SIMPLE=google/gemini-2.5-flash-lite
MODEL_COMPLEX=google/gemini-2.5-flash
HERMES_PROVIDER_SIMPLE=openrouter
HERMES_MODEL_SIMPLE=google/gemini-2.5-flash-lite
HERMES_PROVIDER_COMPLEX=openrouter
HERMES_MODEL_COMPLEX=google/gemini-2.5-flash
EOT
    ok "Wrote functions/.env.$PROJECT"
  else ok "Settings file already exists (kept)"; fi
  KEY="${HOMEHUB_OPENROUTER_KEY:-}"
  if [[ -z "$KEY" ]] && ! (cd "$FB_DIR" && fb functions:secrets:access MODEL_API_KEY --project "$PROJECT" 2>/dev/null | /usr/bin/grep -qv '^unset$'); then
    cat <<EOT

  The assistant needs an AI model key. The easy option is OpenRouter (https://openrouter.ai/keys — one key, many models,
  some free). You can skip this now and everything except the assistant's multi-step requests still works.
EOT
    if interactive; then read -r -s -p "  Paste your OpenRouter key (or press Enter to skip): " KEY </dev/tty; echo; fi
  fi
  if [[ -n "$KEY" ]]; then printf '%s' "$KEY" | (cd "$FB_DIR" && fb functions:secrets:set MODEL_API_KEY --data-file - --project "$PROJECT" --force >/dev/null) && ok "Model key stored in Secret Manager"; else info "No model key set — add it later: firebase functions:secrets:set MODEL_API_KEY --project $PROJECT"; fi
fi

# ---------------------------------------------------------------- 8. deploy
step "8/9  Deploying the backend (5–10 minutes)"
if [[ "$DRY" == 1 || "$SKIP_DEPLOY" == 1 ]]; then info "Skipped."
else
  "$ROOT/scripts/deploy-prod.sh" 2>&1 | sed 's/^/  /' || die "Deploy failed. Read the message above, fix it, and run this script again — it picks up where it left off."
  H="https://$REGION-$PROJECT.cloudfunctions.net/api/v1/health"
  for _ in 1 2 3 4 5 6; do curl -fsS --max-time 10 "$H" >/dev/null 2>&1 && break; sleep 5; done
  if curl -fsS --max-time 10 "$H" >/dev/null 2>&1; then ok "Backend is live: $H"; else warn "The backend didn't answer yet ($H). It can take a minute — check $CONSOLE/functions"; fi
fi

# ---------------------------------------------------------------- 9. apps
step "9/9  Connecting the apps"
if [[ "$DRY" == 1 ]]; then info "[dry-run] would copy the config into the Android and iOS projects"
else
  cp "$ROOT/config/firebase/google-services.json" "$ROOT/android/app/google-services.json"
  cp "$ROOT/config/firebase/GoogleService-Info.plist" "$ROOT/ios/HomeHub/GoogleService-Info.plist"
  have xcodegen && (cd "$ROOT/ios" && xcodegen generate >/dev/null) || true
  ok "Both apps now point at your project"
fi

cat <<EOT

${B}${G}Done.${Z}  Your project: ${C}$PROJECT${Z}

${B}Run the apps${Z}
  Android   ${C}scripts/build-android.sh run${Z}        install on an emulator or plugged-in phone
            ${C}scripts/build-android.sh release${Z}    a signed APK you can send to family phones
  iOS       ${C}scripts/run-ios.sh${Z}                  simulator (a real iPhone needs your Apple developer team in Xcode)

${B}Before sharing the app with others${Z}
  • Anyone with the app can create an account. To limit that, enforce App Check (see docs/getting-started.md) or
    disable sign-ups in $CONSOLE/authentication/settings.
  • Set a budget alert so costs can never surprise you: https://console.cloud.google.com/billing
  • Optional extras (server assistant, Alexa, push on iOS) are in docs/getting-started.md.
EOT
