# Firebase setup

## Local (Emulator Suite) — default
`backend/firebase/firebase.json` runs Auth :9099, Firestore **:8181**, Storage :9199, Functions :5001, UI :4000 for project `demo-homehub`.
Requires JDK 21+ and Node ≥ 22.12 (`source scripts/dev-env.sh`). Functions read dev secrets from the git-ignored
`functions/.secret.local` and params from `functions/.env.local`. Seed: `functions/lib/scripts/seed.js` (refuses to run without emulator env vars).

Apps detect the missing config file and connect to the emulators automatically (Android: `10.0.2.2`; iOS simulator: `127.0.0.1`).

## Production project
1. Create a Firebase project; enable Auth (Email/Password; add federated providers as needed), Firestore (Native), Storage, Cloud Messaging, App Check.
2. Region: functions default to `asia-south1` (`src/index.ts` → `setGlobalOptions`). Use the same region for Firestore if data residency matters.
3. Register apps with bundle/package `com.e404.homehub`; download `google-services.json` → `android/app/`, `GoogleService-Info.plist` → `ios/HomeHub/` (both git-ignored).
4. App Check: Play Integrity (Android), App Attest (iOS). Set `ENFORCE_APP_CHECK=true` once clients are registered.
5. FCM: upload the APNs auth key in project settings; set `FCM_ENABLED=true`.
6. Secrets: `firebase functions:secrets:set HERMES_API_KEY`, `HOMEHUB_MCP_SERVICE_KEY`, `MODEL_API_KEY`. Params: `HERMES_API_URL`, `MODEL_API_BASE_URL`, `MODEL_SIMPLE`, `MODEL_COMPLEX`.
7. Deploy: `firebase deploy --only firestore:rules,firestore:indexes,storage,functions` (see `deployment.md`).
8. Cloud Scheduler is created automatically for `scheduler` (every 15 min).
