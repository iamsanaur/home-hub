#!/usr/bin/env bash
# Deploy HomeHub's backend to the real Firebase project (alias "prod" in backend/firebase/.firebaserc).
# Requires the Blaze plan: Cloud Functions, Secret Manager, the Storage bucket and Firestore TTL policies
# all need billing enabled.
#
# Secrets: internal ones are generated once; integrations that aren't set up yet get the placeholder
# "unset", which the backend treats as "not configured". Existing secret values are never overwritten.
# Replace a placeholder later with:  firebase functions:secrets:set MODEL_API_KEY --project prod
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/dev-env.sh" >/dev/null
cd "$ROOT/backend/firebase"
P=prod

has_secret() { firebase functions:secrets:access "$1" --project "$P" >/dev/null 2>&1; }
set_secret() { printf '%s' "$2" | firebase functions:secrets:set "$1" --data-file - --project "$P" --force >/dev/null; echo "  set $1"; }

echo "Secrets"
for s in HOMEHUB_MCP_SERVICE_KEY ALEXA_FORWARDER_SECRET; do
  has_secret "$s" && echo "  keep $s" || set_secret "$s" "$(openssl rand -hex 32)"
done
for s in MODEL_API_KEY HERMES_API_KEY ALEXA_OAUTH_CLIENT_SECRET LWA_CLIENT_SECRET; do
  has_secret "$s" && echo "  keep $s" || set_secret "$s" "unset"
done

echo "Building functions"
(cd functions && npm ci --silent && npm run build --silent)

echo "Deploying"
firebase deploy --only "firestore,storage,functions" --project "$P" --non-interactive "$@"
