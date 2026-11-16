import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { Timestamp } from "firebase-admin/firestore";
import { Actor, AppError, Ctx, forbidden, getMembership, invalid } from "../services/base";
import { catalog } from "../plugins/catalog";
import {
  connectIntegration, disconnectIntegration, executePluginTool, exportIntegrationConfig, listIntegrations,
  setIntegrationPaused, testIntegration, updateIntegrationPermissions,
} from "../plugins/runtime";
import { resolveModelAccount, startProviderOAuth } from "../plugins/modelAccounts";
import type { ModelProxyConfig } from "../agent/modelProxy";
import {
  createBridgePairing, DeviceAction, executeDeviceAction, listDevices, revokeBridge, setDeviceExposure, setRoomExposure,
} from "../devices/devices";
import { deleteAutomation, saveAutomation, testAutomation } from "../automations/automations";
import {
  agentsAndSkills, createChannelPairing, gatewayStatus, listChannels, privacySummary, setSkillEnabled,
} from "../channels/gateway";
import { disconnectAlexa } from "../alexa/oauth";

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function parse<T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw invalid("Invalid request", r.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

const DeviceActionInput: z.ZodType<DeviceAction> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("power"), value: z.enum(["ON", "OFF"]) }),
  z.object({ type: z.literal("brightness"), value: z.number().int().min(0).max(100) }),
  z.object({ type: z.literal("thermostat"), targetTemperature: z.number().min(10).max(35).optional(), mode: z.enum(["HEAT", "COOL", "AUTO", "ECO", "OFF"]).optional() }),
  z.object({ type: z.literal("lock") }),
  z.object({ type: z.literal("unlock") }),
]);

/**
 * Addendum Phase 1 control-plane routes (integrations, model accounts, devices, automations,
 * channels, agents & skills, gateway status, privacy, audit). Mounted after authentication.
 */
export function mountPhase1Routes(app: Express, ctx: Ctx, wrap: Wrap, platformModel: () => ModelProxyConfig | null) {
  const actor = (req: Request): Actor => ({ uid: req.user!.uid, kind: "user" });
  const p = (req: Request, k: string) => {
    const v = String(req.params[k] ?? "");
    if (!ID.test(v)) throw invalid(`Invalid ${k}`);
    return v;
  };
  const hid = (req: Request) => p(req, "hid");

  // --- catalog & integrations ---
  app.get("/v1/catalog", wrap(async (_req, res) => { res.json({ items: catalog() }); }));
  app.get("/v1/households/:hid/integrations", wrap(async (req, res) => { res.json({ items: await listIntegrations(ctx, actor(req), hid(req)) }); }));
  app.get("/v1/households/:hid/integrations/export", wrap(async (req, res) => { res.json(await exportIntegrationConfig(ctx, actor(req), hid(req))); }));
  app.post("/v1/households/:hid/integrations", wrap(async (req, res) => {
    const input = parse(z.object({
      pluginId: z.string().max(120), config: z.record(z.string(), z.unknown()).optional(), secrets: z.record(z.string(), z.string().max(4096)).optional(),
      scope: z.enum(["household", "personal"]).optional(), consent: z.boolean(),
    }), req.body);
    res.status(201).json(await connectIntegration(ctx, actor(req), hid(req), input));
  }));
  app.post("/v1/households/:hid/integrations/:iid/test", wrap(async (req, res) => { res.json(await testIntegration(ctx, actor(req), hid(req), p(req, "iid"))); }));
  app.post("/v1/households/:hid/integrations/:iid/pause", wrap(async (req, res) => {
    const { paused } = parse(z.object({ paused: z.boolean() }), req.body);
    res.json(await setIntegrationPaused(ctx, actor(req), hid(req), p(req, "iid"), paused));
  }));
  app.patch("/v1/households/:hid/integrations/:iid", wrap(async (req, res) => {
    const input = parse(z.object({
      enabledTools: z.array(z.string().max(64)).max(50).optional(),
      memberAccess: z.union([z.enum(["adults", "managers"]), z.array(z.string().max(128)).max(50)]).optional(),
      isDefault: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional(),
    }), req.body);
    res.json(await updateIntegrationPermissions(ctx, actor(req), hid(req), p(req, "iid"), input));
  }));
  app.delete("/v1/households/:hid/integrations/:iid", wrap(async (req, res) => {
    res.json(await disconnectIntegration(ctx, actor(req), hid(req), p(req, "iid"), { deleteData: req.query.deleteData === "true" }));
  }));
  app.post("/v1/households/:hid/integrations/:iid/tools/:tool", wrap(async (req, res) => {
    const input = parse(z.object({ input: z.record(z.string(), z.unknown()).default({}), confirmed: z.boolean().optional(), idempotencyKey: z.string().min(8).max(120).optional() }), req.body);
    const r = await executePluginTool(ctx, hid(req), actor(req), p(req, "iid"), String(req.params.tool).slice(0, 64), input.input,
      { channel: "app", confirmed: input.confirmed, idempotencyKey: input.idempotencyKey });
    res.status(r.ok ? 200 : 202).json(r);
  }));

  // --- bring-your-own model accounts ---
  app.get("/v1/households/:hid/model-accounts", wrap(async (req, res) => {
    const items = (await listIntegrations(ctx, actor(req), hid(req))).filter((i) => i.category === "ai_provider");
    const active = await resolveModelAccount(ctx, hid(req), req.user!.uid, platformModel()).catch(() => null);
    res.json({
      items,
      active: active ? { label: active.label, source: active.source, integrationId: active.integrationId, modelSimple: active.cfg.modelSimple, modelComplex: active.cfg.modelComplex } : null,
      providers: catalog().filter((c) => c.category === "ai_provider" && c.availability === "available").map((c) => ({ pluginId: c.id, name: c.name, signIn: c.authMethod === "oauth_pkce" ? "oauth" : "api_key" })),
    });
  }));
  app.post("/v1/households/:hid/model-accounts/:provider/start", wrap(async (req, res) => {
    const { scope } = parse(z.object({ scope: z.enum(["personal", "household"]).default("personal") }), req.body);
    res.json(await startProviderOAuth(ctx, actor(req), hid(req), p(req, "provider"), scope));
  }));
  app.get("/v1/households/:hid/model-accounts/:iid/models", wrap(async (req, res) => {
    const r = await executePluginTool(ctx, hid(req), actor(req), p(req, "iid"), "list_models", {}, { channel: "app" });
    res.json(r);
  }));

  // --- devices, rooms, bridges ---
  app.get("/v1/households/:hid/devices", wrap(async (req, res) => { res.json(await listDevices(ctx, hid(req), actor(req))); }));
  app.post("/v1/households/:hid/devices/:did/actions", wrap(async (req, res) => {
    const input = parse(z.object({ action: DeviceActionInput, confirmed: z.boolean().optional(), idempotencyKey: z.string().min(8).max(120).optional() }), req.body);
    const r = await executeDeviceAction(ctx, hid(req), actor(req), p(req, "did"), input.action, { channel: "app", confirmed: input.confirmed, origin: { channel: "app" }, idempotencyKey: input.idempotencyKey });
    res.status(r.status === "verified" ? 200 : 202).json(r);
  }));
  app.patch("/v1/households/:hid/devices/:did", wrap(async (req, res) => {
    const input = parse(z.object({ alexaExposed: z.boolean().optional(), name: z.string().trim().min(1).max(80).optional(), roomId: z.string().max(128).nullable().optional() }), req.body);
    await setDeviceExposure(ctx, actor(req), hid(req), p(req, "did"), input);
    res.status(204).end();
  }));
  app.patch("/v1/households/:hid/rooms/:rid", wrap(async (req, res) => {
    const { alexaExposed } = parse(z.object({ alexaExposed: z.boolean() }), req.body);
    await setRoomExposure(ctx, actor(req), hid(req), p(req, "rid"), alexaExposed);
    res.status(204).end();
  }));
  app.post("/v1/households/:hid/bridges/pairing", wrap(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    res.status(201).json(await createBridgePairing(ctx, actor(req), hid(req), name));
  }));
  app.delete("/v1/households/:hid/bridges/:bid", wrap(async (req, res) => { await revokeBridge(ctx, actor(req), hid(req), p(req, "bid")); res.status(204).end(); }));

  // --- automations ---
  app.get("/v1/households/:hid/automations", wrap(async (req, res) => {
    await activeMember(ctx, hid(req), req.user!.uid);
    const s = await ctx.db.collection(`households/${hid(req)}/automations`).orderBy("createdAt", "desc").limit(100).get();
    res.json({ items: s.docs.map((d) => serialize({ id: d.id, ...d.data() })) });
  }));
  app.post("/v1/households/:hid/automations", wrap(async (req, res) => { res.status(201).json(await saveAutomation(ctx, actor(req), hid(req), req.body)); }));
  app.put("/v1/households/:hid/automations/:aid", wrap(async (req, res) => { res.json(await saveAutomation(ctx, actor(req), hid(req), req.body, p(req, "aid"))); }));
  app.delete("/v1/households/:hid/automations/:aid", wrap(async (req, res) => { await deleteAutomation(ctx, actor(req), hid(req), p(req, "aid")); res.status(204).end(); }));
  app.post("/v1/households/:hid/automations/:aid/test", wrap(async (req, res) => {
    const { execute } = parse(z.object({ execute: z.boolean().default(false) }), req.body);
    res.json(await testAutomation(ctx, actor(req), hid(req), p(req, "aid"), execute));
  }));
  app.get("/v1/households/:hid/automations/:aid/runs", wrap(async (req, res) => {
    await activeMember(ctx, hid(req), req.user!.uid);
    const s = await ctx.db.collection(`households/${hid(req)}/automationRuns`).where("automationId", "==", p(req, "aid")).orderBy("createdAt", "desc").limit(50).get();
    res.json({ items: s.docs.map((d) => serialize({ id: d.id, ...d.data() })) });
  }));

  // --- channels (incl. Alexa) ---
  app.get("/v1/households/:hid/channels", wrap(async (req, res) => { res.json({ items: await listChannels(ctx, actor(req), hid(req)) }); }));
  app.post("/v1/households/:hid/channels/:type/pairing", wrap(async (req, res) => { res.status(201).json(await createChannelPairing(ctx, actor(req), hid(req), p(req, "type"))); }));
  app.delete("/v1/households/:hid/channels/alexa", wrap(async (req, res) => {
    await activeMember(ctx, hid(req), req.user!.uid);
    res.json(await disconnectAlexa(ctx, req.user!.uid, hid(req)));
  }));

  // --- agents & skills, gateway status, privacy, audit ---
  app.get("/v1/households/:hid/agents", wrap(async (req, res) => { res.json(await agentsAndSkills(ctx, actor(req), hid(req))); }));
  app.patch("/v1/households/:hid/skills/:name", wrap(async (req, res) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await setSkillEnabled(ctx, actor(req), hid(req), p(req, "name"), enabled);
    res.status(204).end();
  }));
  app.get("/v1/households/:hid/gateway/status", wrap(async (req, res) => {
    const resolved = await resolveModelAccount(ctx, hid(req), req.user!.uid, platformModel()).catch(() => null);
    res.json(await gatewayStatus(ctx, actor(req), hid(req), !!resolved));
  }));
  app.get("/v1/households/:hid/privacy", wrap(async (req, res) => { res.json(await privacySummary(ctx, actor(req), hid(req))); }));
  app.get("/v1/households/:hid/audit-events", wrap(async (req, res) => {
    const m = await activeMember(ctx, hid(req), req.user!.uid);
    let q: FirebaseFirestore.Query = ctx.db.collection(`households/${hid(req)}/auditEvents`);
    // Managers see the household's audit trail; everyone else sees their own actions.
    if (!["owner", "admin"].includes(m.role)) q = q.where("actorUid", "==", req.user!.uid);
    if (typeof req.query.channel === "string" && /^[a-z_]{1,20}$/.test(req.query.channel)) q = q.where("channel", "==", req.query.channel);
    q = q.orderBy("createdAt", "desc");
    if (typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before))) q = q.startAfter(Timestamp.fromDate(new Date(req.query.before)));
    const s = await q.limit(50).get();
    res.json({ items: s.docs.map((d) => serialize({ id: d.id, ...d.data() })) });
  }));
}

async function activeMember(ctx: Ctx, hid: string, uid: string) {
  const m = await getMembership(ctx, hid, uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  return m;
}

/** Firestore Timestamps → ISO strings for JSON clients. */
export function serialize(v: unknown): unknown {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(serialize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serialize(x)]));
  return v;
}

export { AppError };
