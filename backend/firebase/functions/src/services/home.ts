import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { can, ROLE_CAPABILITIES } from "../core/roles";
import { EventInput, MaintenanceRequestInput } from "../core/schemas";
import { Actor, audit, Ctx, forbidden, invalid, notFound, paths, requireCapability, requireMember, ts } from "./base";
import { createDoc, toIso, updateDoc } from "./docs";
import { createTask } from "./tasks";

// ---------------- household ----------------

export async function getHouseholdSummary(ctx: Ctx, hid: string, actor: Actor) {
  const m = await requireMember(ctx, hid, actor.uid);
  const snap = await ctx.db.doc(paths.household(hid)).get();
  if (!snap.exists) throw notFound("Household");
  const h = snap.data()!;
  const counts = async (col: string, q?: (c: FirebaseFirestore.Query) => FirebaseFirestore.Query) => {
    const base: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, col));
    return (await (q ? q(base) : base).count().get()).data().count;
  };
  const tasksQ = (c: FirebaseFirestore.Query) => {
    let q = c.where("status", "in", ["open", "in_progress"]);
    if (!can(m, "tasks.read.all")) q = q.where("assigneeUid", "==", actor.uid);
    return q;
  };
  const [openTasks, lowStock, pendingApprovals] = await Promise.all([
    counts("tasks", tasksQ),
    counts("pantryItems", (c) => c.where("lowStock", "==", true)),
    can(m, "approvals.decide") ? counts("approvals", (c) => c.where("status", "==", "pending")) : Promise.resolve(0),
  ]);
  return {
    id: hid, name: h.name, currency: h.currency, timezone: h.timezone, locale: h.locale,
    memberCount: h.memberCount, yourRole: m.role, autonomy: h.autonomy,
    counts: { openTasks, lowStock, pendingApprovals },
  };
}

export async function getHouseholdMembers(ctx: Ctx, hid: string, actor: Actor) {
  await requireMember(ctx, hid, actor.uid);
  const snap = await ctx.db.collection(paths.col(hid, "members")).where("status", "==", "active").get();
  return snap.docs.map((d) => ({ uid: d.id, displayName: d.data().displayName, role: d.data().role }));
}

export async function getMemberPermissions(ctx: Ctx, hid: string, actor: Actor, uid: string) {
  const me = await requireMember(ctx, hid, actor.uid);
  if (uid !== actor.uid && !can(me, "members.manage")) throw forbidden("Only managers can view other members' permissions");
  const snap = await ctx.db.doc(paths.member(hid, uid)).get();
  if (!snap.exists) throw notFound("Member");
  const d = snap.data()!;
  const m = { uid, role: d.role, status: d.status, permissions: d.permissions };
  const caps = [...ROLE_CAPABILITIES[m.role as keyof typeof ROLE_CAPABILITIES]].filter((c) => can(m, c));
  return { uid, role: m.role, capabilities: caps };
}

// ---------------- maintenance ----------------

export async function listMaintenanceRecords(ctx: Ctx, hid: string, actor: Actor, status?: string, limit = 30) {
  const m = await requireMember(ctx, hid, actor.uid);
  let q: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, "maintenanceRecords"));
  if (!can(m, "maintenance.write")) {
    if (m.role !== "staff") throw forbidden("You cannot view maintenance records");
    q = q.where("assigneeUid", "==", actor.uid);
  }
  if (status) q = q.where("status", "==", status);
  const snap = await q.limit(Math.min(limit, 100)).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, title: x.title, assetId: x.assetId ?? null, status: x.status, priority: x.priority,
      nextDueAt: toIso(x.nextDueAt), providerName: x.providerName ?? null, costMinor: x.costMinor ?? null,
    };
  });
}

export async function createMaintenanceRequest(
  ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof MaintenanceRequestInput>,
) {
  await requireCapability(ctx, hid, actor.uid, "maintenance.write");
  let assetName: string | null = null;
  let warranty: string | null = null;
  if (input.assetId) {
    const a = await ctx.db.doc(`${paths.col(hid, "assets")}/${input.assetId}`).get();
    if (!a.exists) throw notFound("Asset");
    assetName = a.data()!.name;
    warranty = toIso(a.data()!.warrantyExpiresAt);
  }
  const underWarranty = warranty ? new Date(warranty) > ctx.now() : null;
  const { id } = await createDoc(ctx, hid, "maintenanceRecords", actor, {
    title: input.title, assetId: input.assetId ?? null, assetName, description: input.description ?? null,
    priority: input.priority, status: "requested", preferredDates: input.preferredDates ?? [],
    providerName: input.providerName ?? null, underWarranty, nextDueAt: null, costMinor: null, assigneeUid: null,
  });
  await audit(ctx, hid, actor, "maintenance.requested", { type: "maintenanceRecord", id }, { title: input.title });
  // Note: contacting/booking a provider is an external action and always goes through request_approval.
  return { id, status: "requested", underWarranty };
}

export async function scheduleServiceReminder(
  ctx: Ctx, hid: string, actor: Actor, input: { assetId: string; dueAt: string; note?: string },
) {
  await requireCapability(ctx, hid, actor.uid, "maintenance.write");
  const ref = ctx.db.doc(`${paths.col(hid, "assets")}/${input.assetId}`);
  const asset = await ref.get();
  if (!asset.exists) throw notFound("Asset");
  if (new Date(input.dueAt) < ctx.now()) throw invalid("Reminder date must be in the future");
  await updateDoc(ctx, hid, "assets", input.assetId, actor, { nextServiceAt: Timestamp.fromDate(new Date(input.dueAt)) });
  const task = await createTask(ctx, hid, actor, {
    title: `Service: ${asset.data()!.name}`, notes: input.note, category: "Maintenance", priority: "normal", dueAt: input.dueAt,
  });
  return { assetId: input.assetId, reminderTaskId: task.id, dueAt: input.dueAt };
}

// ---------------- calendar ----------------

export async function listEvents(ctx: Ctx, hid: string, actor: Actor, from: string, to: string, limit = 50) {
  const m = await requireMember(ctx, hid, actor.uid);
  let q: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, "events"));
  if (m.role === "child") q = q.where("visibility", "==", "household");
  if (m.role === "staff") q = q.where("staffVisible", "==", true);
  const snap = await q.where("startAt", ">=", Timestamp.fromDate(new Date(from)))
    .where("startAt", "<", Timestamp.fromDate(new Date(to))).orderBy("startAt").limit(Math.min(limit, 200)).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, title: x.title, startAt: toIso(x.startAt), endAt: toIso(x.endAt), category: x.category, attendeeUids: x.attendeeUids ?? [] };
  });
}

export async function checkScheduleConflicts(
  ctx: Ctx, hid: string, actor: Actor, startAt: string, endAt: string, attendeeUids: string[] = [],
) {
  await requireMember(ctx, hid, actor.uid);
  const s = new Date(startAt);
  const e = new Date(endAt);
  if (!(e >= s)) throw invalid("endAt must be after startAt");
  // Events that start before our end and within a 1-day lookback window; then filter by overlap.
  const snap = await ctx.db.collection(paths.col(hid, "events"))
    .where("startAt", "<", Timestamp.fromDate(e))
    .where("startAt", ">=", Timestamp.fromDate(new Date(s.getTime() - 86400_000))).get();
  const conflicts = snap.docs.filter((d) => {
    const x = d.data();
    const overlaps = x.endAt.toDate() > s && x.startAt.toDate() < e;
    if (!overlaps) return false;
    const att: string[] = x.attendeeUids ?? [];
    return attendeeUids.length === 0 || att.length === 0 || att.some((u) => attendeeUids.includes(u));
  });
  return {
    hasConflicts: conflicts.length > 0,
    conflicts: conflicts.map((d) => ({ id: d.id, title: d.data().title, startAt: toIso(d.data().startAt), endAt: toIso(d.data().endAt) })),
  };
}

export async function createEvent(ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof EventInput>) {
  await requireCapability(ctx, hid, actor.uid, "calendar.write");
  if (new Date(input.endAt) < new Date(input.startAt)) throw invalid("endAt must be after startAt");
  const conflicts = await checkScheduleConflicts(ctx, hid, actor, input.startAt, input.endAt, input.attendeeUids);
  const { id } = await createDoc(ctx, hid, "events", actor, {
    ...input, startAt: Timestamp.fromDate(new Date(input.startAt)), endAt: Timestamp.fromDate(new Date(input.endAt)),
    location: input.location ?? null, reminderMinutes: 60,
  });
  await audit(ctx, hid, actor, "calendar.event_created", { type: "event", id }, { title: input.title });
  return { id, conflicts: conflicts.conflicts };
}

export { ts };
