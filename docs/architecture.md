# HomeHub AI — Architecture

Written for engineers joining the project. `design.md` owns visual/interaction rules; `claude.md` and
`docs/HOMEHUB_MASTER_PROMPT_OPENCLAW_ALEXA_FIREBASE_NATIVE.md` own product scope. This file describes what is built.

## System overview

```
┌──────────────────────┐   ┌──────────────────────┐
│ Android (Kotlin/     │   │ iOS (Swift/SwiftUI,  │      Native clients — no shared UI code.
│ Compose, Room,       │   │ SwiftData, BGTasks)  │      Both embed Hermes Mobile (on-device
│ WorkManager)         │   │                      │      agent loop) and an offline outbox.
│  └ Hermes Mobile     │   │  └ Hermes Mobile     │
└───────┬──────────────┘   └───────┬──────────────┘
        │ Firebase SDKs (Auth, Firestore w/ rules, Storage, FCM, App Check)
        │ HTTPS + Firebase ID token (+ App Check)
        ▼
┌────────────────────────────────────────────────────────────────────┐
│ Cloud Functions 2nd gen (backend/firebase/functions)                │
│  api        HomeHub API gateway: identity/policy, households,       │
│             approvals, device runs, model proxy, reports, memory    │
│  mcp        HomeHub MCP server (31 typed tools, grant-scoped)       │
│  scheduler  every 15 min: deterministic jobs, approval expiry,      │
│             stale-run reconciliation, agent-job fallback            │
│  triggers   onTaskCompleted (history + recurrence), onPantryWritten │
└───────┬───────────────────────────────┬────────────────────────────┘
        │ Admin SDK                      │ server-side only
        ▼                                ▼
  Firestore / Storage            Hermes Agent (server, v0.21.2) — fallback
  (rules + emulator tests)       runtime for scheduled agent jobs and, later,
                                 channels/Alexa. Calls `mcp` with a service key.
                                 Model provider (OpenAI-compatible) via the
                                 model proxy for Hermes Mobile.
```

## Agent runtimes (decision: keep both)

| | Hermes Mobile (phone) | Hermes (server) |
|---|---|---|
| Used for | Requests made in the app | Scheduled agent jobs when no phone claims them; future Alexa/channel requests |
| Loop | Native port (Kotlin `hermes/AgentLoop.kt`, Swift `Hermes/AgentLoop.swift`) | Hermes Agent v0.21.2 API server (`/v1/runs`) |
| Model calls | `POST /agent/workflows/{wid}/model` — server proxy holds provider key, picks model, meters tokens | Hermes' configured provider |
| Tools | HomeHub MCP with the user's ID token + per-run grant | HomeHub MCP with service key + per-run grant |
| Skills | Same `agents/hermes/skills/*/SKILL.md`, bundled as app assets | Same files installed in the `homehub-hermes` profile |

The **Gateway is always the orchestrator and policy authority**: it routes the request (deterministic router, no LLM),
builds compact context, mints the grant, sets budgets (battery-aware), enforces autonomy/approvals on every tool call,
verifies outcomes from its own audit log, and writes the usage ledger. The phone runs only the loop.

### Run lifecycle (device)
1. `POST /agent/device-runs {message, power}` → deterministic answer (no tokens) **or** a ticket: instructions (without the grant), grant, tier, skill, limits.
2. Loop on the phone: model call via proxy → tool calls on MCP (runtime injects grant; read-only calls run in parallel) → repeat within budgets.
3. `POST /agent/workflows/{wid}/complete` → server derives state from audit log + approvals (`completed`, `awaiting_approval`, `partially_completed`, `failed`, `cancelled`), revokes grant, records usage.
4. Phone killed mid-run → scheduler finalises it after the grant expires.

### Battery policy (`Power.kt` / `HermesCore.swift`, identical rules)
- Critical (≤5 % unplugged, or thermal ≥ severe): no agent run; clear message.
- Saver (Low Power/Battery Saver, ≤20 %, or warm): server issues the economical tier, 6 iterations, 20 tool calls.
- Background agent jobs: only charging + cool + unmetered (WorkManager constraints / `BGProcessingTask.requiresExternalPower`).
- Deterministic commands ("add milk", "what's due today") never call a model and work offline.
- No polling anywhere; one radio burst per model turn; parallel read-only tool calls.

## Data
Firestore paths follow `claude.md` §5 under `households/{hid}/…`. Server-only: members, invitations, approvals,
activityLogs, agentSessions/Workflows/Usage, scheduledJobs, memories, `agentGrants`, `idempotency`, `rateLimits`.
Money is integer minor units + ISO 4217 everywhere (server `core/money.ts`, Android `Money.kt`, iOS `Money.swift`).

## Offline
Tasks, shopping items and notes: local DB is the UI's source of truth (Room / SwiftData). Each edit writes locally and
appends an outbox op in one transaction; the sync engine applies ops in Firestore transactions with the same metadata
the rules require. Conflict policy per type (`ConflictPolicy`): completion/purchase edits merge, other concurrent edits
go to the Sync conflicts screen. Finance is never edited offline; creates use client IDs and are append-only.

## Scheduling
One Cloud Scheduler job (`scheduler`, every 15 min) runs all deterministic household jobs with a transactional lease and
an exclusive per-slot run record — a slot runs once even under concurrency. Agent jobs wait 6 h for a phone to claim the
slot (`/jobs/{id}/device-claim`) before the server Hermes takes it.

## Addendum (OpenClaw-style Gateway, plugins, Alexa) — not started
Per the user's decision the current apps are finished first. Planned mapping onto this architecture:
- Plugin registry + manifest validator + SDK → new `plugins/` service behind `api`; tools surface through the same policy layer as MCP tools.
- Channels/Alexa → server Hermes path (already exists) + new endpoints; Alexa Smart Home + custom skill handlers with account linking.
- Devices/bridges/automations → new Firestore collections (addendum §10) with rules + emulator tests.
See `IMPLEMENTATION_STATUS.md` for the phase checklist.
