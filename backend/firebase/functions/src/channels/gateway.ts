import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { Actor, AppError, Ctx, forbidden, getMembership, invalid, notFound, paths, sha256, ts } from "../services/base";
import { recordAuditEvent } from "../services/auditEvents";
import { getAutonomy } from "../services/households";
import { catalog } from "../plugins/catalog";

/**
 * Gateway control plane: channels, sender pairing, agents & skills, status, privacy.
 * A channel identity never becomes household membership until a member links it.
 */
export const CHANNEL_TYPES = ["app", "push", "alexa", "webhook", "telegram", "whatsapp", "email", "sms"] as const;
const IMPLEMENTED = new Set(["app", "push", "alexa", "webhook"]);

async function member(ctx: Ctx, hid: string, uid: string) {
  const m = await getMembership(ctx, hid, uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  return m;
}

export async function listChannels(ctx: Ctx, actor: Actor, hid: string) {
  await member(ctx, hid, actor.uid);
  const [docs, alexaLinks] = await Promise.all([
    ctx.db.collection(paths.col(hid, "channels")).get(),
    ctx.db.collection("alexaLinks").where("householdId", "==", hid).where("status", "==", "linked").get(),
  ]);
  const byType = new Map(docs.docs.map((d) => [d.id, d.data()]));
  return CHANNEL_TYPES.map((type) => ({
    type,
    implemented: IMPLEMENTED.has(type),
    status: type === "app" || type === "push" ? "connected"
      : type === "alexa" ? (alexaLinks.empty ? (process.env.ALEXA_SKILL_ID ? "available" : "needs_platform_credentials") : "connected")
      : byType.get(type)?.status ?? (IMPLEMENTED.has(type) ? "available" : "planned"),
    linkedMembers: type === "alexa" ? alexaLinks.docs.map((d) => d.data().uid) : byType.get(type)?.allowedMemberUids ?? [],
    lastActivityAt: byType.get(type)?.lastActivityAt ?? null,
  }));
}

/** One-time pairing code a member gives to an external channel (bot/sender) to link it to themselves. */
export async function createChannelPairing(ctx: Ctx, actor: Actor, hid: string, channelType: string) {
  const m = await member(ctx, hid, actor.uid);
  if (m.role === "staff") throw forbidden("Staff accounts can't link external channels");
  if (!(CHANNEL_TYPES as readonly string[]).includes(channelType) || channelType === "app" || channelType === "push") throw invalid("Unknown channel");
  if (!IMPLEMENTED.has(channelType)) throw new AppError(501, "not_supported_yet", "This channel isn't available yet");
  const code = randomBytes(4).toString("hex").toUpperCase();
  await ctx.db.doc(`${paths.col(hid, "channelPairings")}/${sha256(code).slice(0, 32)}`).set({
    householdId: hid, channelType, uid: actor.uid, status: "pending", createdAt: ts(ctx.now()),
    expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 10 * 60_000)),
  });
  return { code, expiresInSeconds: 600 };
}

/** Called by a channel adapter after the sender presents the code. */
export async function redeemChannelPairing(ctx: Ctx, hid: string, channelType: string, code: string, externalSenderId: string) {
  const ref = ctx.db.doc(`${paths.col(hid, "channelPairings")}/${sha256(code.toUpperCase()).slice(0, 32)}`);
  return ctx.db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw notFound("Pairing code");
    const d = s.data()!;
    if (d.status !== "pending" || d.channelType !== channelType) throw new AppError(410, "pairing_used", "This code was already used");
    if (d.expiresAt.toDate() < ctx.now()) throw new AppError(410, "pairing_expired", "This code has expired");
    tx.update(ref, { status: "linked", externalSenderHash: sha256(externalSenderId), linkedAt: ts(ctx.now()) });
    tx.set(ctx.db.doc(`${paths.col(hid, "channels")}/${channelType}`), { householdId: hid, status: "connected", lastActivityAt: ts(ctx.now()) }, { merge: true });
    return { uid: d.uid as string };
  });
}

// ---------------- agents & skills ----------------

/** Bundled skills (same SKILL.md files the runtimes load). */
export const SKILLS: Array<{ name: string; description: string; version: string }> = [
  { name: "household-manager", description: "Tasks, cleaning, weekly and guest preparation", version: "1.0.0" },
  { name: "finance-manager", description: "Budgets, spending and bills — never moves money", version: "1.0.0" },
  { name: "smart-shopping", description: "Lists, pantry signals and honest estimates", version: "1.0.0" },
  { name: "meal-planner", description: "Weekly meals from recorded preferences", version: "1.0.0" },
  { name: "home-maintenance", description: "Repairs, warranties and service reminders", version: "1.0.0" },
  { name: "family-coordinator", description: "Calendar, conflicts and fair assignments", version: "1.0.0" },
  { name: "household-reports", description: "Factual reports and agent usage", version: "1.0.0" },
  { name: "approval-manager", description: "Explains and tracks approvals", version: "1.0.0" },
];

export async function agentsAndSkills(ctx: Ctx, actor: Actor, hid: string) {
  await member(ctx, hid, actor.uid);
  const [overrides, usage] = await Promise.all([
    ctx.db.collection(paths.col(hid, "skills")).get(),
    ctx.db.collection(paths.col(hid, "agentUsage")).where("createdAt", ">=", Timestamp.fromDate(new Date(ctx.now().getTime() - 30 * 86400_000))).limit(2000).get(),
  ]);
  const ov = new Map(overrides.docs.map((d) => [d.id, d.data()]));
  const bySkill = new Map<string, { runs: number; tokens: number; lastUsedAt: string | null }>();
  usage.docs.forEach((d) => {
    const x = d.data(); const k = x.skill ?? "household-manager";
    const cur = bySkill.get(k) ?? { runs: 0, tokens: 0, lastUsedAt: null };
    cur.runs++; cur.tokens += x.totalTokens ?? 0;
    const at = x.createdAt?.toDate?.().toISOString() ?? null;
    if (at && (!cur.lastUsedAt || at > cur.lastUsedAt)) cur.lastUsedAt = at;
    bySkill.set(k, cur);
  });
  const autonomy = await getAutonomy(ctx, hid);
  return {
    agents: [
      { id: "homehub-hermes-mobile", name: "HomeHub assistant (on your phone)", role: "primary", runtime: "phone", status: autonomy.paused ? "paused" : "active",
        description: "Runs requests you make in the app on this phone; HomeHub's server checks every action." },
      { id: "homehub-hermes", name: "HomeHub assistant (server)", role: "fallback", runtime: "server", status: process.env.HERMES_API_URL ? (autonomy.paused ? "paused" : "active") : "not_configured",
        description: "Runs scheduled assistant jobs when no phone is charging, and future voice/channel requests." },
    ],
    specialists: "Specialists are skills the primary agent loads on demand — not separate always-on agents.",
    skills: SKILLS.map((s) => ({ ...s, enabled: ov.get(s.name)?.enabled !== false, permissions: "household tools filtered by your role", usage30d: bySkill.get(s.name) ?? { runs: 0, tokens: 0, lastUsedAt: null } })),
  };
}

export async function setSkillEnabled(ctx: Ctx, actor: Actor, hid: string, name: string, enabled: boolean) {
  const m = await member(ctx, hid, actor.uid);
  if (!["owner", "admin"].includes(m.role)) throw forbidden("Only managers can change skills");
  if (!SKILLS.some((s) => s.name === name)) throw notFound("Skill");
  if (name === "household-manager" && !enabled) throw invalid("household-manager is the fallback skill and can't be turned off");
  await ctx.db.doc(`${paths.col(hid, "skills")}/${name}`).set({ householdId: hid, enabled, updatedBy: actor.uid, updatedAt: ts(ctx.now()) }, { merge: true });
  await recordAuditEvent(ctx, hid, { actorUid: actor.uid, actorKind: "user", channel: "app", target: { type: "skill", id: name }, requestedAction: enabled ? "skill.enabled" : "skill.disabled", result: "succeeded" });
}

export async function disabledSkills(ctx: Ctx, hid: string): Promise<Set<string>> {
  const s = await ctx.db.collection(paths.col(hid, "skills")).where("enabled", "==", false).get();
  return new Set(s.docs.map((d) => d.id));
}

// ---------------- status & privacy ----------------

export async function gatewayStatus(ctx: Ctx, actor: Actor, hid: string, modelConfigured: boolean) {
  await member(ctx, hid, actor.uid);
  const since = Timestamp.fromDate(new Date(ctx.now().getTime() - 86400_000));
  const [integrations, devices, sessions, runs, events, autonomy, channels] = await Promise.all([
    ctx.db.collection(paths.col(hid, "integrations")).get(),
    ctx.db.collection(paths.col(hid, "devices")).get(),
    ctx.db.collection(paths.col(hid, "agentWorkflows")).where("status", "==", "executing").get(),
    ctx.db.collection(paths.col(hid, "automationRuns")).where("createdAt", ">=", since).get(),
    ctx.db.collection(paths.col(hid, "auditEvents")).orderBy("createdAt", "desc").limit(10).get(),
    getAutonomy(ctx, hid),
    listChannels(ctx, actor, hid),
  ]);
  const count = (xs: Array<{ data(): FirebaseFirestore.DocumentData }>, f: (d: FirebaseFirestore.DocumentData) => string) =>
    xs.reduce<Record<string, number>>((acc, d) => { const k = f(d.data()); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const stale = ctx.now().getTime() - 3600_000;
  return {
    gateway: { status: "ok", checkedAt: ctx.now().toISOString() },
    paused: autonomy.paused,
    agents: { phone: modelConfigured ? "ready" : "needs_model_account", server: process.env.HERMES_API_URL ? "configured" : "not_configured", activeSessions: sessions.size },
    integrations: count(integrations.docs, (d) => d.status),
    channels: channels.map((c) => ({ type: c.type, status: c.status })),
    devices: { total: devices.size, offline: devices.docs.filter((d) => d.data().reachable === false || (d.data().lastSeenAt?.toMillis?.() ?? 0) < stale).length },
    automations24h: count(runs.docs, (d) => d.status),
    recentEvents: events.docs.map((d) => ({ id: d.id, requestedAction: d.data().requestedAction, result: d.data().result, channel: d.data().channel, target: d.data().target, createdAt: d.data().createdAt?.toDate().toISOString() })),
  };
}

export async function privacySummary(ctx: Ctx, actor: Actor, hid: string) {
  await member(ctx, hid, actor.uid);
  const cat = new Map(catalog().map((c) => [c.id, c]));
  const integrations = await ctx.db.collection(paths.col(hid, "integrations")).where("status", "!=", "disconnected").get();
  return {
    integrations: integrations.docs
      .filter((d) => d.data().scope !== "personal" || d.data().ownerUid === actor.uid)
      .map((d) => {
        const x = d.data(); const c = cat.get(x.pluginId);
        return { id: d.id, name: x.name, pluginId: x.pluginId, scope: x.scope, status: x.status, dataCategories: x.dataCategories ?? [], scopesGranted: x.scopesGranted ?? [],
          retention: c?.privacy?.retention ?? null, policyUrl: c?.privacy?.policyUrl ?? null, consentedAt: x.consentedAt?.toDate().toISOString() ?? null, credentialsStored: (x.hasSecrets ?? []).length > 0 };
      }),
    alexa: { storesAudio: false, note: "HomeHub never stores Alexa voice recordings — only the request type, time and result." },
  };
}
