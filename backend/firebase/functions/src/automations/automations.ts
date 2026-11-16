import { DateTime } from "luxon";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { Actor, AppError, Ctx, forbidden, getMembership, invalid, newId, notFound, paths, ts } from "../services/base";
import { recordAuditEvent } from "../services/auditEvents";
import { getAutonomy } from "../services/households";
import { createTask } from "../services/tasks";
import { addShoppingItem } from "../services/food";
import { notify } from "../services/notifications";
import { executeDeviceAction, EventOrigin } from "../devices/devices";

/**
 * Deterministic household automations (addendum §8):
 *   trigger → conditions → policy check → [approval gate] → typed action → verification → audit/notification
 * Agent reasoning is not used here; ambiguous work belongs to Hermes via the normal run path.
 * Safety: an automation never re-triggers itself, chains stop at depth 3, cooldowns and daily caps
 * stop runaway loops, and the household emergency pause halts every automated action.
 */
export const TriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schedule"), time: z.string().regex(/^\d{2}:\d{2}$/), days: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]) }),
  z.object({ type: z.literal("device_state"), deviceId: z.string().max(64), property: z.enum(["power", "lock", "contact", "motion", "temperature", "humidity", "brightness"]) }),
  z.object({ type: z.literal("pantry_low") }),
  z.object({ type: z.literal("bill_due"), withinDays: z.number().int().min(0).max(30).default(3) }),
  z.object({ type: z.literal("webhook"), integrationId: z.string().max(128), eventType: z.string().max(80).optional() }),
  z.object({ type: z.literal("manual") }),
]);

export const ConditionSchema = z.object({
  field: z.string().max(80), // e.g. "event.value", "device:<id>.power", "time.hour", "household.paused"
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
});

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("device_action"), deviceId: z.string().max(64), action: z.enum(["power_on", "power_off", "lock", "set_temperature"]), value: z.number().min(16).max(30).optional() }),
  z.object({ type: z.literal("create_task"), title: z.string().min(1).max(200), assigneeUid: z.string().max(128).optional(), dueInHours: z.number().int().min(0).max(720).optional() }),
  z.object({ type: z.literal("notify"), title: z.string().min(1).max(120), body: z.string().max(300), audience: z.enum(["adults", "managers", "everyone"]).default("adults") }),
  z.object({ type: z.literal("add_shopping_item"), listId: z.string().max(128), name: z.string().min(1).max(120), quantity: z.number().positive().max(1000).default(1), unit: z.string().max(20).default("pcs") }),
]);

export const AutomationInput = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  trigger: TriggerSchema,
  conditions: z.array(ConditionSchema).max(10).default([]),
  actions: z.array(ActionSchema).min(1).max(10),
  cooldownMinutes: z.number().int().min(0).max(1440).default(5),
  maxRunsPerDay: z.number().int().min(1).max(200).default(24),
});
export type Automation = z.infer<typeof AutomationInput>;

export interface TriggerEvent {
  type: "schedule" | "device.state_changed" | "pantry.low" | "bill.due" | "webhook" | "manual";
  deviceId?: string;
  property?: string;
  value?: unknown;
  integrationId?: string;
  eventType?: string;
  data?: Record<string, unknown>;
  origin: EventOrigin;
}

async function requireManager(ctx: Ctx, hid: string, uid: string) {
  const m = await getMembership(ctx, hid, uid);
  if (!m || !["owner", "admin"].includes(m.role)) throw forbidden("Only managers can manage automations");
  return m;
}

export async function saveAutomation(ctx: Ctx, actor: Actor, hid: string, input: unknown, id?: string) {
  await requireManager(ctx, hid, actor.uid);
  const parsed = AutomationInput.safeParse(input);
  if (!parsed.success) throw invalid("Invalid automation", parsed.error.issues.slice(0, 6).map((i) => ({ path: i.path.join("."), message: i.message })));
  const a = parsed.data;
  // Device references must belong to this household.
  for (const ref of [...a.actions.filter((x) => x.type === "device_action").map((x) => (x as { deviceId: string }).deviceId), ...(a.trigger.type === "device_state" ? [a.trigger.deviceId] : [])]) {
    if (!(await ctx.db.doc(`${paths.col(hid, "devices")}/${ref}`).get()).exists) throw invalid(`Unknown device ${ref}`);
  }
  const aid = id ?? newId();
  const ref = ctx.db.doc(`${paths.col(hid, "automations")}/${aid}`);
  const prev = id ? await ref.get() : null;
  if (id && !prev?.exists) throw notFound("Automation");
  await ref.set({
    householdId: hid, ...a, updatedBy: actor.uid, updatedAt: ts(ctx.now()),
    ...(prev?.exists ? {} : { createdBy: actor.uid, createdAt: ts(ctx.now()), lastRunAt: null, lastStatus: null, runsToday: 0, runsDay: null }),
    nextScheduledAt: a.trigger.type === "schedule" ? Timestamp.fromDate(await nextScheduleSlot(ctx, hid, a.trigger)) : null,
  }, { merge: true });
  await recordAuditEvent(ctx, hid, { actorUid: actor.uid, actorKind: "user", channel: "app", target: { type: "automation", id: aid, name: a.name }, requestedAction: id ? "automation.updated" : "automation.created", result: "succeeded" });
  return { id: aid };
}

async function nextScheduleSlot(ctx: Ctx, hid: string, t: { time: string; days: number[] }): Promise<Date> {
  const tz = (await ctx.db.doc(paths.household(hid)).get()).data()?.timezone ?? "UTC";
  const [h, m] = t.time.split(":").map(Number);
  let d = DateTime.fromJSDate(ctx.now()).setZone(tz).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  for (let i = 0; i < 8; i++) {
    if (d.toJSDate() > ctx.now() && t.days.includes(d.weekday)) return d.toJSDate();
    d = d.plus({ days: 1 });
  }
  return d.toJSDate();
}

export async function deleteAutomation(ctx: Ctx, actor: Actor, hid: string, aid: string) {
  await requireManager(ctx, hid, actor.uid);
  await ctx.db.doc(`${paths.col(hid, "automations")}/${aid}`).delete();
}

function matchesTrigger(a: Automation & { id: string }, e: TriggerEvent): boolean {
  const t = a.trigger;
  switch (t.type) {
    case "device_state": return e.type === "device.state_changed" && e.deviceId === t.deviceId && e.property === t.property;
    case "pantry_low": return e.type === "pantry.low";
    case "bill_due": return e.type === "bill.due";
    case "webhook": return e.type === "webhook" && e.integrationId === t.integrationId && (!t.eventType || e.eventType === t.eventType);
    case "schedule": return e.type === "schedule";
    case "manual": return e.type === "manual";
  }
}

async function conditionValue(ctx: Ctx, hid: string, field: string, e: TriggerEvent): Promise<unknown> {
  if (field === "event.value") return e.value;
  if (field.startsWith("event.data.")) return e.data?.[field.slice(11)];
  if (field === "time.hour" || field === "time.weekday") {
    const tz = (await ctx.db.doc(paths.household(hid)).get()).data()?.timezone ?? "UTC";
    const n = DateTime.fromJSDate(ctx.now()).setZone(tz);
    return field === "time.hour" ? n.hour : n.weekday;
  }
  const m = /^device:([A-Za-z0-9_-]+)\.(\w+)$/.exec(field);
  if (m) return (await ctx.db.doc(`${paths.col(hid, "devices")}/${m[1]}`).get()).data()?.state?.[m[2]];
  return undefined;
}

function compare(a: unknown, op: string, b: unknown): boolean {
  switch (op) {
    case "eq": return a === b;
    case "neq": return a !== b;
    case "gt": return typeof a === "number" && typeof b === "number" && a > b;
    case "gte": return typeof a === "number" && typeof b === "number" && a >= b;
    case "lt": return typeof a === "number" && typeof b === "number" && a < b;
    case "lte": return typeof a === "number" && typeof b === "number" && a <= b;
    case "in": return Array.isArray(b) && b.includes(a as never);
    default: return false;
  }
}

export interface RunOutcome { automationId: string; status: "succeeded" | "partial" | "failed" | "skipped" | "previewed"; reason?: string; steps: Array<{ action: string; status: string; detail?: string }> }

/** Entry point for every event source. Returns what ran (or would run, in preview). */
export async function processEvent(ctx: Ctx, hid: string, e: TriggerEvent, only?: string, preview = false): Promise<RunOutcome[]> {
  const chain = e.origin.automationChain ?? [];
  if (chain.length >= 3) return []; // chained automations stop at depth 3
  let q = ctx.db.collection(paths.col(hid, "automations")).where("enabled", "==", true);
  if (only) q = ctx.db.collection(paths.col(hid, "automations")).where("__name__", "==", ctx.db.doc(`${paths.col(hid, "automations")}/${only}`));
  const snap = await q.get();
  const out: RunOutcome[] = [];
  for (const d of snap.docs) {
    const a = { id: d.id, ...(d.data() as Automation) };
    if (!only && !matchesTrigger(a, e)) continue;
    if (chain.includes(a.id)) { out.push({ automationId: a.id, status: "skipped", reason: "would re-trigger itself", steps: [] }); continue; }
    out.push(await runAutomation(ctx, hid, a, d.data(), e, preview));
  }
  return out;
}

async function runAutomation(ctx: Ctx, hid: string, a: Automation & { id: string }, raw: FirebaseFirestore.DocumentData, e: TriggerEvent, preview: boolean): Promise<RunOutcome> {
  const ref = ctx.db.doc(`${paths.col(hid, "automations")}/${a.id}`);
  const skip = async (reason: string): Promise<RunOutcome> => {
    if (!preview) await recordRun(ctx, hid, a, "skipped", reason, []);
    return { automationId: a.id, status: "skipped", reason, steps: [] };
  };
  // Conditions.
  for (const c of a.conditions) {
    if (!compare(await conditionValue(ctx, hid, c.field, e), c.op, c.value)) return preview ? { automationId: a.id, status: "skipped", reason: `condition ${c.field} ${c.op} ${JSON.stringify(c.value)} not met`, steps: [] } : skip(`condition not met: ${c.field}`);
  }
  // Rate limits (transactional so concurrent events can't both pass).
  if (!preview) {
    const day = ctx.now().toISOString().slice(0, 10);
    const reason = await ctx.db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data() ?? raw;
      const last = cur.lastRunAt?.toDate() as Date | undefined;
      if (last && ctx.now().getTime() - last.getTime() < a.cooldownMinutes * 60_000) return "cooldown";
      const runsToday = cur.runsDay === day ? cur.runsToday ?? 0 : 0;
      if (runsToday >= a.maxRunsPerDay) return "daily limit reached";
      tx.update(ref, { lastRunAt: ts(ctx.now()), runsDay: day, runsToday: runsToday + 1 });
      return null;
    });
    if (reason) return skip(reason);
  }
  // Emergency pause halts automated actions.
  if ((await getAutonomy(ctx, hid)).paused) return preview ? { automationId: a.id, status: "skipped", reason: "household is paused", steps: [] } : skip("household is paused");

  const owner = raw.createdBy as string;
  const actor: Actor = { uid: owner, kind: "system" };
  const origin: EventOrigin = { channel: "automation", automationChain: [...(e.origin.automationChain ?? []), a.id] };
  const steps: RunOutcome["steps"] = [];
  for (const act of a.actions) {
    if (preview) { steps.push({ action: act.type, status: "would_run", detail: describe(act) }); continue; }
    try {
      switch (act.type) {
        case "device_action": {
          const map = { power_on: { type: "power", value: "ON" }, power_off: { type: "power", value: "OFF" }, lock: { type: "lock" }, set_temperature: { type: "thermostat", targetTemperature: act.value } } as const;
          const r = await executeDeviceAction(ctx, hid, actor, act.deviceId, map[act.action] as never, { channel: "automation", origin });
          steps.push({ action: act.type, status: r.status, detail: r.approvalId ? `approval ${r.approvalId}` : r.message });
          break;
        }
        case "create_task": {
          const r = await createTask(ctx, hid, actor, { title: act.title, priority: "normal", assigneeUid: act.assigneeUid, dueAt: act.dueInHours !== undefined ? new Date(ctx.now().getTime() + act.dueInHours * 3600_000).toISOString() : undefined });
          steps.push({ action: act.type, status: "verified", detail: r.id });
          break;
        }
        case "add_shopping_item": {
          const r = await addShoppingItem(ctx, hid, actor, { listId: act.listId, name: act.name, quantity: act.quantity, unit: act.unit, category: "Other" });
          steps.push({ action: act.type, status: "verified", detail: r.id });
          break;
        }
        case "notify": {
          const members = await ctx.db.collection(paths.col(hid, "members")).where("status", "==", "active").get();
          const roles = act.audience === "managers" ? ["owner", "admin"] : act.audience === "adults" ? ["owner", "admin", "adult"] : ["owner", "admin", "adult", "child", "staff"];
          const r = await notify(ctx, hid, { recipients: members.docs.filter((m) => roles.includes(m.data().role)).map((m) => m.id), category: "tasks", title: act.title, body: act.body, dedupeKey: `automation:${a.id}:${ctx.now().getTime()}` });
          steps.push({ action: act.type, status: "verified", detail: `${r.created} notified` });
          break;
        }
      }
    } catch (err) {
      steps.push({ action: act.type, status: "failed", detail: err instanceof AppError ? err.message : "failed" });
    }
  }
  if (preview) return { automationId: a.id, status: "previewed", steps };
  const failed = steps.filter((s) => ["failed", "unverified"].includes(s.status)).length;
  const status = failed === 0 ? "succeeded" : failed === steps.length ? "failed" : "partial";
  await recordRun(ctx, hid, a, status, null, steps);
  await ref.update({ lastStatus: status });
  return { automationId: a.id, status, steps };
}

function describe(act: z.infer<typeof ActionSchema>): string {
  switch (act.type) {
    case "device_action": return `${act.action.replace("_", " ")} on device ${act.deviceId}`;
    case "create_task": return `create task “${act.title}”`;
    case "notify": return `notify ${act.audience}: ${act.title}`;
    case "add_shopping_item": return `add ${act.quantity} ${act.unit} ${act.name}`;
  }
}

async function recordRun(ctx: Ctx, hid: string, a: { id: string; name: string }, status: string, reason: string | null, steps: RunOutcome["steps"]) {
  await ctx.db.collection(paths.col(hid, "automationRuns")).add({
    householdId: hid, automationId: a.id, automationName: a.name, status, reason, steps, createdAt: ts(ctx.now()),
    expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 90 * 86400_000)),
  });
  if (status !== "skipped") await recordAuditEvent(ctx, hid, { actorUid: null, actorKind: "automation", channel: "automation", target: { type: "automation", id: a.id, name: a.name }, requestedAction: "automation.run", result: status === "succeeded" ? "succeeded" : "failed", details: { steps: steps.length } });
}

/** Manual "test run": preview by default; execute=true runs it for real (manager only). */
export async function testAutomation(ctx: Ctx, actor: Actor, hid: string, aid: string, execute: boolean) {
  await requireManager(ctx, hid, actor.uid);
  const [r] = await processEvent(ctx, hid, { type: "manual", origin: { channel: "app" } }, aid, !execute);
  if (!r) throw notFound("Automation");
  return r;
}

/** Called by the 15-minute scheduler for schedule-triggered automations. */
export async function runScheduledAutomations(ctx: Ctx): Promise<number> {
  const due = await ctx.db.collectionGroup("automations").where("enabled", "==", true).where("nextScheduledAt", "<=", Timestamp.fromDate(ctx.now())).limit(100).get();
  let n = 0;
  for (const d of due.docs) {
    const hid = d.ref.parent.parent!.id;
    const a = { id: d.id, ...(d.data() as Automation) };
    if (a.trigger.type !== "schedule") continue;
    await d.ref.update({ nextScheduledAt: Timestamp.fromDate(await nextScheduleSlot(ctx, hid, a.trigger)) });
    await processEvent(ctx, hid, { type: "schedule", origin: { channel: "system" } }, d.id);
    n++;
  }
  return n;
}

/**
 * bill_due triggers, evaluated by the scheduler. Fires once per bill due date per automation
 * (dedupe marker created atomically), so a 15-minute scheduler never repeats it.
 */
export async function runBillDueAutomations(ctx: Ctx): Promise<number> {
  const autos = await ctx.db.collectionGroup("automations").where("enabled", "==", true).where("trigger.type", "==", "bill_due").limit(200).get();
  let n = 0;
  for (const d of autos.docs) {
    const hid = d.ref.parent.parent!.id;
    const a = d.data() as Automation;
    if (a.trigger.type !== "bill_due") continue;
    const horizon = Timestamp.fromDate(new Date(ctx.now().getTime() + a.trigger.withinDays * 86400_000));
    const bills = await ctx.db.collection(paths.col(hid, "bills")).where("nextDueAt", "<=", horizon).limit(20).get();
    for (const b of bills.docs) {
      const bill = b.data();
      if (bill.active === false || !bill.nextDueAt) continue;
      const due = (bill.nextDueAt as Timestamp).toDate().toISOString().slice(0, 10);
      try {
        await d.ref.collection("billMarkers").doc(`${b.id}_${due}`).create({ createdAt: ts(ctx.now()), expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 60 * 86400_000)) });
      } catch { continue; } // already fired for this due date
      // Bill name and due date only — amounts stay out of automation payloads.
      await processEvent(ctx, hid, { type: "bill.due", data: { billId: b.id, name: bill.name, dueDate: due }, origin: { channel: "system" } }, d.id);
      n++;
    }
  }
  return n;
}
