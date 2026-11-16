# HomeHub API gateway (v1)

Base: `https://<region>-<project>.cloudfunctions.net/api` (emulator: `http://<host>:5001/demo-homehub/asia-south1/api`).
Auth: `Authorization: Bearer <Firebase ID token>`; `X-Firebase-AppCheck` when enforced. Errors: `{"error":{"code","message","details"}}`.
Request bodies are validated by the zod schemas exported to `shared/schemas/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /v1/health | Liveness + agent availability (no auth) |
| POST | /v1/households | Create household (owner) |
| POST/DELETE | /v1/households/:hid/invitations[/:iid] | Invite (returns one-time code) / revoke |
| POST | /v1/invitations/accept | Join with code |
| PATCH/DELETE | /v1/households/:hid/members/:uid | Change role / finance permission; remove |
| GET/POST | /v1/households/:hid/autonomy | Read / set mode and emergency pause |
| POST | /v1/households/:hid/agent/device-runs | **Hermes Mobile** run ticket (or deterministic answer) |
| POST | /v1/households/:hid/agent/workflows/:wid/model | **Model proxy** (OpenAI-style messages/tools in, SSE chunks out) |
| POST | /v1/households/:hid/agent/workflows/:wid/complete | Device run finished → server-verified outcome |
| POST | /v1/households/:hid/agent/runs | Server-Hermes run (fallback path) |
| GET | /v1/households/:hid/agent/workflows/:wid/events | SSE stream for server runs |
| POST | /v1/households/:hid/agent/workflows/:wid/stop | Cancel |
| GET | /v1/households/:hid/agent/usage | Usage ledger report (managers) |
| GET | /v1/households/:hid/approvals[/:aid] | Pending approvals / one approval |
| POST | /v1/households/:hid/approvals/:aid/decision | Approve/reject (people only) |
| GET | /v1/households/:hid/briefing | Deterministic daily briefing |
| POST | /v1/households/:hid/bills/:bid/payments | Record confirmed payment (idempotent) |
| POST | /v1/households/:hid/meal-plans/:week/shopping-list | Generate list from plan |
| GET | /v1/households/:hid/budget/:period | Budget summary (YYYY-MM) |
| GET | /v1/households/:hid/reports/:kind | overview · expenditure · tasks · shopping · maintenance · wastage |
| POST | /v1/households/:hid/jobs/:jid | pause · resume · edit · delete |
| POST | /v1/households/:hid/jobs/:jid/device-claim | Phone claims an agent-job slot |
| GET/PATCH/DELETE | /v1/households/:hid/memories[/:mid] | Memory list / correct / delete |
| POST/DELETE | /v1/me/devices[/:id] | Push token register / unregister |
| GET | /v1/me/export | Personal data export |
| DELETE | /v1/me | Account deletion |
