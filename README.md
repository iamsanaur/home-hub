# HomeHub AI — *Your Agentic Household Manager*

Two native apps — **Android** (Kotlin, Jetpack Compose) and **iOS** (Swift, SwiftUI) — on a shared **Firebase** backend,
with the **Hermes** agent running on the phone (*Hermes Mobile*) and on the server (fallback for scheduled jobs and
future voice/channels). Liquid Glass on both platforms. See `docs/architecture.md`.

```
android/            Kotlin/Compose app (com.e404.homehub) — Room outbox, WorkManager, Hermes Mobile (Kotlin)
ios/                SwiftUI app (com.e404.homehub) — SwiftData outbox, BGTasks, Hermes Mobile (Swift); xcodegen project.yml
backend/firebase/   firestore.rules · storage.rules · indexes · functions/ (gateway, MCP, scheduler, triggers, tests)
backend/api-gateway, backend/mcp-server   docs pointing at the implementations inside functions/
agents/hermes/      homehub-hermes profile config, SOUL.md, 8 skills (shared by server Hermes and Hermes Mobile)
shared/schemas      JSON Schemas generated from the server's zod contracts
docs/               architecture, setup, security, deployment, design system docs
tests/evidence/     screenshots captured from the emulator/simulators
```

## Prerequisites
- Node ≥ 22.12 (firebase-admin 14), Firebase CLI 15, **JDK 21+** for the emulators (JDK 17 for Gradle is fine)
- Android SDK 37, Gradle 9.8 (wrapper included)
- Xcode 27 with iOS 26+ simulators, `xcodegen`
- Optional: Hermes Agent v0.21.2 (`5eb99eb2`) for the server runtime

`source scripts/dev-env.sh` selects Node 22 and JDK 21+ for backend work.

## Run everything locally (no credentials needed)

```bash
# 1. Backend
source scripts/dev-env.sh
cd backend/firebase/functions && npm ci && npm run build
cd .. && firebase emulators:start --project demo-homehub     # Firestore on :8181 (8080 is often taken)
# in another shell — sample household, password homehub-demo-1:
cd backend/firebase/functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  GCLOUD_PROJECT=demo-homehub node lib/scripts/seed.js
#   owner@homehub.test · adult@homehub.test · staff@homehub.test · child@homehub.test

# 2. Android (emulator reaches the host at 10.0.2.2)
cd android && ./gradlew :app:installDebug

# 3. iOS
cd ios && xcodegen generate && open HomeHub.xcodeproj      # run on an iOS 26+ simulator
```

The assistant needs a model provider for multi-step requests: set `MODEL_API_BASE_URL`/`MODEL_API_KEY` for the
Functions emulator (`backend/firebase/functions/.env.local` + `.secret.local`). Without it, deterministic commands
("add milk", "what's due today") and every non-AI feature still work; agent requests show "model is not configured".

## Tests
```bash
cd backend/firebase/functions
npx vitest run test/unit                                    # 24 unit tests
npm run emulators:test                                      # rules + integration on the emulators (53)
cd android && ./gradlew :app:testDebugUnitTest              # 14 JVM tests (Hermes Mobile, sync policy, money)
cd ios && xcodebuild test -scheme HomeHub -destination 'platform=iOS Simulator,name=iPhone 17 Pro'   # 6 unit + UI test
```

## Status
See `IMPLEMENTATION_STATUS.md` for what is done, verified, partial and blocked.
