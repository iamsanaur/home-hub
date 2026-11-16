import express, { NextFunction, Request, Response } from "express";
import { getAppCheck } from "firebase-admin/app-check";
import { getAuth } from "firebase-admin/auth";
import { z } from "zod";
import { DateTime } from "luxon";
import {
  AgentRunInput, ApprovalDecisionInput, AutonomyInput, BillPaymentInput, CreateHouseholdInput, DeviceInput, InviteInput,
} from "../core/schemas";
import { Actor, AppError, Ctx, invalid, paths, requireCapability, requireMember, ts } from "../services/base";
import {
  acceptInvitation, changeMemberRole, createHousehold, getAutonomy, invite, removeMember, revokeInvitation, setAutonomy,
} from "../services/households";
import { decideApproval, getApproval, listPendingApprovals } from "../services/approvals";
import { recordBillPayment, getBudgetSummary } from "../services/finance";
import { generateMealShoppingList } from "../services/food";
import { computeBriefing, getHouseholdReport, ReportKind } from "../services/reports";
import { getAgentUsageReport } from "../services/usage";
import { correctMemory, deleteMemory, deleteUserData, exportUserData, listMemories } from "../services/memory";
import { updateJob } from "../services/jobs";
import { HermesClient } from "../agent/hermesClient";
import { completeDeviceRun, startAgentRun, startDeviceRun, stopAgentRun, streamAgentRun } from "../agent/orchestrator";
import { handleModelCall, ModelProxyConfig } from "../agent/modelProxy";
import { claimJobForDevice } from "../services/jobs";
import { completeProviderOAuth, oauthResultPage } from "../plugins/modelAccounts";
import { mountPhase1Routes } from "./phase1Routes";

declare module "express-serve-static-core" {
  interface Request {
    user?: { uid: string; email?: string | null; emailVerified?: boolean; name?: string | null };
  }
}

export interface GatewayDeps {
  ctx: Ctx;
  hermes: () => HermesClient | null;
  /** Model proxy for Hermes Mobile; null when no provider is configured. */
  modelProxy?: () => ModelProxyConfig | null;
  /** Set false only in tests running without App Check tokens. */
  enforceAppCheck?: boolean;
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) throw invalid("Invalid request", r.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

const HID = /^[A-Za-z0-9_-]{1,128}$/;

export function createGatewayApp(deps: GatewayDeps) {
  const { ctx } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/v1/health", wrap(async (_req, res) => {
    const hermes = deps.hermes();
    res.json({ status: "ok", agent: hermes ? ((await hermes.health()) ? "available" : "unreachable") : "not_configured" });
  }));

  // OpenRouter OAuth (PKCE) callback — authenticated by the single-use state, not an ID token.
  app.get("/oauth/providers/openrouter/callback", wrap(async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      await completeProviderOAuth(ctx, typeof req.query.code === "string" ? req.query.code : undefined, typeof req.query.state === "string" ? req.query.state : undefined);
      res.type("html").send(oauthResultPage(true, "Your OpenRouter account is connected to HomeHub."));
    } catch (e) {
      res.status(e instanceof AppError ? e.status : 500).type("html").send(oauthResultPage(false, e instanceof AppError ? e.message : "Something went wrong."));
    }
  }));

  // --- authentication: Firebase ID token (+ App Check) on every other route ---
  app.use((req: Request, _res: Response, next: NextFunction) => { authenticate(req).then(() => next(), next); });
  async function authenticate(req: Request): Promise<void> {
    const header = req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ")) throw new AppError(401, "unauthenticated", "Sign in required");
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(header.slice(7), true);
    } catch {
      throw new AppError(401, "unauthenticated", "Your session has expired. Sign in again.");
    }
    if (deps.enforceAppCheck ?? process.env.ENFORCE_APP_CHECK === "true") {
      const token = req.header("x-firebase-appcheck");
      if (!token) throw new AppError(401, "app_check_required", "App verification failed");
      try { await getAppCheck().verifyToken(token); } catch { throw new AppError(401, "app_check_failed", "App verification failed"); }
    }
    req.user = { uid: decoded.uid, email: decoded.email ?? null, emailVerified: decoded.email_verified ?? false, name: decoded.name ?? null };
  }

  const actor = (req: Request): Actor => ({ uid: req.user!.uid, kind: "user" });
  const hid = (req: Request): string => {
    const h = String(req.params.hid ?? "");
    if (!h || !HID.test(h)) throw invalid("Invalid household id");
    return h;
  };

  // --- households & membership ---
  app.post("/v1/households", wrap(async (req, res) => {
    const input = body(CreateHouseholdInput, req);
    res.status(201).json(await createHousehold(ctx, { uid: req.user!.uid, displayName: req.user!.name, email: req.user!.email }, input));
  }));
  app.post("/v1/households/:hid/invitations", wrap(async (req, res) => {
    res.status(201).json(await invite(ctx, actor(req), hid(req), body(InviteInput, req)));
  }));
  app.delete("/v1/households/:hid/invitations/:iid", wrap(async (req, res) => {
    await revokeInvitation(ctx, actor(req), hid(req), String(req.params.iid));
    res.status(204).end();
  }));
  app.post("/v1/invitations/accept", wrap(async (req, res) => {
    const { token } = body(z.object({ token: z.string().min(20).max(64) }), req);
    res.json(await acceptInvitation(ctx, { uid: req.user!.uid, email: req.user!.email, emailVerified: req.user!.emailVerified, displayName: req.user!.name }, token));
  }));
  app.patch("/v1/households/:hid/members/:uid", wrap(async (req, res) => {
    const input = body(z.object({ role: z.string().optional(), permissions: z.object({ finance: z.boolean().optional(), agent: z.boolean().optional() }).optional() }), req);
    await changeMemberRole(ctx, actor(req), hid(req), String(req.params.uid), input);
    res.status(204).end();
  }));
  app.delete("/v1/households/:hid/members/:uid", wrap(async (req, res) => {
    await removeMember(ctx, actor(req), hid(req), String(req.params.uid));
    res.status(204).end();
  }));

  // --- autonomy & emergency pause ---
  app.get("/v1/households/:hid/autonomy", wrap(async (req, res) => {
    await requireMember(ctx, hid(req), req.user!.uid);
    res.json(await getAutonomy(ctx, hid(req)));
  }));
  app.post("/v1/households/:hid/autonomy", wrap(async (req, res) => {
    res.json(await setAutonomy(ctx, actor(req), hid(req), body(AutonomyInput, req)));
  }));

  // --- agent ---
  app.post("/v1/households/:hid/agent/runs", wrap(async (req, res) => {
    const input = body(AgentRunInput, req);
    const result = await startAgentRun(ctx, deps.hermes(), { uid: req.user!.uid, hid: hid(req), ...input });
    res.status(result.mode === "agent" ? 202 : 200).json(result);
  }));
  app.get("/v1/households/:hid/agent/workflows/:wid/events", wrap(async (req, res) => {
    const hermes = deps.hermes();
    if (!hermes) throw new AppError(503, "agent_unavailable", "The assistant is not available right now.");
    await requireCapability(ctx, hid(req), req.user!.uid, "agent.use");
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
    try {
      await streamAgentRun(ctx, hermes, hid(req), req.user!.uid, String(req.params.wid), (e) => res.write(`data: ${JSON.stringify(e)}\n\n`), abort.signal);
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError(500, "internal", "Something went wrong");
      res.write(`data: ${JSON.stringify({ type: "error", code: e.code, message: e.message })}\n\n`);
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  }));
  // --- Hermes Mobile (agent runs on the phone) ---
  app.post("/v1/households/:hid/agent/device-runs", wrap(async (req, res) => {
    const input = body(AgentRunInput.extend({ power: z.enum(["normal", "saver", "critical"]).optional() }), req);
    const result = await startDeviceRun(ctx, { uid: req.user!.uid, hid: hid(req), message: input.message, sessionId: input.sessionId, power: input.power });
    res.status(result.mode === "device" ? 201 : 200).json(result);
  }));
  app.post("/v1/households/:hid/agent/workflows/:wid/model", wrap(async (req, res) => {
    await handleModelCall(ctx, deps.modelProxy?.() ?? null, req, res);
  }));
  app.post("/v1/households/:hid/agent/workflows/:wid/complete", wrap(async (req, res) => {
    const input = body(z.object({ status: z.enum(["completed", "failed", "cancelled"]), output: z.string().max(20000), toolCalls: z.number().int().min(0).max(500), error: z.string().max(500).optional() }), req);
    const r = await completeDeviceRun(ctx, hid(req), req.user!.uid, String(req.params.wid), input);
    res.json({ state: r.state, verified: r.verified, approvals: r.approvals, usage: r.usage });
  }));
  app.post("/v1/households/:hid/jobs/:jid/device-claim", wrap(async (req, res) => {
    res.json(await claimJobForDevice(ctx, actor(req), hid(req), String(req.params.jid)));
  }));

  app.post("/v1/households/:hid/agent/workflows/:wid/stop", wrap(async (req, res) => {
    res.json(await stopAgentRun(ctx, deps.hermes(), hid(req), req.user!.uid, String(req.params.wid)));
  }));

  // --- approvals ---
  app.get("/v1/households/:hid/approvals", wrap(async (req, res) => {
    res.json({ items: await listPendingApprovals(ctx, hid(req), actor(req)) });
  }));
  app.get("/v1/households/:hid/approvals/:aid", wrap(async (req, res) => {
    res.json(await getApproval(ctx, hid(req), actor(req), String(req.params.aid)));
  }));
  app.post("/v1/households/:hid/approvals/:aid/decision", wrap(async (req, res) => {
    const input = body(ApprovalDecisionInput, req);
    res.json(await decideApproval(ctx, hid(req), actor(req), String(req.params.aid), input.decision, input.note));
  }));

  // --- deterministic household operations ---
  app.get("/v1/households/:hid/briefing", wrap(async (req, res) => {
    res.json(await computeBriefing(ctx, hid(req), actor(req)));
  }));
  app.post("/v1/households/:hid/bills/:bid/payments", wrap(async (req, res) => {
    res.status(201).json(await recordBillPayment(ctx, hid(req), actor(req), String(req.params.bid), body(BillPaymentInput, req)));
  }));
  app.post("/v1/households/:hid/meal-plans/:week/shopping-list", wrap(async (req, res) => {
    const { listId } = body(z.object({ listId: z.string().max(128).optional() }), req);
    res.status(201).json(await generateMealShoppingList(ctx, hid(req), actor(req), String(req.params.week), listId));
  }));
  app.get("/v1/households/:hid/budget/:period", wrap(async (req, res) => {
    res.json(await getBudgetSummary(ctx, hid(req), actor(req), String(req.params.period)));
  }));
  app.get("/v1/households/:hid/reports/:kind", wrap(async (req, res) => {
    const kind = String(req.params.kind) as ReportKind;
    if (!["overview", "expenditure", "tasks", "shopping", "maintenance", "wastage"].includes(kind)) throw invalid("Unknown report");
    const to = typeof req.query.to === "string" ? req.query.to : ctx.now().toISOString();
    const from = typeof req.query.from === "string" ? req.query.from : DateTime.fromISO(to).minus({ days: 30 }).toISO()!;
    res.json(await getHouseholdReport(ctx, hid(req), actor(req), kind, from, to));
  }));
  app.get("/v1/households/:hid/agent/usage", wrap(async (req, res) => {
    const to = typeof req.query.to === "string" ? req.query.to : ctx.now().toISOString();
    const from = typeof req.query.from === "string" ? req.query.from : DateTime.fromISO(to).minus({ days: 30 }).toISO()!;
    res.json(await getAgentUsageReport(ctx, hid(req), actor(req), from, to));
  }));
  app.post("/v1/households/:hid/jobs/:jid", wrap(async (req, res) => {
    const input = body(z.object({
      action: z.enum(["pause", "resume", "edit", "delete"]),
      schedule: z.object({ kind: z.enum(["daily", "weekly", "monthly"]), time: z.string().regex(/^\d{2}:\d{2}$/), weekday: z.number().int().min(1).max(7).optional(), monthDay: z.number().int().min(1).max(28).optional() }).optional(),
    }), req);
    await updateJob(ctx, actor(req), hid(req), String(req.params.jid), input);
    res.status(204).end();
  }));

  // --- memory ---
  app.get("/v1/households/:hid/memories", wrap(async (req, res) => {
    res.json({ items: await listMemories(ctx, hid(req), actor(req)) });
  }));
  app.patch("/v1/households/:hid/memories/:mid", wrap(async (req, res) => {
    const { text } = body(z.object({ text: z.string().min(1).max(500) }), req);
    await correctMemory(ctx, hid(req), actor(req), String(req.params.mid), text);
    res.status(204).end();
  }));
  app.delete("/v1/households/:hid/memories/:mid", wrap(async (req, res) => {
    await deleteMemory(ctx, hid(req), actor(req), String(req.params.mid));
    res.status(204).end();
  }));

  // --- me: devices, export, deletion ---
  app.post("/v1/me/devices", wrap(async (req, res) => {
    const d = body(DeviceInput, req);
    await ctx.db.doc(`users/${req.user!.uid}/devices/${d.deviceId}`).set({ token: d.token, platform: d.platform, appVersion: d.appVersion ?? null, updatedAt: ts(ctx.now()) });
    res.status(204).end();
  }));
  app.delete("/v1/me/devices/:deviceId", wrap(async (req, res) => {
    await ctx.db.doc(`users/${req.user!.uid}/devices/${String(req.params.deviceId)}`).delete();
    res.status(204).end();
  }));
  app.get("/v1/me/export", wrap(async (req, res) => {
    res.set("Content-Disposition", "attachment; filename=homehub-export.json").json(await exportUserData(ctx, req.user!.uid));
  }));
  app.delete("/v1/me", wrap(async (req, res) => {
    const result = await deleteUserData(ctx, req.user!.uid);
    await getAuth().deleteUser(req.user!.uid);
    res.json(result);
  }));

  mountPhase1Routes(app, ctx, wrap, () => deps.modelProxy?.() ?? null);

  app.use((_req: Request, res: Response) => res.status(404).json({ error: { code: "not_found", message: "Unknown endpoint" } }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    console.error("gateway error", err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  });
  return app;
}

export { paths };
