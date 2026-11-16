import Ajv from "ajv";
import { z } from "zod";
import addFormats from "ajv-formats";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { decide } from "../core/autonomy";
import { Actor, AppError, Ctx, forbidden, getMembership, idempotent, invalid, newId, notFound, paths, ts } from "../services/base";
import { recordAuditEvent, Channel } from "../services/auditEvents";
import { getAutonomy } from "../services/households";
import { APPROVAL_ACTIONS, requestApproval } from "../services/approvals";
import { networkAllowed, ToolDecl } from "./manifest";
import { PLUGIN_INDEX } from "./catalog";
import { HomeHubPlugin, PluginContext, ReportedDevice } from "./sdk";
import { defaultSecretStore, SecretStore } from "./secrets";
import { EventOrigin, upsertDeviceFromPlugin } from "../devices/devices";

export type IntegrationStatus = "needs_setup" | "connected" | "action_required" | "paused" | "disconnected" | "unsupported_region" | "error";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validator(key: string, schema: object) {
  let v = validators.get(key);
  if (!v) { v = ajv.compile(schema); validators.set(key, v); }
  return v;
}

const TOOL_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const CALLS_PER_HOUR = Number(process.env.PLUGIN_CALLS_PER_HOUR ?? 300);

export interface RuntimeDeps { secrets?: SecretStore; fetchImpl?: typeof fetch }

function integrationRef(ctx: Ctx, hid: string, iid: string) { return ctx.db.doc(`${paths.col(hid, "integrations")}/${iid}`); }

async function loadIntegration(ctx: Ctx, hid: string, iid: string) {
  const snap = await integrationRef(ctx, hid, iid).get();
  if (!snap.exists) throw notFound("Integration");
  const d = snap.data()!;
  const plugin = PLUGIN_INDEX.get(d.pluginId);
  if (!plugin) throw new AppError(410, "plugin_unavailable", "This integration's plugin is no longer available");
  return { data: d, plugin };
}

/** Who may administer integrations: managers; any adult for their own personal AI accounts. */
async function requireAdmin(ctx: Ctx, hid: string, uid: string, opts: { personalAi?: boolean; ownerUid?: string } = {}) {
  const m = await getMembership(ctx, hid, uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  if (["owner", "admin"].includes(m.role)) return m;
  if (opts.personalAi && m.role === "adult" && (!opts.ownerUid || opts.ownerUid === uid)) return m;
  throw forbidden("Only household managers can manage integrations");
}

/** The narrow capability surface a plugin gets. No database, no host, allowlisted network only. */
export function buildContext(ctx: Ctx, hid: string, iid: string, plugin: HomeHubPlugin, config: Record<string, unknown>, deps: RuntimeDeps, origin?: EventOrigin): PluginContext {
  const secrets = deps.secrets ?? defaultSecretStore(ctx);
  const f = deps.fetchImpl ?? fetch;
  return {
    householdId: hid, integrationId: iid, config: Object.freeze({ ...config }),
    async secret(key) {
      const decl = plugin.manifest.config.find((c) => c.key === key && c.secret);
      if (!decl) throw new Error(`Undeclared secret ${key}`);
      const refs = (await ctx.db.doc(`${paths.col(hid, "integrationSecretsRefs")}/${iid}`).get()).data()?.refs ?? {};
      return refs[key] ? secrets.get(refs[key]) : null;
    },
    async fetch(url, init) {
      if (!networkAllowed(plugin.manifest, url, config)) throw new Error(`Network destination not allowed for ${plugin.manifest.id}: ${new URL(url).host}`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await f(url, { ...init, signal: ctrl.signal, redirect: "error" });
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > MAX_RESPONSE_BYTES) throw new Error("Response too large");
        return res;
      } finally { clearTimeout(timer); }
    },
    store: {
      async get(key) { return ((await ctx.db.doc(`${paths.col(hid, "integrations")}/${iid}/pluginState/${encodeURIComponent(key)}`).get()).data()?.value ?? null) as never; },
      async set(key, value) { await ctx.db.doc(`${paths.col(hid, "integrations")}/${iid}/pluginState/${encodeURIComponent(key)}`).set({ value: value ?? null, updatedAt: ts(ctx.now()) }); },
    },
    async reportDevice(device: ReportedDevice) {
      if (!["smart_home"].includes(plugin.manifest.category)) throw new Error("Only smart-home plugins can report devices");
      await upsertDeviceFromPlugin(ctx, hid, iid, plugin.manifest.id, device, origin ?? { channel: "system" });
    },
    log(message, data) { console.log(JSON.stringify({ plugin: plugin.manifest.id, hid, iid, message, ...data })); },
    now: () => ctx.now(),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AppError(504, "plugin_timeout", `${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------- lifecycle ----------------

export interface ConnectInput { pluginId: string; config?: Record<string, unknown>; secrets?: Record<string, string>; scope?: "household" | "personal"; consent: boolean }

export async function connectIntegration(ctx: Ctx, actor: Actor, hid: string, input: ConnectInput, deps: RuntimeDeps = {}) {
  const plugin = PLUGIN_INDEX.get(input.pluginId);
  if (!plugin) throw invalid("This integration isn't available yet");
  if (!input.consent) throw invalid("Review and accept the permissions to connect");
  const m = plugin.manifest;
  const personalAi = m.category === "ai_provider" && input.scope === "personal";
  await requireAdmin(ctx, hid, actor.uid, { personalAi });
  const hh = (await ctx.db.doc(paths.household(hid)).get()).data();
  if (hh?.country && !m.regions.includes("*") && !m.regions.includes(hh.country)) throw new AppError(409, "unsupported_region", `${m.name} isn't supported in your region`);

  // Validate configuration against declared fields; secrets go to the secret store only.
  const config: Record<string, unknown> = {};
  const secretValues: Record<string, string> = {};
  for (const f of m.config) {
    const v = f.secret ? input.secrets?.[f.key] : input.config?.[f.key];
    if (v === undefined || v === "" || v === null) { if (f.required) throw invalid(`${f.label} is required`); continue; }
    if (f.secret) { if (typeof v !== "string" || v.length > 4096) throw invalid(`${f.label} is invalid`); secretValues[f.key] = v; continue; }
    if (f.type === "url") { try { if (new URL(String(v)).protocol !== "https:") throw 0; } catch { throw invalid(`${f.label} must be an https URL`); } }
    if (f.type === "number" && typeof v !== "number") throw invalid(`${f.label} must be a number`);
    if (f.type === "boolean" && typeof v !== "boolean") throw invalid(`${f.label} must be true or false`);
    if (f.type === "select" && !f.options?.includes(String(v))) throw invalid(`${f.label} has an unsupported value`);
    config[f.key] = v;
  }
  const unknownKeys = [...Object.keys(input.config ?? {}), ...Object.keys(input.secrets ?? {})].filter((k) => !m.config.some((c) => c.key === k));
  if (unknownKeys.length) throw invalid(`Unknown settings: ${unknownKeys.join(", ")}`);

  const iid = newId();
  const store = deps.secrets ?? defaultSecretStore(ctx);
  const refs: Record<string, string> = {};
  for (const [k, v] of Object.entries(secretValues)) refs[k] = await store.put(`${hid}-${iid}-${k}`, v);
  await ctx.db.doc(`${paths.col(hid, "integrationSecretsRefs")}/${iid}`).set({ householdId: hid, refs, updatedAt: ts(ctx.now()) });
  await integrationRef(ctx, hid, iid).set({
    householdId: hid, pluginId: m.id, pluginVersion: m.version, name: m.name, category: m.category, tier: m.tier,
    status: "needs_setup" as IntegrationStatus, scope: m.category === "ai_provider" ? (input.scope ?? "personal") : "household",
    ownerUid: actor.uid, config, hasSecrets: Object.keys(refs),
    enabledTools: m.tools.map((t) => t.name), memberAccess: "adults",
    dataCategories: m.dataCategories, scopesGranted: m.auth.scopes,
    consentedBy: actor.uid, consentedAt: ts(ctx.now()), createdAt: ts(ctx.now()), updatedAt: ts(ctx.now()),
    lastHealth: null, lastHealthAt: null, lastError: null, lastSuccessAt: null,
    isDefault: false,
  });
  await event(ctx, hid, iid, "connected", { pluginId: m.id });
  await recordAuditEvent(ctx, hid, { actorUid: actor.uid, actorKind: "user", channel: "app", pluginId: m.id, integrationId: iid, target: { type: "integration", id: iid, name: m.name }, requestedAction: "integration.connect", result: "succeeded" });
  const status = await setupAndCheck(ctx, hid, iid, deps);
  return { integrationId: iid, status };
}

async function setupAndCheck(ctx: Ctx, hid: string, iid: string, deps: RuntimeDeps): Promise<IntegrationStatus> {
  const { data, plugin } = await loadIntegration(ctx, hid, iid);
  const pctx = buildContext(ctx, hid, iid, plugin, data.config ?? {}, deps);
  let status: IntegrationStatus = "connected";
  let message: string | null = null;
  try {
    if (plugin.handlers.setup && data.status === "needs_setup") await withTimeout(plugin.handlers.setup(pctx), TOOL_TIMEOUT_MS, "Setup");
    if (plugin.handlers.healthCheck) {
      const h = await withTimeout(plugin.handlers.healthCheck(pctx), TOOL_TIMEOUT_MS, "Health check");
      if (!h.ok) { status = "action_required"; message = h.message ?? "Needs attention"; }
    }
  } catch (e) {
    status = "error"; message = (e as Error).message.slice(0, 300);
  }
  await integrationRef(ctx, hid, iid).update({ status, lastHealth: status === "connected" ? "ok" : "failed", lastHealthAt: ts(ctx.now()), lastError: message, updatedAt: ts(ctx.now()) });
  await event(ctx, hid, iid, "health_check", { status, message });
  return status;
}

export async function testIntegration(ctx: Ctx, actor: Actor, hid: string, iid: string, deps: RuntimeDeps = {}) {
  const { data } = await loadIntegration(ctx, hid, iid);
  await requireAdmin(ctx, hid, actor.uid, { personalAi: data.category === "ai_provider", ownerUid: data.ownerUid });
  if (data.status === "paused" || data.status === "disconnected") throw new AppError(409, "integration_inactive", `Integration is ${data.status}`);
  const status = await setupAndCheck(ctx, hid, iid, deps);
  const after = (await integrationRef(ctx, hid, iid).get()).data()!;
  return { status, message: after.lastError };
}

export async function setIntegrationPaused(ctx: Ctx, actor: Actor, hid: string, iid: string, paused: boolean) {
  const { data } = await loadIntegration(ctx, hid, iid);
  await requireAdmin(ctx, hid, actor.uid, { personalAi: data.category === "ai_provider", ownerUid: data.ownerUid });
  if (data.status === "disconnected") throw new AppError(409, "integration_inactive", "Integration is disconnected");
  await integrationRef(ctx, hid, iid).update({ status: paused ? "paused" : "connected", updatedAt: ts(ctx.now()), pausedBy: paused ? actor.uid : null });
  await event(ctx, hid, iid, paused ? "paused" : "resumed", {});
  await recordAuditEvent(ctx, hid, { actorUid: actor.uid, actorKind: "user", channel: "app", pluginId: data.pluginId, integrationId: iid, target: { type: "integration", id: iid, name: data.name }, requestedAction: paused ? "integration.pause" : "integration.resume", result: "succeeded" });
}

/** Revoke: plugin disconnect hook, delete stored secrets, optionally delete plugin data and devices. */
export async function disconnectIntegration(ctx: Ctx, actor: Actor, hid: string, iid: string, opts: { deleteData?: boolean } = {}, deps: RuntimeDeps = {}) {
  const { data, plugin } = await loadIntegration(ctx, hid, iid);
  await requireAdmin(ctx, hid, actor.uid, { personalAi: data.category === "ai_provider", ownerUid: data.ownerUid });
  const pctx = buildContext(ctx, hid, iid, plugin, data.config ?? {}, deps);
  const notes: string[] = [];
  try { await plugin.handlers.disconnect?.(pctx); } catch (e) { notes.push(`disconnect hook: ${(e as Error).message}`); }
  if (opts.deleteData) { try { await plugin.handlers.deleteData?.(pctx); } catch (e) { notes.push(`deleteData hook: ${(e as Error).message}`); } }
  const store = deps.secrets ?? defaultSecretStore(ctx);
  const refsDoc = ctx.db.doc(`${paths.col(hid, "integrationSecretsRefs")}/${iid}`);
  const refs = (await refsDoc.get()).data()?.refs ?? {};
  for (const r of Object.values(refs)) await store.delete(r as string);
  await refsDoc.delete();
  if (opts.deleteData) {
    const devices = await ctx.db.collection(paths.col(hid, "devices")).where("integrationId", "==", iid).get();
    const batch = ctx.db.batch();
    devices.docs.forEach((d) => batch.delete(d.ref));
    const state = await integrationRef(ctx, hid, iid).collection("pluginState").get();
    state.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await integrationRef(ctx, hid, iid).update({ status: "disconnected", hasSecrets: [], isDefault: false, disconnectedAt: ts(ctx.now()), disconnectedBy: actor.uid, updatedAt: ts(ctx.now()) });
  await event(ctx, hid, iid, "disconnected", { deleteData: !!opts.deleteData, notes });
  await recordAuditEvent(ctx, hid, { actorUid: actor.uid, actorKind: "user", channel: "app", pluginId: data.pluginId, integrationId: iid, target: { type: "integration", id: iid, name: data.name }, requestedAction: "integration.disconnect", result: "succeeded", details: { deleteData: !!opts.deleteData } });
  return { status: "disconnected", notes };
}

export async function updateIntegrationPermissions(
  ctx: Ctx, actor: Actor, hid: string, iid: string,
  input: { enabledTools?: string[]; memberAccess?: "adults" | "managers" | string[]; isDefault?: boolean; config?: Record<string, unknown> },
) {
  const { data, plugin } = await loadIntegration(ctx, hid, iid);
  await requireAdmin(ctx, hid, actor.uid, { personalAi: data.category === "ai_provider", ownerUid: data.ownerUid });
  const patch: Record<string, unknown> = { updatedAt: ts(ctx.now()) };
  if (input.enabledTools) {
    const known = new Set(plugin.manifest.tools.map((t) => t.name));
    const bad = input.enabledTools.filter((t) => !known.has(t));
    if (bad.length) throw invalid(`Unknown tools: ${bad.join(", ")}`);
    patch.enabledTools = input.enabledTools;
  }
  if (input.memberAccess !== undefined) patch.memberAccess = input.memberAccess;
  if (input.config) {
    for (const [k, v] of Object.entries(input.config)) {
      const f = plugin.manifest.config.find((c) => c.key === k && !c.secret);
      if (!f) throw invalid(`Unknown or secret setting ${k}`);
      patch[`config.${k}`] = v;
    }
  }
  if (input.isDefault !== undefined) {
    if (data.category !== "ai_provider") throw invalid("Only model accounts can be a default");
    if (input.isDefault && data.scope === "household") await requireAdmin(ctx, hid, actor.uid);
    if (input.isDefault) {
      // One default per scope (per owner for personal accounts).
      let q = ctx.db.collection(paths.col(hid, "integrations")).where("category", "==", "ai_provider").where("scope", "==", data.scope).where("isDefault", "==", true);
      if (data.scope === "personal") q = q.where("ownerUid", "==", data.ownerUid);
      const others = await q.get();
      const batch = ctx.db.batch();
      others.docs.filter((d) => d.id !== iid).forEach((d) => batch.update(d.ref, { isDefault: false }));
      await batch.commit();
    }
    patch.isDefault = input.isDefault;
  }
  await integrationRef(ctx, hid, iid).update(patch);
  await recordAuditEvent(ctx, hid, { actorUid: actor.uid, actorKind: "user", channel: "app", pluginId: data.pluginId, integrationId: iid, target: { type: "integration", id: iid, name: data.name }, requestedAction: "integration.permissions_updated", result: "succeeded", details: { fields: Object.keys(input) } });
}

/** Non-secret configuration export (never credentials). */
export async function exportIntegrationConfig(ctx: Ctx, actor: Actor, hid: string) {
  await requireAdmin(ctx, hid, actor.uid);
  const snap = await ctx.db.collection(paths.col(hid, "integrations")).where("status", "!=", "disconnected").get();
  return {
    exportedAt: ctx.now().toISOString(), formatVersion: 1,
    integrations: snap.docs.map((d) => ({ pluginId: d.data().pluginId, pluginVersion: d.data().pluginVersion, config: d.data().config, enabledTools: d.data().enabledTools, memberAccess: d.data().memberAccess })),
    note: "Credentials are never exported. Re-enter secrets after importing.",
  };
}

async function event(ctx: Ctx, hid: string, iid: string, type: string, data: Record<string, unknown>) {
  await ctx.db.collection(paths.col(hid, "integrationEvents")).add({ householdId: hid, integrationId: iid, type, data, createdAt: ts(ctx.now()), expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 30 * 86400_000)) });
}

// ---------------- tool execution ----------------

export interface ExecOptions {
  channel: Channel;
  idempotencyKey?: string;
  /** A person explicitly confirmed this exact action in the app (for confirmation:"confirm" tools). */
  confirmed?: boolean;
  /** Set only by the approval executor after a person approved. */
  approvedBy?: string;
  approvalId?: string;
  /** Where the request came from; carried into device events so automation chains stay bounded. */
  origin?: EventOrigin;
}

export type ExecResult =
  | { ok: true; data: unknown }
  | { ok: false; status: "approval_required"; approvalId: string; message: string }
  | { ok: false; status: "confirmation_required"; message: string };

function canMemberUse(access: unknown, role: string, uid: string): boolean {
  if (Array.isArray(access)) return access.includes(uid);
  if (access === "managers") return role === "owner" || role === "admin";
  return ["owner", "admin", "adult"].includes(role);
}

export async function executePluginTool(
  ctx: Ctx, hid: string, actor: Actor, iid: string, toolName: string, input: Record<string, unknown>, opts: ExecOptions, deps: RuntimeDeps = {},
): Promise<ExecResult> {
  const { data, plugin } = await loadIntegration(ctx, hid, iid);
  const tool = plugin.manifest.tools.find((t) => t.name === toolName);
  const audit = (result: "succeeded" | "failed" | "denied" | "approval_required", details: Record<string, unknown> = {}, approvalId?: string) =>
    recordAuditEvent(ctx, hid, { actorUid: actor.uid, actorKind: actor.kind === "agent" ? "agent" : actor.kind === "system" ? "automation" : "user", channel: opts.channel,
      agentId: actor.agentId ?? null, pluginId: data.pluginId, integrationId: iid, tool: toolName, target: { type: "integration", id: iid, name: data.name },
      requestedAction: `plugin.${toolName}`, result, approvalId: approvalId ?? opts.approvalId ?? null, details });
  if (!tool) throw invalid(`Unknown tool ${toolName}`);

  // Status, kill switches and enablement.
  if (data.status !== "connected") { await audit("denied", { reason: `integration ${data.status}` }); throw new AppError(409, "integration_inactive", `${data.name} is ${data.status.replace("_", " ")}`); }
  const kill = (await ctx.db.doc(`pluginCatalog/${plugin.manifest.id}`).get()).data();
  if (kill?.killSwitch) { await audit("denied", { reason: "kill switch" }); throw new AppError(503, "plugin_disabled", `${data.name} is temporarily disabled by HomeHub`); }
  if (!(data.enabledTools ?? []).includes(toolName)) { await audit("denied", { reason: "tool disabled" }); throw forbidden(`${tool.description} is turned off for this integration`); }

  // Who is acting.
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  if (!canMemberUse(data.memberAccess, m.role, actor.uid)) {
    await audit("denied", { reason: "member access" });
    throw forbidden("You don't have access to this integration");
  }

  // Validate input.
  const v = validator(`${plugin.manifest.id}@${plugin.manifest.version}:${toolName}:in`, tool.input);
  if (!v(input)) throw invalid("Invalid input", (v.errors ?? []).slice(0, 5).map((e) => ({ path: e.instancePath, message: e.message })));

  // Policy.
  const gate = await policyGate(ctx, hid, actor, tool, opts);
  if (gate === "confirm") return { ok: false, status: "confirmation_required", message: `Confirm: ${tool.description}` };
  if (gate !== "allow") {
    if (gate === "paused") { await audit("denied", { reason: "emergency pause" }); throw new AppError(423, "paused", "Automated actions are paused for this household"); }
    const ap = await requestApproval(ctx, hid, actor, {
      action: "plugin_tool", title: `${data.name}: ${tool.description}`, rationale: gate,
      params: { integrationId: iid, tool: toolName, input, channel: opts.channel },
      consequences: tool.physicalSafety ? "This changes a physical safety device." : undefined,
    });
    await audit("approval_required", { reason: gate }, ap.approvalId);
    return { ok: false, status: "approval_required", approvalId: ap.approvalId, message: `${gate}. Approval ${ap.approvalId} requested — not done yet.` };
  }

  // Quota.
  const window = Math.floor(ctx.now().getTime() / 3600_000);
  const quotaRef = ctx.db.doc(`rateLimits/plugin_${hid}_${window}`);
  const used = await ctx.db.runTransaction(async (tx) => { const n = ((await tx.get(quotaRef)).data()?.count ?? 0) + 1; tx.set(quotaRef, { count: n }); return n; });
  if (used > CALLS_PER_HOUR) { await audit("denied", { reason: "quota" }); throw new AppError(429, "plugin_quota", "Integration call limit reached for this hour"); }

  // Execute (idempotent when the tool declares it and a key is given).
  const pctx = buildContext(ctx, hid, iid, plugin, data.config ?? {}, deps, opts.origin ?? { channel: opts.channel });
  const run = async () => {
    const out = await withTimeout(Promise.resolve(plugin.handlers.tools[toolName](pctx, input)), TOOL_TIMEOUT_MS, tool.description);
    if (tool.output) {
      const ov = validator(`${plugin.manifest.id}@${plugin.manifest.version}:${toolName}:out`, tool.output);
      if (!ov(out)) throw new AppError(502, "plugin_bad_output", "The integration returned an unexpected result");
    }
    return { value: out as unknown };
  };
  try {
    const result = tool.access === "write" && opts.idempotencyKey && tool.idempotent
      ? await idempotent(ctx, { hid, uid: actor.uid, op: `plugin:${iid}:${toolName}` }, opts.idempotencyKey, run)
      : await run();
    await integrationRef(ctx, hid, iid).update({ lastSuccessAt: ts(ctx.now()), lastError: null, callCount: FieldValue.increment(1) });
    await audit("succeeded");
    return { ok: true, data: result.value };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await integrationRef(ctx, hid, iid).update({ lastError: msg, lastErrorAt: ts(ctx.now()), errorCount: FieldValue.increment(1) });
    await audit("failed", { error: msg });
    if (e instanceof AppError) throw e;
    throw new AppError(502, "plugin_failed", `${data.name}: ${msg}`);
  }
}

/**
 * Safety policy for integration tools (addendum §3):
 *  - reads: allowed;
 *  - "approval" tools (incl. every critical/physical-safety tool): approval unless executing an approved request;
 *  - "confirm" tools: a person in the app must confirm; agents/automations/voice need approval;
 *  - other writes by agents/automations follow the household autonomy policy and emergency pause.
 */
async function policyGate(ctx: Ctx, hid: string, actor: Actor, tool: ToolDecl, opts: ExecOptions): Promise<"allow" | "confirm" | "paused" | string> {
  if (tool.access === "read") return "allow";
  if (opts.approvedBy) return "allow";
  if (tool.confirmation === "approval" || tool.physicalSafety || tool.risk === "critical") return "This action always needs a person's approval";
  const automated = actor.kind !== "user" || opts.channel === "automation";
  if (automated) {
    const autonomy = await getAutonomy(ctx, hid);
    if (autonomy.paused) return "paused";
    if (tool.confirmation === "confirm") return "Automated requests for this action need approval";
    const d = decide(autonomy, tool.risk === "low" ? "reversible_write" : "bounded_write");
    return d.outcome === "allow" ? "allow" : d.outcome === "deny" ? "paused" : d.reason;
  }
  if (tool.confirmation === "confirm" && !opts.confirmed) return "confirm";
  return "allow";
}

// The approval executor runs the stored call as the approving person.
APPROVAL_ACTIONS.plugin_tool = {
  schema: z.object({ integrationId: z.string().max(128), tool: z.string().max(64), input: z.record(z.string(), z.unknown()), channel: z.string().max(32) }),
  run: async (ctx, hid, actor, p: { integrationId: string; tool: string; input: Record<string, unknown>; channel: Channel }) => {
    const r = await executePluginTool(ctx, hid, actor, p.integrationId, p.tool, p.input, { channel: p.channel, approvedBy: actor.uid });
    if (!r.ok) throw new Error(r.message);
    return { result: r.data as Record<string, unknown> };
  },
};


// ---------------- listing ----------------

/** Integrations a member can see: household ones, plus their own personal AI accounts. Never secrets. */
export async function listIntegrations(ctx: Ctx, actor: Actor, hid: string) {
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  const snap = await ctx.db.collection(paths.col(hid, "integrations")).where("status", "!=", "disconnected").get();
  return snap.docs
    .filter((d) => d.data().scope !== "personal" || d.data().ownerUid === actor.uid)
    .map((d) => {
      const x = d.data();
      return {
        id: d.id, pluginId: x.pluginId, name: x.name, category: x.category, scope: x.scope, status: x.status, isDefault: x.isDefault === true,
        enabledTools: x.enabledTools ?? [], memberAccess: x.memberAccess ?? "adults", config: x.config ?? {}, hasSecrets: x.hasSecrets ?? [],
        lastHealth: x.lastHealth ?? null, connectedAt: x.connectedAt?.toDate?.().toISOString() ?? null, ownedByMe: x.ownerUid === actor.uid,
      };
    });
}

// ---------------- inbound signed webhooks ----------------

const WEBHOOK_WINDOW_S = 300;

/**
 * Inbound event for a connected webhook integration. Verified before the plugin sees it:
 * HMAC-SHA256 over `${timestamp}.${rawBody}`, ±5 minute window, single-use signature
 * (replay store). The payload is untrusted data: it can only become automation events.
 */
export async function receiveWebhook(
  ctx: Ctx, hid: string, iid: string, headers: { timestamp?: string; signature?: string }, rawBody: string, deps: RuntimeDeps = {},
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(hid) || !/^[A-Za-z0-9_-]{1,128}$/.test(iid)) throw notFound("Webhook");
  const snap = await integrationRef(ctx, hid, iid).get();
  const data = snap.data();
  // Same answer for unknown/disconnected/paused so endpoints can't be probed.
  if (!data || data.pluginId !== "homehub.webhook" || data.status !== "connected") throw notFound("Webhook");
  const t = Number(headers.timestamp);
  if (!Number.isInteger(t) || Math.abs(ctx.now().getTime() / 1000 - t) > WEBHOOK_WINDOW_S) throw new AppError(401, "stale_signature", "Timestamp outside the allowed window");
  const refs = (await ctx.db.doc(`${paths.col(hid, "integrationSecretsRefs")}/${iid}`).get()).data()?.refs ?? {};
  const secret = refs.signingSecret ? await (deps.secrets ?? defaultSecretStore(ctx)).get(refs.signingSecret) : null;
  if (!secret) throw new AppError(401, "bad_signature", "Signature check failed");
  const { signWebhook } = await import("./builtins/webhook");
  const expected = Buffer.from(signWebhook(secret, t, rawBody));
  const given = Buffer.from(String(headers.signature ?? ""));
  const { timingSafeEqual, createHash } = await import("node:crypto");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new AppError(401, "bad_signature", "Signature check failed");
  // Replay protection: each signature is accepted once.
  const replayRef = ctx.db.doc(`${paths.col(hid, "integrationEvents")}/sig_${createHash("sha256").update(given).digest("hex").slice(0, 40)}`);
  try {
    await replayRef.create({ integrationId: iid, kind: "webhook_signature", createdAt: ts(ctx.now()), expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 2 * WEBHOOK_WINDOW_S * 1000)) });
  } catch {
    throw new AppError(409, "replayed", "This event was already received");
  }
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { throw invalid("Body must be JSON"); }
  const plugin = PLUGIN_INDEX.get(data.pluginId)!;
  const pctx = buildContext(ctx, hid, iid, plugin, data.config ?? {}, deps);
  const out = await plugin.handlers.onEvent?.(pctx, "webhook.received", payload) ?? { events: [] };
  const events = out.events.slice(0, 10);
  await recordAuditEvent(ctx, hid, { actorUid: null, actorKind: "integration", channel: "webhook", pluginId: data.pluginId, integrationId: iid, target: { type: "integration", id: iid, name: data.name },
    requestedAction: "webhook.received", result: "succeeded", details: { events: events.map((e) => e.type) } });
  await integrationRef(ctx, hid, iid).update({ lastEventAt: ts(ctx.now()) });
  return events;
}

/**
 * Background refresh for bridge plugins (Home Assistant): runs from the 15-minute scheduler so device
 * state, rooms and new devices stay current between app actions. Read-only and system-initiated, so
 * it doesn't write a per-run audit event; failures are recorded on the integration (lastError).
 */
export async function syncBridgeIntegrations(ctx: Ctx, deps: RuntimeDeps = {}, limit = 50): Promise<{ synced: number; failed: number }> {
  const snap = await ctx.db.collectionGroup("integrations").where("pluginId", "==", "homehub.homeassistant").where("status", "==", "connected").limit(limit).get();
  let synced = 0, failed = 0;
  for (const doc of snap.docs) {
    const hid = doc.ref.parent.parent!.id;
    const d = doc.data();
    const plugin = PLUGIN_INDEX.get(d.pluginId);
    if (!plugin?.handlers.tools.sync_devices || d.paused) continue;
    try {
      await plugin.handlers.tools.sync_devices(buildContext(ctx, hid, doc.id, plugin, d.config ?? {}, deps), {});
      await doc.ref.update({ lastSyncAt: ts(ctx.now()), lastError: null });
      synced++;
    } catch (e) {
      await doc.ref.update({ lastError: String((e as Error).message ?? e).slice(0, 200), lastSyncAt: ts(ctx.now()) });
      failed++;
    }
  }
  return { synced, failed };
}
