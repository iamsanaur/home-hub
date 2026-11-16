import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/v2";
import { logger } from "firebase-functions";
import { adminCtx } from "./admin";
import { createGatewayApp } from "./gateway/app";
import { handleMcpRequest } from "./mcp/server";
import { HermesClient } from "./agent/hermesClient";
import { modelProxyConfigFromEnv } from "./agent/modelProxy";
import { reconcileStaleWorkflows, startAgentRun } from "./agent/orchestrator";
import { runDueJobs } from "./services/jobs";
import { expireApprovals } from "./services/approvals";
import { handleTaskCompleted } from "./services/tasks";
import { createAlexaApp } from "./alexa/app";
import { createHooksApp } from "./gateway/hooksApp";
import { installEventHooks } from "./wiring";
import { processEvent, runBillDueAutomations, runScheduledAutomations } from "./automations/automations";
import { secretEnv } from "./core/env";

setGlobalOptions({ region: "asia-south1", maxInstances: 20 });
installEventHooks();

// Secrets live in Google Secret Manager (or .secret.local for the emulator) — never in source.
const HERMES_API_KEY = defineSecret("HERMES_API_KEY");
const HOMEHUB_MCP_SERVICE_KEY = defineSecret("HOMEHUB_MCP_SERVICE_KEY");
const HERMES_API_URL = defineString("HERMES_API_URL", { default: "" });

function hermes(): HermesClient | null {
  const url = HERMES_API_URL.value() || process.env.HERMES_API_URL;
  const key = secretEnv("HERMES_API_KEY");
  if (!url || !key) return null;
  return new HermesClient({ baseUrl: url.replace(/\/$/, ""), apiKey: key, timeoutMs: 15000 });
}

// Model proxy for Hermes Mobile (provider key is a secret; model ids are plain params).
const MODEL_API_KEY = defineSecret("MODEL_API_KEY");

const gateway = createGatewayApp({ ctx: adminCtx(), hermes, modelProxy: modelProxyConfigFromEnv });

/** HomeHub API gateway for the native apps (incl. the Hermes Mobile model proxy). */
export const api = onRequest(
  { secrets: [HERMES_API_KEY, MODEL_API_KEY], timeoutSeconds: 300, memory: "512MiB", cors: false, invoker: "public" },
  gateway,
);

// Alexa (account linking, Smart Home via Lambda forwarder, custom skill) and machine hooks.
const ALEXA_OAUTH_CLIENT_SECRET = defineSecret("ALEXA_OAUTH_CLIENT_SECRET");
const ALEXA_FORWARDER_SECRET = defineSecret("ALEXA_FORWARDER_SECRET");
const LWA_CLIENT_SECRET = defineSecret("LWA_CLIENT_SECRET");

/** Public Alexa endpoints — each route verifies its own credential (OAuth, HMAC, Amazon signature). */
export const alexa = onRequest(
  { secrets: [ALEXA_OAUTH_CLIENT_SECRET, ALEXA_FORWARDER_SECRET, LWA_CLIENT_SECRET], timeoutSeconds: 30, memory: "256MiB", cors: false, invoker: "public" },
  createAlexaApp({ ctx: adminCtx() }),
);

/** Signed inbound webhooks and local-bridge pairing/state. */
export const hooks = onRequest(
  { timeoutSeconds: 30, memory: "256MiB", cors: false, invoker: "public" },
  createHooksApp(adminCtx()),
);

/** HomeHub MCP server for the Hermes runtime (service-key + per-run grant). */
export const mcp = onRequest(
  { secrets: [HOMEHUB_MCP_SERVICE_KEY], timeoutSeconds: 60, memory: "512MiB", cors: false, invoker: "public" },
  async (req, res) => {
    await handleMcpRequest(adminCtx(), req, res);
  },
);

/** One scheduler for all deterministic jobs — no per-household cron duplication. */
export const scheduler = onSchedule(
  { schedule: "every 15 minutes", timeZone: "UTC", secrets: [HERMES_API_KEY], retryCount: 0, timeoutSeconds: 540 },
  async () => {
    const ctx = adminCtx();
    const h = hermes();
    const jobs = await runDueJobs(ctx, {
      dispatchAgent: h
        ? async (hid, ownerUid, jobType, runKey) => {
            const r = await startAgentRun(ctx, h, {
              uid: ownerUid, hid, systemTriggered: true, idempotencyKey: runKey,
              message: jobType === "weekly_meal_planning"
                ? "Plan next week's meals from our preferences and pantry, then generate the shopping list. Ask for approval where required."
                : "Run the scheduled household review.",
            });
            return { status: r.mode === "agent" ? "dispatched" : "succeeded" };
          }
        : undefined,
    });
    const automations = await runScheduledAutomations(ctx).catch((e) => { logger.error("scheduled automations", e); return 0; });
    const billAutomations = await runBillDueAutomations(ctx).catch((e) => { logger.error("bill automations", e); return 0; });
    const expired = await expireApprovals(ctx);
    const reconciled = await reconcileStaleWorkflows(ctx, h);
    const { syncBridgeIntegrations } = await import("./plugins/runtime");
    const bridges = await syncBridgeIntegrations(ctx).catch((e) => { logger.error("bridge sync", e); return { synced: 0, failed: 0 }; });
    logger.info("scheduler", { jobs: jobs.length, automations, billAutomations, expired, reconciled, bridges });
  },
);

/** Completion history + next recurrence, for tasks completed from any client (incl. offline sync). */
export const onTaskCompleted = onDocumentUpdated("households/{hid}/tasks/{taskId}", async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  logger.debug("onTaskCompleted", { before: before?.status, after: after?.status, completedAtType: after?.completedAt?.constructor?.name });
  if (!before || !after || before.status === "done" || after.status !== "done") return;
  await handleTaskCompleted(adminCtx(), event.params.hid, event.params.taskId, after);
});

/** Keep pantry lowStock consistent regardless of which client wrote the quantity. */
export const onPantryWritten = onDocumentWritten("households/{hid}/pantryItems/{itemId}", async (event) => {
  const after = event.data?.after;
  if (!after?.exists) return;
  const d = after.data()!;
  const low = d.minQuantity != null && d.quantity <= d.minQuantity;
  const nameKey = String(d.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (d.lowStock !== low || d.nameKey !== nameKey) await after.ref.update({ lowStock: low, nameKey });
  // Edge-triggered: only the transition into low stock fires pantry_low automations.
  // Computed from quantities, not the lowStock flag, so this function's own flag write can't re-fire it.
  const b = event.data?.before?.exists ? event.data.before.data()! : null;
  const wasLow = !!b && b.minQuantity != null && b.quantity <= b.minQuantity;
  if (low && !wasLow) {
    await processEvent(adminCtx(), event.params.hid, { type: "pantry.low", data: { itemId: after.id, name: d.name ?? "" }, origin: { channel: "system" } })
      .catch((e) => logger.warn("pantry_low automations", e));
  }
});
