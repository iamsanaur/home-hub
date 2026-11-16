# Hermes setup

HomeHub uses Hermes in two places. Both share the skills in `agents/hermes/skills/`.

## 1. Hermes Mobile (on the phone) — primary for app requests
No setup on the device. It needs the gateway's **model proxy** configured:
`MODEL_API_BASE_URL` (any OpenAI-compatible Chat Completions endpoint), secret `MODEL_API_KEY`, `MODEL_SIMPLE`, `MODEL_COMPLEX`.
Budgets: `MODEL_MAX_CALLS_PER_WORKFLOW`, `MODEL_MAX_TOKENS_PER_WORKFLOW`. Code: `android/.../hermes/`, `ios/HomeHub/Hermes/`.

## 2. Server Hermes — fallback runtime

### Docker (current production setup)
HomeHub runs its own Hermes in Docker, separate from any personal Hermes install:
`agents/hermes/docker/docker-compose.yml` + `scripts/hermes-docker.sh`.

```bash
docker build -t homehub-hermes:v0.21.2-5eb99eb2 ~/.hermes/hermes-agent   # upstream checkout at commit 5eb99eb2
scripts/hermes-docker.sh up        # prepares ~/.hermes-homehub, starts Hermes + tunnel, points production at it
scripts/hermes-docker.sh status    # containers, tunnel URL, health, the URL production uses
scripts/hermes-docker.sh logs | down
```
- **Data** lives in `~/.hermes-homehub` (config from `agents/hermes/config/config.yaml`, SOUL, the 8 skills, and a
  0600 `.env` written from Secret Manager: `API_SERVER_KEY` = `HERMES_API_KEY`, `HOMEHUB_MCP_SERVICE_KEY`,
  `OPENROUTER_API_KEY` = `MODEL_API_KEY`). `~/.hermes` is never touched.
- **Reachability**: Cloud Functions reach the API server through a Cloudflare quick tunnel (container
  `homehub-hermes-tunnel`). The host port is bound to 127.0.0.1 only; every call needs `API_SERVER_KEY`.
  A quick tunnel's URL changes when it restarts — `up` detects this and redeploys `api` + `scheduler` with the new
  `HERMES_API_URL`. For a stable URL, use a named Cloudflare tunnel (needs a Cloudflare account) or host the
  container on an always-on server.
- **Availability**: production reaches Hermes only while this machine and Docker are running. When they aren't, the
  apps keep working (Hermes Mobile on the phone is the primary runtime) and the server fallback reports unreachable.
- Models: `HERMES_MODEL_SIMPLE` / `HERMES_MODEL_COMPLEX` (OpenRouter, Gemini 2.5 Flash-Lite / Flash) in
  `backend/firebase/functions/.env.your-firebase-project-id`.

### Host install (development)
Verified against **Hermes Agent v0.21.2, commit `5eb99eb2`** (pin this; HomeHub uses only the documented API server:
`POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/stop`, `GET /health`).

```bash
scripts/hermes-install-profile.sh                    # creates/updates the homehub-hermes profile (no secrets written)
# or reuse an existing profile's provider settings:
scripts/hermes-install-profile.sh --clone-provider-from default
$EDITOR ~/.hermes/profiles/homehub-hermes/.env       # fill API_SERVER_KEY, HOMEHUB_MCP_URL, HOMEHUB_MCP_SERVICE_KEY
hermes -p homehub-hermes gateway                     # API server on 127.0.0.1:8642 — keep it on a private network
```
Then set the Functions param `HERMES_API_URL` and secret `HERMES_API_KEY` (= `API_SERVER_KEY`).

The profile disables terminal, file, browser, code execution, web, memory and session search — one profile serves many
households, so cross-session tools must stay off. Skill writes require approval.
