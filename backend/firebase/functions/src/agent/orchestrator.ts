import { FieldValue } from "firebase-admin/firestore";
import { Actor, AppError, audit, Ctx, forbidden, newId, notFound, paths, requireCapability, ts } from "../services/base";
import { listPendingApprovals } from "../services/approvals";
import { computeBriefing } from "../services/reports";
import { recordUsage } from "../services/usage";
import { mintGrant, revokeGrantsForWorkflow } from "./grants";
import { buildContext, instructions } from "./context";
import { HermesClient, HermesEvent, HermesUnavailableError } from "./hermesClient";
import { modelFor, route } from "./router";

/** Events sent to native clients over the gateway SSE stream. */
export type ClientEvent =
  | { type: "status"; state: "executing" | "awaiting_approval" | "completed" | "partially_completed" | "failed" | "cancelled" }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; phase: "started" | "completed"; ok?: boolean; durationMs?: number }
  | { type: "approvals"; items: unknown[] }
  | { type: "verified"; actions: Array<{ action: string; targetType: string; targetId: string | null }> }
  | { type: "result"; text: string; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; code: string; message: string };

const RUNS_PER_HOUR = Number(process.env.AGENT_RUNS_PER_HOUR ?? 30);

async function rateLimit(ctx: Ctx, uid: string): Promise<void> {
  const window = Math.floor(ctx.now().getTime() / 3600_000);
  const ref = ctx.db.doc(`rateLimits/agent_${uid}_${window}`);
  const count = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = (snap.data()?.count ?? 0) + 1;
    tx.set(ref, { count: n, expiresAt: ts(new Date((window + 2) * 3600_000)) });
    return n;
  });
  if (count > RUNS_PER_HOUR) throw new AppError(429, "rate_limited", "Too many assistant requests. Try again later.");
}

export interface StartResult {
  sessionId: string;
  workflowId: string;
  mode: "agent" | "deterministic";
  runId?: string;
  answer?: unknown;
}

export async function startAgentRun(
  ctx: Ctx, hermes: HermesClient | null,
  req: { uid: string; hid: string; message: string; sessionId?: string; idempotencyKey?: string; systemTriggered?: boolean },
): Promise<StartResult> {
  const member = await requireCapability(ctx, req.hid, req.uid, "agent.use");
  if (!req.systemTriggered) await rateLimit(ctx, req.uid);
  const actor: Actor = { uid: req.uid, kind: "user" };
  const r = await routeRespectingSkills(ctx, req.hid, req.message);

  // Session (conversation) bookkeeping — owned by the user, readable only by them.
  const sessionId = req.sessionId ?? newId();
  const sessionRef = ctx.db.doc(`${paths.col(req.hid, "agentSessions")}/${sessionId}`);
  const existing = await sessionRef.get();
  if (existing.exists && existing.data()!.ownerUid !== req.uid) throw forbidden("Not your conversation");
  await sessionRef.set({
    householdId: req.hid, ownerUid: req.uid, title: existing.data()?.title ?? req.message.slice(0, 60),
    hermesSessionId: existing.data()?.hermesSessionId ?? `homehub_${req.hid}_${sessionId}`,
    updatedAt: ts(ctx.now()), ...(existing.exists ? {} : { createdAt: ts(ctx.now()) }), messageCount: FieldValue.increment(1),
  }, { merge: true });
  await sessionRef.collection("messages").add({ role: "user", content: req.message, createdAt: ts(ctx.now()) });

  const workflowId = newId();
  const wfRef = ctx.db.doc(`${paths.col(req.hid, "agentWorkflows")}/${workflowId}`);

  if (r.kind === "deterministic") {
    // Answered from the database: no tokens spent.
    const answer = r.handler === "briefing"
      ? await computeBriefing(ctx, req.hid, actor)
      : await listPendingApprovals(ctx, req.hid, actor).catch(() => []);
    await wfRef.set({
      householdId: req.hid, sessionId, requestedBy: req.uid, mode: "deterministic", handler: r.handler,
      status: "completed", createdAt: ts(ctx.now()), finishedAt: ts(ctx.now()),
    });
    await sessionRef.collection("messages").add({ role: "assistant", kind: r.handler, content: JSON.stringify(answer), workflowId, createdAt: ts(ctx.now()) });
    return { sessionId, workflowId, mode: "deterministic", answer };
  }

  if (!hermes) {
    await wfRef.set({ householdId: req.hid, sessionId, requestedBy: req.uid, status: "failed", error: "agent_unavailable", createdAt: ts(ctx.now()) });
    throw new AppError(503, "agent_unavailable", "The assistant is not available right now. Everything else in HomeHub keeps working.");
  }

  const context = await buildContext(ctx, req.hid, req.uid, member.role, r.skill, req.message);
  const grant = await mintGrant(ctx, { householdId: req.hid, uid: req.uid, sessionId, workflowId });
  const { model, provider } = modelFor(r.tier);
  await wfRef.set({
    householdId: req.hid, sessionId, requestedBy: req.uid, mode: "agent", agentId: "homehub-hermes",
    skill: r.skill, workflow: r.workflow ?? null, tier: r.tier, model: model ?? "hermes-default", provider: provider ?? null,
    status: "executing", runId: null, createdAt: ts(ctx.now()), startedAtMs: ctx.now().getTime(), retries: 0,
  });
  let run;
  let retries = 0;
  for (;;) {
    try {
      run = await hermes.createRun({
        input: req.message,
        instructions: instructions(context, grant, r.workflow),
        sessionId: (await sessionRef.get()).data()!.hermesSessionId,
        model, provider,
        idempotencyKey: req.idempotencyKey ? `${req.hid}:${req.uid}:${req.idempotencyKey}` : workflowId,
      });
      break;
    } catch (err) {
      // Bounded retry (same idempotency key, so Hermes never double-starts a run).
      if (err instanceof HermesUnavailableError && retries < 2) { retries++; await new Promise((r) => setTimeout(r, 400 * retries)); continue; }
      await revokeGrantsForWorkflow(ctx, workflowId);
      await wfRef.update({ status: "failed", error: (err as Error).message.slice(0, 300), retries });
      if (err instanceof HermesUnavailableError) {
        throw new AppError(503, "agent_unavailable", "The assistant is not available right now. Everything else in HomeHub keeps working.");
      }
      throw err;
    }
  }
  await wfRef.update({ runId: run.runId, retries });
  await audit(ctx, req.hid, actor, "agent.run_started", { type: "agentWorkflow", id: workflowId }, { skill: r.skill, tier: r.tier });
  return { sessionId, workflowId, mode: "agent", runId: run.runId };
}

async function loadWorkflow(ctx: Ctx, hid: string, uid: string, workflowId: string) {
  const ref = ctx.db.doc(`${paths.col(hid, "agentWorkflows")}/${workflowId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Workflow");
  const wf = snap.data()!;
  if (wf.requestedBy !== uid) throw forbidden("Not your workflow");
  return { ref, wf };
}

/**
 * Streams a run to the client and finalises it. The final state is derived from
 * VERIFIED facts (audit log entries tagged with this workflow and approval
 * records), not from the model's narrative.
 */
export async function streamAgentRun(
  ctx: Ctx, hermes: HermesClient, hid: string, uid: string, workflowId: string,
  emit: (e: ClientEvent) => void, signal?: AbortSignal,
): Promise<void> {
  const { wf } = await loadWorkflow(ctx, hid, uid, workflowId);
  if (!wf.runId) throw new AppError(409, "no_run", "This workflow has no agent run");
  if (wf.status !== "executing") {
    emit({ type: "status", state: wf.status });
    if (wf.output) emit({ type: "result", text: wf.output });
    return;
  }
  emit({ type: "status", state: "executing" });
  let output = "";
  let terminal: HermesEvent | null = null;
  let toolCalls = 0;
  try {
    for await (const ev of hermes.events(wf.runId, signal)) {
      switch (ev.event) {
        case "message.delta":
          output += (ev as { delta: string }).delta;
          emit({ type: "delta", text: (ev as { delta: string }).delta });
          break;
        case "tool.started":
          toolCalls++;
          emit({ type: "tool", name: publicToolName((ev as { tool: string }).tool), phase: "started" });
          break;
        case "tool.completed": {
          const e = ev as { tool: string; duration?: number; error?: boolean };
          emit({ type: "tool", name: publicToolName(e.tool), phase: "completed", ok: !e.error, durationMs: Math.round((e.duration ?? 0) * 1000) });
          break;
        }
        case "run.completed":
        case "run.failed":
        case "run.cancelled":
          terminal = ev;
          break;
      }
    }
  } catch (err) {
    if (!(err instanceof HermesUnavailableError)) throw err;
  }
  if (!terminal) {
    // Stream dropped: fall back to polling the run status once.
    const st = await hermes.getRun(wf.runId).catch(() => null);
    if (st && ["completed", "failed", "cancelled"].includes(st.status)) {
      terminal = { event: `run.${st.status}`, run_id: wf.runId, output: st.output, usage: st.usage, error: st.error } as HermesEvent;
    }
  }
  if (!terminal) {
    emit({ type: "error", code: "stream_interrupted", message: "Lost connection to the assistant. Reopen the conversation to see the result." });
    return;
  }
  const final = await finalizeWorkflow(ctx, hid, workflowId, terminal, output, toolCalls);
  if (final.approvals.length) emit({ type: "approvals", items: final.approvals });
  emit({ type: "verified", actions: final.verified });
  if (final.text) emit({ type: "result", text: final.text, usage: final.usage });
  if (final.state === "failed") emit({ type: "error", code: "agent_failed", message: final.error ?? "The assistant could not finish this request." });
  emit({ type: "status", state: final.state });
}

function publicToolName(tool: string): string {
  // Hermes prefixes MCP tools as mcp_<server>_<tool>; show only the HomeHub tool name.
  return tool.replace(/^mcp_homehub_/, "");
}

export async function finalizeWorkflow(
  ctx: Ctx, hid: string, workflowId: string, terminal: HermesEvent, streamedOutput: string, toolCalls: number,
) {
  const ref = ctx.db.doc(`${paths.col(hid, "agentWorkflows")}/${workflowId}`);
  const wf = (await ref.get()).data()!;
  const t = terminal as { event: string; output?: string; error?: string; usage?: { input_tokens?: number; output_tokens?: number; cached_tokens?: number } };
  const text = t.output ?? streamedOutput;
  const [logs, approvals] = await Promise.all([
    ctx.db.collection(paths.col(hid, "activityLogs")).where("workflowId", "==", workflowId).limit(100).get(),
    ctx.db.collection(paths.col(hid, "approvals")).where("workflowId", "==", workflowId).limit(50).get(),
  ]);
  const verified = logs.docs.map((d) => ({ action: d.data().action, targetType: d.data().targetType, targetId: d.data().targetId }))
    .filter((a) => a.action !== "approval.requested");
  const pending = approvals.docs.filter((d) => d.data().status === "pending").map((d) => ({ id: d.id, title: d.data().title, action: d.data().action, estimatedCostMinor: d.data().estimatedCostMinor, currency: d.data().currency }));
  let state: "completed" | "awaiting_approval" | "partially_completed" | "failed" | "cancelled";
  if (t.event === "run.cancelled") state = "cancelled";
  else if (t.event === "run.failed") state = verified.length ? "partially_completed" : "failed";
  else state = pending.length ? "awaiting_approval" : "completed";

  if (wf.status === "executing") {
    await ref.update({
      status: state, output: text.slice(0, 8000), error: t.error ?? null, finishedAt: ts(ctx.now()),
      verifiedActions: verified, pendingApprovalIds: pending.map((p) => p.id), toolCalls,
    });
    await revokeGrantsForWorkflow(ctx, workflowId);
    // Device runs: usage was metered by the model proxy on the workflow itself (never client-reported).
    const usage = wf.mode === "device"
      ? { input_tokens: wf.inputTokens ?? 0, output_tokens: wf.outputTokens ?? 0, cached_tokens: wf.cachedTokens ?? 0 }
      : t.usage ?? {};
    await recordUsage(ctx, hid, {
      sessionId: wf.sessionId, runId: wf.runId ?? workflowId, workflowId, agentId: wf.mode === "device" ? "homehub-hermes-mobile" : "homehub-hermes", skill: wf.skill,
      provider: wf.provider, model: wf.model, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0,
      cachedTokens: usage.cached_tokens ?? null, delegatedTokens: null, toolCalls, retries: wf.retries ?? 0,
      durationMs: ctx.now().getTime() - (wf.startedAtMs ?? ctx.now().getTime()),
      status: state === "cancelled" ? "cancelled" : state === "failed" ? "failed" : "completed", requestedBy: wf.requestedBy,
    });
    if (text) {
      await ctx.db.collection(`${paths.col(hid, "agentSessions")}/${wf.sessionId}/messages`).add({
        role: "assistant", content: text.slice(0, 8000), workflowId, state, verifiedActions: verified,
        pendingApprovalIds: pending.map((p) => p.id), createdAt: ts(ctx.now()),
      });
    }
  }
  return {
    state, text, verified, approvals: pending, error: t.error,
    usage: { inputTokens: t.usage?.input_tokens ?? wf.inputTokens ?? 0, outputTokens: t.usage?.output_tokens ?? wf.outputTokens ?? 0 },
  };
}

/**
 * Hermes Mobile: start a run that executes ON THE PHONE. The server still owns the
 * parts that must be trusted — routing, compact context, the per-run grant, budgets,
 * and the instructions — and returns them so the device loop can run.
 */
export async function startDeviceRun(
  ctx: Ctx,
  req: { uid: string; hid: string; message: string; sessionId?: string; power?: "normal" | "saver" | "critical" },
) {
  const member = await requireCapability(ctx, req.hid, req.uid, "agent.use");
  await rateLimit(ctx, req.uid);
  const r = await routeRespectingSkills(ctx, req.hid, req.message);
  const sessionId = req.sessionId ?? newId();
  const sessionRef = ctx.db.doc(`${paths.col(req.hid, "agentSessions")}/${sessionId}`);
  const existing = await sessionRef.get();
  if (existing.exists && existing.data()!.ownerUid !== req.uid) throw forbidden("Not your conversation");
  await sessionRef.set({
    householdId: req.hid, ownerUid: req.uid, title: existing.data()?.title ?? req.message.slice(0, 60),
    updatedAt: ts(ctx.now()), ...(existing.exists ? {} : { createdAt: ts(ctx.now()) }), messageCount: FieldValue.increment(1),
  }, { merge: true });
  await sessionRef.collection("messages").add({ role: "user", content: req.message, createdAt: ts(ctx.now()) });
  const workflowId = newId();
  const wfRef = ctx.db.doc(`${paths.col(req.hid, "agentWorkflows")}/${workflowId}`);
  const actor: Actor = { uid: req.uid, kind: "user" };

  if (r.kind === "deterministic") {
    const answer = r.handler === "briefing" ? await computeBriefing(ctx, req.hid, actor) : await listPendingApprovals(ctx, req.hid, actor).catch(() => []);
    await wfRef.set({ householdId: req.hid, sessionId, requestedBy: req.uid, mode: "deterministic", handler: r.handler, status: "completed", createdAt: ts(ctx.now()), finishedAt: ts(ctx.now()) });
    await sessionRef.collection("messages").add({ role: "assistant", kind: r.handler, content: JSON.stringify(answer), workflowId, createdAt: ts(ctx.now()) });
    return { mode: "deterministic" as const, sessionId, workflowId, answer };
  }

  // Battery-aware budgets: a phone in power saver gets a cheaper tier and fewer iterations.
  const saver = req.power === "saver" || req.power === "critical";
  const tier = saver ? "simple" : r.tier;
  const limits = { maxIterations: saver ? 6 : r.tier === "complex" ? 14 : 8, maxToolCalls: saver ? 20 : 40, toolOutputChars: 4000 };
  const context = await buildContext(ctx, req.hid, req.uid, member.role, r.skill, req.message);
  const grant = await mintGrant(ctx, { householdId: req.hid, uid: req.uid, sessionId, workflowId, ttlMinutes: 15, maxToolCalls: limits.maxToolCalls });
  await wfRef.set({
    householdId: req.hid, sessionId, requestedBy: req.uid, mode: "device", agentId: "homehub-hermes-mobile",
    skill: r.skill, workflow: r.workflow ?? null, tier, status: "executing", runId: workflowId, power: req.power ?? "normal",
    createdAt: ts(ctx.now()), startedAtMs: ctx.now().getTime(), retries: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0,
  });
  await audit(ctx, req.hid, actor, "agent.run_started", { type: "agentWorkflow", id: workflowId }, { skill: r.skill, tier, mode: "device" });
  return {
    mode: "device" as const, sessionId, workflowId, skill: r.skill, workflow: r.workflow ?? null, tier, limits,
    instructions: instructions(context, null, r.workflow), grant,
  };
}

/** Hermes Mobile reports the end of its loop; the server verifies and records the outcome. */
export async function completeDeviceRun(
  ctx: Ctx, hid: string, uid: string, workflowId: string,
  input: { status: "completed" | "failed" | "cancelled"; output: string; toolCalls: number; error?: string },
) {
  const { wf } = await loadWorkflow(ctx, hid, uid, workflowId);
  if (wf.mode !== "device") throw new AppError(409, "wrong_mode", "Not a device workflow");
  const terminal = { event: `run.${input.status}`, run_id: workflowId, output: input.output.slice(0, 8000), error: input.error } as HermesEvent;
  return finalizeWorkflow(ctx, hid, workflowId, terminal, input.output, Math.max(0, Math.min(input.toolCalls, 500)));
}

export async function stopAgentRun(ctx: Ctx, hermes: HermesClient | null, hid: string, uid: string, workflowId: string) {
  const { ref, wf } = await loadWorkflow(ctx, hid, uid, workflowId);
  if (wf.status !== "executing") return { status: wf.status };
  if (hermes && wf.runId && wf.mode !== "device") await hermes.stopRun(wf.runId).catch(() => undefined);
  await revokeGrantsForWorkflow(ctx, workflowId);
  await ref.update({ status: "cancelled", finishedAt: ts(ctx.now()) });
  await audit(ctx, hid, { uid, kind: "user" }, "agent.run_cancelled", { type: "agentWorkflow", id: workflowId });
  return { status: "cancelled" };
}

/** Scheduler safety net: finalise runs whose client disconnected before completion. */
export async function reconcileStaleWorkflows(ctx: Ctx, hermes: HermesClient | null): Promise<number> {
  const cutoff = ctx.now().getTime() - 2 * 60_000;
  const snap = await ctx.db.collectionGroup("agentWorkflows").where("status", "==", "executing").limit(50).get();
  let n = 0;
  for (const d of snap.docs) {
    const wf = d.data();
    if (wf.mode === "device") {
      // The phone was killed or lost power mid-run: close it out from verified facts after the grant has expired.
      if (ctx.now().getTime() - (wf.startedAtMs ?? 0) > 20 * 60_000) {
        await finalizeWorkflow(ctx, d.ref.parent.parent!.id, d.id, { event: "run.failed", run_id: d.id, error: "The device stopped before the request finished." } as HermesEvent, "", 0);
        n++;
      }
      continue;
    }
    if (!hermes) continue;
    if (!wf.runId || (wf.startedAtMs ?? 0) > cutoff) continue;
    const st = await hermes.getRun(wf.runId).catch(() => null);
    const hid = d.ref.parent.parent!.id;
    if (st && ["completed", "failed", "cancelled"].includes(st.status)) {
      await finalizeWorkflow(ctx, hid, d.id, { event: `run.${st.status}`, run_id: wf.runId, output: st.output, usage: st.usage, error: st.error } as HermesEvent, "", 0);
      n++;
    } else if (!st && ctx.now().getTime() - (wf.startedAtMs ?? 0) > 30 * 60_000) {
      await finalizeWorkflow(ctx, hid, d.id, { event: "run.failed", run_id: wf.runId, error: "Run status unavailable" } as HermesEvent, "", 0);
      n++;
    }
  }
  return n;
}

/** Route, then honour skills a manager turned off: fall back to household-manager (never disabled). */
async function routeRespectingSkills(ctx: Ctx, hid: string, message: string) {
  const r = route(message);
  if (r.kind !== "agent") return r;
  const { disabledSkills } = await import("../channels/gateway");
  if (!(await disabledSkills(ctx, hid)).has(r.skill)) return r;
  return { kind: "agent" as const, skill: "household-manager" as const, tier: r.tier };
}
