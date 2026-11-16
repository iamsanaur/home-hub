# Implementation status — 16 Nov 2026

Legend: **Done** = implemented and exercised by tests or on an emulator/simulator · **Partial** = implemented, gaps listed · **Blocked** = needs credentials/accounts · **Not started**.

## Test evidence (latest run)
| Suite | Result |
|---|---|
| Backend unit (`test/unit`) — incl. plugin manifest validator, webhook HMAC, Alexa request signatures, Alexa state reporting | 34 / 34 pass |
| Firestore rules (`test/rules/firestore`) — incl. cross-household isolation | 19 / 19 pass |
| Addendum rules (`test/rules/phase1`) — server-only connection data, safety devices hidden from children/staff, personal model accounts, audit visibility, cross-household isolation | 6 / 6 pass |
| Addendum integration (`test/integration/phase1`) — plugin consent/connect, verified device state, unlock approval, kill switch/pause, automations (loop guard, cooldown, preview), signed webhooks (replay/stale/bad signature), bridge pairing, channel pairing, BYO model accounts (OpenRouter PKCE, household key), Alexa linking/Smart Home/custom skill/ChangeReport | 19 / 19 pass |
| Alexa Lambda forwarder (`backend/alexa/lambda`) | 2 / 2 pass |
| Storage rules | 4 / 4 pass |
| Service integration (households, recurrence, meals→shopping, budgets, bill payments, approvals, calendar, briefing, memory, scheduler de-dup) | 18 / 18 pass |
| MCP contract + gateway→Hermes(server)→MCP end-to-end | 8 / 8 pass |
| Hermes Mobile device-run protocol (model proxy, grant scoping, budgets, power-saver tier cap, job claim vs server fallback) | 4 / 4 pass |
| Android JVM (Hermes Mobile loop, stream parsing, offline intents, power policy, conflict policy, money, dates) | 14 / 14 pass |
| iOS XCTest (Swift Hermes Mobile loop, chunk parsing, power, money, conflict policy) | 6 / 6 pass |
| iOS XCUITest sign-in + navigation (iPhone 17 Pro, iPad Pro 11") | pass on both |
| iOS XCUITest Connections flow against emulators (iPhone 17 Pro): connect Demo devices, switch a lamp and see the device-verified result, open Automations, Channels/Alexa, Agents/skills, Activity, Privacy | pass |
| Manual on Android emulator (API 35) | sign-in, dashboard, AI offline command, agent request → honest "model not configured", Manage, Family, Insights, Finance; **offline task completion → reconnect → synced → server trigger wrote history + next recurrence** |

Screenshots: `tests/evidence/android/`, `tests/evidence/ios/` (Connections: `tests/evidence/ios/connections/`).

## Production (`your-firebase-project-id`, deployed 16 Nov 2026)
- Firebase project **HomeHub AI** (`your-firebase-project-id`, Blaze), Android + iOS apps registered (`com.e404.homehub`); configs in gitignored `config/firebase/` — switch the apps with `scripts/use-firebase.sh prod|emulator`.
- Deployed with `scripts/deploy-prod.sh`: Firestore (`asia-south1`) rules + indexes incl. TTL, Storage bucket `your-firebase-project-id.firebasestorage.app` + rules, functions `api`, `mcp`, `hooks`, `alexa`, `scheduler`, `onTaskCompleted`, `onPantryWritten` (all `asia-south1`). Email/password sign-in on.
- Platform model account: OpenRouter key in Secret Manager (`MODEL_API_KEY`), models `google/gemini-2.5-flash-lite` (quick) / `google/gemini-2.5-flash` (planning), set in `backend/firebase/functions/.env.your-firebase-project-id`.
- **Production smoke test passed** (throwaway account, deleted afterwards): health, household creation, catalog, gateway status, model accounts, on-device agent run → **live LLM call through the model proxy to OpenRouter** → completion with measured usage (15 tokens), account deletion. Anonymous Firestore reads are denied.
- **Both apps run against production** (Android emulator API 35, iPhone 17 Pro simulator; QA account in gitignored `config/firebase/qa-account.txt`). iOS `ProductionSmokeTests` passes: sign-in, notification permission, **full on-device agent run against the live model (6 tool calls via MCP, "Completed · verified")**, Connections. Evidence: `tests/evidence/ios/prod/`, `tests/evidence/android/prod/`.
- **Push:** Android verified end to end (server → FCM → tray, HomeHub channel/icon). iOS registers an FCM token; delivery needs the APNs key uploaded to Firebase and a physical iPhone. Both apps now ask for notification permission from a Home card (they never asked before); iOS registers for remote notifications and has the `aps-environment` entitlement.
- Alexa: HomeHub-side linking values generated (`config/alexa/linking-values.txt`, gitignored; client secret in Secret Manager). Waiting on the Amazon skill + AWS Lambda.
- **Server Hermes in Docker** (`homehub-hermes`, v0.21.2 @ 5eb99eb2, data in `~/.hermes-homehub`, Cloudflare quick tunnel) — production gateway health reports `agent: available`; a server run called `get_low_stock_items` on the live MCP server and completed (14,092 in / 296 out tokens). See `docs/hermes-setup.md`.
- **Android visual parity with iOS** (16 Nov): iOS type scale (34/20/17/17/15), iOS-style nav bar (glass back circle, action capsule, large title that hands over to an inline title), tab bar kept on pushed screens with the owning tab selected, filled tab icons with neutral selection pill, chevron rows, segmented control (≤4 options) / capsule chips, SF-Symbol-matched icons, Home header, capsule AI suggestions and send disc, "+" in the toolbar instead of a FAB. iOS gained Android's Home section shortcuts and the "Smart home and connections" group. Remaining differences: Android keeps its conversation-history button and model chip on the AI screen; fonts are Roboto (San Francisco can't ship on Android).
- Found and fixed in production: three collection-group queries (membership by uid/status, agent workflows by status) had no index — the emulator doesn't enforce indexes. Added to `firestore.indexes.json`.

## Automatic spending capture (16 Nov 2026)
- **Android**: opt-in notification listener (Settings → Automatic spending, with disclosure) for UPI, banking and SMS apps; an on-device filter means only completed-payment text leaves the phone; WorkManager upload with retry.
- **iOS**: App Intent **Log bank message** for a Shortcuts personal automation ("Message contains debited → Run immediately"); same on-device filter; setup steps in Settings.
- **Server** (`finance/spendCapture.ts`): deterministic parser (integer paise; ignores OTPs, failed, scheduled, due and request messages), dedupe by UPI reference or amount+merchant+10-min window, flags payments already entered by hand, suggested category from household-learned then default merchant rules, "To review" inbox; confirm books via `recordExpense` (idempotent) and learns the category; dismiss expires after 30 days. Raw message text is never stored; account/card and reference numbers reduced to last 4.
- Verified in production: Android listener → upload → inbox → confirm → Finance (₹640 Zepto, Groceries); iOS review/confirm UI test (₹385 Uber India, Transport). Tests: 15 parser + 3 integration + 1 rules (backend), 2 Android JVM, 2 iOS unit.
- **Limitation — Android 15+**: the system redacts notifications it classifies as sensitive ("Sensitive notification content hidden") for non-system listeners. Bank SMS alerts carrying account/reference numbers are often redacted; UPI app notifications ("Paid ₹640 to Zepto") come through. Bank-SMS coverage on Android needs Account Aggregator (partner) later.

## Home Assistant bridge (16 Nov 2026) — Phase 2
- Plugin `homehub.homeassistant` (`plugins/builtins/homeAssistant.ts`): household's own Home Assistant over HTTPS (Nabu Casa or own domain) with a long-lived token in Secret Manager. Imports light, switch, fan, climate, lock, door/window/motion binary sensors and temperature/humidity sensors; rooms from Home Assistant areas; °F→°C. Same tool names as other device plugins, so app control, automations, Alexa and approvals work unchanged; unlock stays approval-only and children/staff can't use locks. Every write is read back before HomeHub reports success; the scheduler re-syncs every 15 minutes.
- Tests: 5 emulator tests against a fake Home Assistant (import/mapping, verified control, unlock approval, background sync, https-only and bad token). Deployed; listed as available in the production catalog. Not yet tried against a real Home Assistant instance.

## Updates — 16 Nov 2026 (later)
- **Edit your name**: Settings → Your profile on both apps; `PATCH /v1/me` updates the sign-in profile, user profile and every household membership (accounts created without a name showed their email).
- **Assistant tool entries**: tool calls collapse to one line ("Used 5 tools" / the tool running now); expand to see each tool once with a count, remove entries or clear all (display only — nothing is undone).
- **Recent activity (Home)**: owners and administrators can delete single entries or clear the feed (`DELETE /v1/households/:hid/activity[/:logId]`); runs in progress are kept; the security audit trail is permanent and records each deletion. iOS Home gained the Recent activity section.
- **Assistant reliability**: provider 429/5xx retried with backoff and a cross-provider fallback model (phone proxy `MODEL_FALLBACK`; server Hermes `fallback_providers`).
- **Hermes hosting**: HomeHub's own Cloudflare named tunnel `homehub` → `https://hermes.example.com` (permanent), runs in Docker with `restart: unless-stopped`; the Mac and Docker must be running. `scripts/hermes-docker.sh up|status|down`.
- Android release APK built and signed (`dist/android/`, keystore in `config/release/` — back it up).

## Done
- Repo structure, branding from `brand-logo.png` (iOS AppIcon, Android adaptive + monochrome icon, splash, in-app mark).
- Firestore + Storage security rules (deny by default, membership/role checks, finance privacy, staff isolation, immutable fields, version bumps, append-only ledgers, server-only agent data). Indexes.
- Cloud Functions: API gateway (ID token + App Check, rate limits), households/invitations/roles, autonomy + emergency pause, approvals with server-side execution of stored parameters, bill payments (idempotent, append-only), meal plan → shopping list (pantry-aware, known-price estimates only), budgets in integer minor units, reports, deterministic daily briefing, notifications (prefs, quiet hours, dedupe, FCM token cleanup), memory (scope, correction, deletion, export), account export/deletion, scheduler with leases + exclusive slots, recurrence trigger.
- HomeHub MCP server: the 31 tools from the brief; grant-scoped (no household IDs accepted), autonomy policy, approvals, idempotency, audit; accepts server Hermes (service key) and Hermes Mobile (user ID token + grant for the same user).
- **Hermes Mobile** (agent runtime on the phone) in Kotlin and Swift with identical behaviour: progressive skill loading from the shared SKILL.md files, iteration/tool budgets, parallel read-only calls, output truncation, structural context compaction, bounded delegation, grant injected by runtime (never shown to the model), battery governor (critical/saver/normal; background only when charging + cool + unmetered), zero-model offline commands.
- Model proxy: provider key server-side, server-chosen model, tier is a ceiling, per-workflow call/token budgets, measured usage ledger.
- Server Hermes: `homehub-hermes` profile config (shell/files/browser/web/memory/session-search disabled), SOUL, 8 skills, install script; adapter verified against Hermes v0.21.2 `/v1/runs` + SSE.
- Android app: design tokens, Liquid Glass (RenderEffect blur via Haze on API 31+, tinted fallback below, solid under high-contrast), floating glass nav / glass rail ≥840dp, all primary and secondary screens, onboarding (resumable), offline outbox with conflict screen, WorkManager sync + Hermes job worker, FCM service.
- iOS app: tokens, native iOS 26 Liquid Glass (system tab bar, `glassEffect` composer/undo bar, Reduce Transparency fallback), all primary and secondary screens, onboarding, SwiftData outbox + sync engine, BGTask jobs, APNs/FCM wiring.
- Both apps drop a dead session (account deleted/disabled, refresh token revoked) at launch and return to sign-in; offline launches keep the session.

### Addendum (`docs/HOMEHUB_MASTER_PROMPT_OPENCLAW_ALEXA_FIREBASE_NATIVE.md`)
Decision recorded: keep both agent runtimes (phone + gateway-orchestrated server).
- **Phase 1 — gateway foundation: Done.** Plugin manifest schema + validator + SDK, plugin registry/runtime (consent, scopes, schema-validated tool input, kill switch, pause), audit events, approvals for physical-safety actions, addendum §10 collections with server-only rules. Built-in plugins: Demo devices (simulated), signed webhooks, AI provider accounts (OpenRouter sign-in, API-key providers). Every other catalog entry is listed as **Planned**, never Available.
- **Native Connections area on both apps: Done.** Connections hub, AI model accounts, Integrations catalog (connect/test/pause/disconnect), Devices (control with read-back verification, Alexa exposure per room/device), Automations (create, enable, preview, run, history, delete), Channels and Alexa, Agents and skills, Activity and audit, Privacy. Android `ConnectScreens.kt`; iOS `Features/Connect.swift`, reached from Manage → Connections (adults only).
- **Phase 2 — partial.** Automation engine done (schedule, device state, pantry low, bill due, webhook triggers; loop guard, cooldown, daily cap). Bridge pairing with one-time codes done; bridge devices are read-only. **Not built:** Home Assistant/Matter control, Google/Outlook calendar and Gmail read-only connectors, app voice.
- **Phase 3 — Alexa: implemented, mocked only.** OAuth account linking with rotating refresh tokens, Smart Home discovery/control/state reporting (voice unlock refused), custom skill intents, request-signature verification, Lambda forwarder, skill package (en-IN, en-US). Tested only with mocked Alexa requests; see `docs/alexa.md`.
- **Phase 4: not started** (finance/grocery/media connectors — partner-gated, listed as Planned). **Phase 5: foundations done** — plugin SDK guide (`docs/plugin-sdk.md`), versioning rules, diagnostics, certification checklist (`docs/plugin-certification.md`) and `scripts/validate-plugin.ts`. A marketplace listing/install service is not built.

## Updates — 16 Nov 2026 (vendor bills, deletes, bulk pantry, channels)
- **Pay-per-delivery (vendor) bills** — milk per liter, newspaper, maid, water cans, tiffin. Integer-only maths (thousandths × rate), per-month ledger storing only exceptions (skipped / extra days), month closes on payment, price changes apply from next month unless "this month too". Backend: `core/vendorBill.ts`, `services/vendorBills.ts`, routes under `/v1/households/:hid/vendor-bills`, MCP tools `list_bills`, `create_vendor_bill`, `update_vendor_bill`, `record_deliveries`, `get_bill_ledger`. UI on **both apps**: "Pay per delivery" in Add bill, month day grid (tap a day: didn't come / normal / quantity), totals, price change, payment prefilled with the month total.
- **Assistant**: finance skill teaches the vendor procedure; vendor/delivery wording routes to the stronger model tier; `record_deliveries` accepts the argument shapes models actually send; Hermes `delegation` toolset disabled (the model was delegating and falsely reporting success). **Not yet re-verified end to end on production**: the last live run was blocked by OpenRouter credits (HTTP 402) and the QA household's test bill still has wrong 12th/14th entries from an earlier bug (fixed since; emulator tests cover the logic).
- **Deleting records** — owners/administrators can delete bills, transactions, tasks, shopping lists and pantry items on **both apps**; the assistant deletes only through the `delete_record` approval. Locked transactions cannot be deleted. Activity-feed entries can be deleted/cleared by owners and administrators (audited).
- **Bulk pantry** — paste or type a list; on-device parser (identical rules and the same 10 test cases on Android and iOS), preview with "Adds to existing / New", duplicate merge, storage location; plus the assistant tool `add_pantry_items`.
- **Channels/productivity**: Telegram bot (outbound only, every message needs approval) and Google Calendar **read-only via the private iCal address** (no Google sign-in; recurrence expanded). Both unit-tested with fakes; **not exercised against the live Telegram/Google services** (needs a bot token / calendar address from the household).
- Model fallback is a free OpenRouter model (`google/gemma-4-31b-it:free`) in both the proxy and Hermes; free models are rate-limited and weaker at tool calls.
- Tests this round: emulator suite 104 passed, unit 74 passed, Android unit tests pass, iOS unit tests pass; iOS app builds.

## Partial
- Live LLM: one production run verified (simple tier). Full multi-step workflows (weekly preparation with tools and approvals) not yet run against the live model; automated tests use a provider double.
- Documents: metadata, categories, restriction and expiry work; **file upload/preview** UI is not built yet (Storage rules are in place and tested).
- Receipts/attachments on tasks and transactions: rules exist; no picker UI.
- Calendar: agenda list; no week/month grid on tablets yet.
- Android Compose UI tests beyond the JVM suite; the Android Connections screens are compile-checked and share the backend tests, but have no device run recorded this session; accessibility audits with TalkBack/VoiceOver not yet run (semantics/labels are in place; see `docs/accessibility-checklist.md`).
- Hindi/RTL: layouts use start/end and wrap, but no translations are shipped.
- Crashlytics, Analytics (consent), Performance, Remote Config: not wired (deliberately deferred; no consent UI yet).
- App Check: enforced server-side when `ENFORCE_APP_CHECK=true`; Play Integrity / App Attest providers configured for production builds only.

## Blocked (credentials / accounts)
- APNs key for FCM on iOS; App Check registration (App Attest / Play Integrity), then `ENFORCE_APP_CHECK=true`.
- Alexa: Amazon developer account, skill registration, Login with Amazon client, Lambda deployment and certification. Until then the Channels screen shows Alexa as "Awaiting setup".
- OpenRouter app registration for production redirect URIs.
