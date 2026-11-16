import type { Request, Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { AppError, Ctx, forbidden, notFound, paths } from "../services/base";
import { secretEnv } from "../core/env";

/**
 * HomeHub model proxy for Hermes Mobile (the on-phone agent runtime).
 *
 * The phone runs the agent loop; every LLM call comes here. The proxy:
 *  - authenticates the user (gateway middleware) and checks the call belongs to one
 *    of their executing device workflows;
 *  - chooses the model from server configuration (the client only sends a tier),
 *    so provider keys and model choice never live in the app;
 *  - enforces per-workflow budgets (model calls, tokens) — bounded cost and battery;
 *  - forwards to any OpenAI-compatible Chat Completions endpoint and streams back;
 *  - records usage on the workflow so the usage ledger is measured, not reported.
 *
 * Config (Cloud Functions params/secrets):
 *   MODEL_API_BASE_URL   e.g. https://generativelanguage.googleapis.com/v1beta/openai
 *   MODEL_API_KEY        secret
 *   MODEL_SIMPLE / MODEL_COMPLEX   model ids per tier
 */
export interface ModelProxyConfig {
  baseUrl: string;
  apiKey: string;
  modelSimple: string;
  modelComplex: string;
  maxCallsPerWorkflow: number;
  maxTokensPerWorkflow: number;
  fetchImpl?: typeof fetch;
}

export function modelProxyConfigFromEnv(): ModelProxyConfig | null {
  const baseUrl = process.env.MODEL_API_BASE_URL;
  const apiKey = secretEnv("MODEL_API_KEY");
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    modelSimple: process.env.MODEL_SIMPLE || "gemini-2.5-flash-lite",
    modelComplex: process.env.MODEL_COMPLEX || process.env.MODEL_SIMPLE || "gemini-2.5-flash",
    maxCallsPerWorkflow: Number(process.env.MODEL_MAX_CALLS_PER_WORKFLOW ?? 16),
    maxTokensPerWorkflow: Number(process.env.MODEL_MAX_TOKENS_PER_WORKFLOW ?? 120000),
  };
}

const MAX_MESSAGES = 60;
const MAX_BODY_CHARS = 200_000;

export async function handleModelCall(ctx: Ctx, platform: ModelProxyConfig | null, req: Request, res: Response, fetchImpl?: typeof fetch): Promise<void> {
  const uid = req.user!.uid;
  const hid = String(req.params.hid);
  const wid = String(req.params.wid);
  const body = req.body as { tier?: string; messages?: unknown[]; tools?: unknown[]; tool_choice?: unknown; max_tokens?: number; temperature?: number };
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    throw new AppError(400, "invalid_argument", "messages must be a non-empty array (max 60)");
  }
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw new AppError(413, "too_large", "Request too large — compact the conversation first.");

  // Budget check + reservation in one transaction.
  const wfRef = ctx.db.doc(`${paths.col(hid, "agentWorkflows")}/${wid}`);
  // Which account pays for this call: the member's own, the household's, or the platform's.
  const { resolveModelAccount } = await import("../plugins/modelAccounts");
  const resolved = await resolveModelAccount(ctx, hid, uid, platform);
  if (!resolved) throw new AppError(503, "model_account_required", "Connect a model account in Settings → AI model to use the assistant.");
  const cfg: ModelProxyConfig = { ...resolved.cfg, fetchImpl: fetchImpl ?? platform?.fetchImpl };
  const wf = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(wfRef);
    if (!snap.exists) throw notFound("Workflow");
    const d = snap.data()!;
    if (d.requestedBy !== uid) throw forbidden("Not your workflow");
    if (d.mode !== "device") throw new AppError(409, "wrong_mode", "This workflow does not run on a device");
    if (d.status !== "executing") throw new AppError(409, "workflow_finished", `Workflow is ${d.status}`);
    const calls = (d.modelCalls ?? 0) + 1;
    const tokens = (d.inputTokens ?? 0) + (d.outputTokens ?? 0);
    if (calls > cfg.maxCallsPerWorkflow) throw new AppError(429, "model_budget_exceeded", "This request reached its model-call budget.");
    if (tokens > cfg.maxTokensPerWorkflow) throw new AppError(429, "token_budget_exceeded", "This request reached its token budget.");
    tx.update(wfRef, { modelCalls: calls, modelSource: resolved.source, modelAccountLabel: resolved.label, modelIntegrationId: resolved.integrationId });
    return d;
  });

  // The workflow's tier (set by the server router + power state) is a ceiling: a device may
  // downgrade to the economical model (e.g. for summarising) but never escalate.
  const tier = wf.tier === "complex" && body.tier !== "simple" ? "complex" : "simple";
  const model = tier === "complex" ? cfg.modelComplex : cfg.modelSimple;
  const upstreamBody: Record<string, unknown> = {
    model,
    messages: body.messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.min(Math.max(Number(body.max_tokens ?? 1200), 64), 4096),
  };
  if (Array.isArray(body.tools) && body.tools.length) {
    upstreamBody.tools = body.tools;
    if (body.tool_choice) upstreamBody.tool_choice = body.tool_choice;
  }
  if (typeof body.temperature === "number") upstreamBody.temperature = Math.min(Math.max(body.temperature, 0), 1);

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  let upstream: Response | globalThis.Response;
  try {
    upstream = await (cfg.fetchImpl ?? fetch)(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(upstreamBody),
      signal: ctrl.signal,
    });
  } catch {
    throw new AppError(503, "agent_unavailable", "The assistant's model can't be reached right now.");
  }
  const up = upstream as globalThis.Response;
  if (!up.ok || !up.body) {
    const status = up.status === 429 ? 429 : up.status >= 500 ? 503 : 502;
    throw new AppError(status, status === 429 ? "rate_limited" : "model_error", `The model provider returned ${up.status}.`);
  }

  res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-HomeHub-Model": model });
  res.flushHeaders();
  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk); // pass-through: the client parses standard chat.completion.chunk frames
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          if (json.usage) usage = json.usage;
        } catch { /* ignore */ }
      }
    }
  } finally {
    res.end();
    await wfRef.update({
      inputTokens: FieldValue.increment(usage?.prompt_tokens ?? 0),
      outputTokens: FieldValue.increment(usage?.completion_tokens ?? 0),
      cachedTokens: FieldValue.increment(usage?.prompt_tokens_details?.cached_tokens ?? 0),
      model,
      provider: new URL(cfg.baseUrl).host,
    }).catch(() => undefined);
  }
}
