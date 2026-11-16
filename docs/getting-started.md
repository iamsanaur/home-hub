# Getting started

Two ways in. Start with the first — it needs no accounts and costs nothing.

> **Windows:** use WSL 2 (Ubuntu). The scripts are bash. The Android app builds there; the iOS app needs a Mac.

## 1. Try it on your computer (about 5 minutes)

```bash
git clone https://github.com/iamsanaur/home-hub.git && cd home-hub
scripts/quickstart.sh          # installs, starts local Firebase emulators, loads a sample household
scripts/build-android.sh run   # Android: build and install on a running emulator
scripts/run-ios.sh             # iOS (Mac): build and open in the iPhone simulator
```

Sign in with `owner@homehub.test` and password `homehub-demo-1` (also `adult@`, `staff@`, `child@` — the same
household seen through four roles). Everything works except the assistant's multi-step requests, which need a model key.

Handy: `scripts/quickstart.sh status | stop | reseed` · `scripts/doctor.sh` tells you what's missing on your machine.

A physical phone can't reach your computer's emulators. Use an Android emulator for this path, or go to step 2.

## 2. Run it on your own Firebase project

```bash
scripts/setup.sh
```

It walks you through nine steps and skips anything already done, so it is safe to re-run if it stops:

| # | What happens | Who does it |
|---|---|---|
| 1 | Checks your tools (Node, Java, …) and tells you how to install anything missing | script |
| 2 | Signs you in to Firebase (opens a browser once) | you click |
| 3 | Creates your Firebase project (or uses one you name) | script |
| 4 | Switches on **Blaze** billing — links a billing account you already have, or opens the page and waits | you confirm |
| 5 | Enables the Google APIs, creates Firestore, the storage bucket, and email/password sign-in | script |
| 6 | Registers the Android and iOS apps and downloads their config | script |
| 7 | Writes your settings and stores secrets; asks for an AI model key (optional) | you paste |
| 8 | Deploys the database rules, indexes and cloud functions (5–10 minutes) | script |
| 9 | Points both apps at your project | script |

Then `scripts/build-android.sh run` (or `release` for a signed APK to send to family) and `scripts/run-ios.sh`.

Useful flags: `--dry-run` (show, change nothing) · `--yes` (accept defaults) · `--project my-id` · `--skip-deploy`.

### What it costs
Firebase's **Blaze** plan is pay-as-you-go with a free monthly allowance for most services. A single household normally
stays within it, but you pay for usage beyond it, plus whatever your AI model provider charges. Set a **budget alert**
(<https://console.cloud.google.com/billing>) so nothing surprises you. The scripts never enable billing without asking.

### The AI model key (optional)
The assistant's multi-step requests need a model provider. [OpenRouter](https://openrouter.ai/keys) is the easy choice: one
key, many models, some free. Paste it when asked, or later:

```bash
firebase functions:secrets:set MODEL_API_KEY --project <your-project-id>
```

Without it the apps still do everything else, and simple commands ("add milk", "what's due today") still work.

### Before you share the app with other people
- **Sign-ups are open.** Anyone with the app can create an account in your project. Enforce **App Check** (Play Integrity
  on Android, App Attest on iOS; set `ENFORCE_APP_CHECK=true` in `backend/firebase/functions/.env.<project>` and redeploy)
  or disable sign-ups in the Firebase console while you test.
- Add a **budget alert** (above).
- Keep `android/homehub-release.jks` safe: it is the key that signs your app. Lose it and you can't update the app.

## 3. Optional extras

| Want | How |
|---|---|
| **Server assistant** (scheduled jobs, works when no phone is open) | Docker + a Cloudflare tunnel on your own domain — [`hermes-setup.md`](hermes-setup.md), then `scripts/hermes-docker.sh up` |
| **iOS push notifications** | Apple developer account → APNs key → upload in Firebase → Project settings → Cloud Messaging |
| **A real iPhone** | Open `ios/HomeHub.xcodeproj` in Xcode and choose your Apple team under Signing |
| **Alexa** | [`alexa.md`](alexa.md) |
| **Telegram / Google Calendar / Home Assistant** | Settings → Connections inside the app |
| **Your own app id** | Change `com.e404.homehub` in `android/app/build.gradle.kts`, `ios/project.yml` and the scripts, then run `scripts/setup.sh` again |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `doctor.sh` says Java is too old | Emulators need Java 21+: `brew install openjdk` (Mac) or `sudo apt install openjdk-21-jdk` |
| Emulators don't start | A port is busy (4000, 5001, 8181, 9099, 9199) — stop what's using it; logs are in `.logs/emulators.log` |
| "Billing isn't enabled yet" | Finish at the link the script prints, then run `scripts/setup.sh` again |
| "Couldn't create the project" | The id is taken (they're global) — run with `--project another-id` |
| Storage / sign-in step asks you to click in the console | The API refused it for your account type; do what it says, then re-run |
| Deploy fails | The message names the cause; fix it and re-run — completed steps are skipped |
| Android build can't find the SDK | Install Android Studio once; the script finds the SDK automatically |
| App says it can't reach the server | Local mode needs `scripts/quickstart.sh` running; cloud mode needs a finished `scripts/setup.sh` |

## Starting over
`scripts/quickstart.sh stop` removes the local emulators. To remove a cloud project entirely, delete it in the Firebase
console (Project settings → Delete project); nothing else is left behind except the files in `config/` and `.firebaserc`,
which are private to your machine.
