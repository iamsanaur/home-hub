import { DateTime } from "luxon";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { nextOccurrence, RecurrenceRule } from "../core/recurrence";
import { TaskInput, TaskUpdateInput } from "../core/schemas";
import { can } from "../core/roles";
import { Actor, audit, Ctx, forbidden, getMembership, invalid, notFound, paths, requireMember, ts } from "./base";
import { createDoc, toIso, toTs, updateDoc } from "./docs";

export type TaskFilter = "today" | "upcoming" | "overdue" | "mine" | "all" | "open";

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  assigneeUid: string | null;
  category: string | null;
  recurring: boolean;
  version: number;
}

function row(id: string, d: FirebaseFirestore.DocumentData): TaskRow {
  return {
    id,
    title: d.title,
    status: d.status,
    priority: d.priority,
    dueAt: toIso(d.dueAt),
    assigneeUid: d.assigneeUid ?? null,
    category: d.category ?? null,
    recurring: !!d.recurrence,
    version: d.version,
  };
}

async function householdTz(ctx: Ctx, hid: string): Promise<string> {
  const hh = await ctx.db.doc(paths.household(hid)).get();
  if (!hh.exists) throw notFound("Household");
  return hh.data()!.timezone ?? "UTC";
}

export async function listTasks(
  ctx: Ctx, hid: string, actor: Actor, filter: TaskFilter = "open", limit = 25,
): Promise<TaskRow[]> {
  const m = await requireMember(ctx, hid, actor.uid);
  const tz = await householdTz(ctx, hid);
  const now = DateTime.fromJSDate(ctx.now()).setZone(tz);
  let q: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, "tasks"));
  const seeAll = can(m, "tasks.read.all");
  if (!seeAll || filter === "mine") q = q.where("assigneeUid", "==", actor.uid);
  q = q.where("status", "in", ["open", "in_progress"]);
  if (filter === "today") {
    q = q.where("dueAt", "<=", Timestamp.fromDate(now.endOf("day").toJSDate()));
  } else if (filter === "overdue") {
    q = q.where("dueAt", "<", Timestamp.fromDate(now.toJSDate()));
  } else if (filter === "upcoming") {
    q = q.where("dueAt", ">", Timestamp.fromDate(now.endOf("day").toJSDate()));
  }
  if (filter === "all") {
    q = ctx.db.collection(paths.col(hid, "tasks"));
    if (!seeAll) q = q.where("assigneeUid", "==", actor.uid);
  }
  const snap = await q.limit(Math.min(limit, 100)).get();
  const rows = snap.docs.map((d) => row(d.id, d.data()));
  return rows.sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
}

async function validateAssignee(ctx: Ctx, hid: string, assigneeUid?: string | null) {
  if (!assigneeUid) return;
  const m = await getMembership(ctx, hid, assigneeUid);
  if (!m || m.status !== "active") throw invalid("Assignee is not an active household member");
}

export async function createTask(ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof TaskInput>) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "tasks.write")) {
    // Children may create tasks for themselves only.
    if (!(m.role === "child" && input.assigneeUid === actor.uid)) throw forbidden("You cannot create tasks");
  }
  await validateAssignee(ctx, hid, input.assigneeUid);
  const { id } = await createDoc(ctx, hid, "tasks", actor, {
    title: input.title,
    notes: input.notes ?? null,
    category: input.category ?? null,
    priority: input.priority,
    status: "open",
    dueAt: toTs(input.dueAt),
    assigneeUid: input.assigneeUid ?? null,
    recurrence: input.recurrence ?? null,
    seriesId: null,
    seriesStartAt: input.recurrence && input.dueAt ? toTs(input.dueAt) : null,
    checklist: input.checklist ?? [],
    completedAt: null,
    completedBy: null,
  });
  await audit(ctx, hid, actor, "task.created", { type: "task", id }, { title: input.title });
  return { id };
}

export async function updateTask(
  ctx: Ctx, hid: string, actor: Actor, taskId: string, input: z.infer<typeof TaskUpdateInput>, expectedVersion?: number,
) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "tasks.write")) throw forbidden("You cannot edit tasks");
  if (input.assigneeUid !== undefined) await validateAssignee(ctx, hid, input.assigneeUid);
  const patch: Record<string, unknown> = { ...input };
  if (input.dueAt !== undefined) patch.dueAt = toTs(input.dueAt);
  if (input.status === "done") {
    patch.completedAt = ts(ctx.now());
    patch.completedBy = actor.uid;
  }
  const res = await updateDoc(ctx, hid, "tasks", taskId, actor, patch, expectedVersion);
  await audit(ctx, hid, actor, "task.updated", { type: "task", id: taskId }, { fields: Object.keys(input) });
  return { id: taskId, version: res.version };
}

export async function completeTask(ctx: Ctx, hid: string, actor: Actor, taskId: string) {
  const m = await requireMember(ctx, hid, actor.uid);
  const res = await updateDoc(ctx, hid, "tasks", taskId, actor,
    { status: "done", completedAt: ts(ctx.now()), completedBy: actor.uid }, undefined,
    (current) => {
      if (!can(m, "tasks.write") && current.assigneeUid !== actor.uid) throw forbidden("You can only complete tasks assigned to you");
      if (current.status === "done") throw invalid("Task is already complete");
    });
  const spawned = await handleTaskCompleted(ctx, hid, taskId, res.data);
  await audit(ctx, hid, actor, "task.completed", { type: "task", id: taskId });
  return { id: taskId, version: res.version, nextOccurrenceId: spawned };
}

export async function assignTask(ctx: Ctx, hid: string, actor: Actor, taskId: string, assigneeUid: string | null) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "tasks.assign")) throw forbidden("You cannot assign tasks");
  await validateAssignee(ctx, hid, assigneeUid);
  const res = await updateDoc(ctx, hid, "tasks", taskId, actor, { assigneeUid });
  await audit(ctx, hid, actor, "task.assigned", { type: "task", id: taskId }, { assigneeUid });
  return { id: taskId, version: res.version };
}

/**
 * Called by the Firestore trigger (and directly by completeTask). Records the
 * completion in taskOccurrences and, for recurring tasks, creates the next
 * occurrence. Deterministic document IDs make this idempotent: re-running for the
 * same completion is a no-op.
 */
export async function handleTaskCompleted(
  ctx: Ctx, hid: string, taskId: string, task: FirebaseFirestore.DocumentData,
): Promise<string | null> {
  if (task.status !== "done" || !task.completedAt) return null;
  const completedAt: Date = task.completedAt instanceof Timestamp ? task.completedAt.toDate() : new Date(task.completedAt);
  const occId = `${taskId}_${completedAt.getTime()}`;
  try {
    await ctx.db.doc(`${paths.col(hid, "taskOccurrences")}/${occId}`).create({
      householdId: hid,
      taskId,
      seriesId: task.seriesId ?? taskId,
      title: task.title,
      assigneeUid: task.assigneeUid ?? null,
      dueAt: task.dueAt ?? null,
      completedAt: Timestamp.fromDate(completedAt),
      completedBy: task.completedBy ?? null,
      onTime: task.dueAt ? completedAt <= task.dueAt.toDate() : true,
    });
  } catch (e: unknown) {
    if ((e as { code?: number }).code !== 6) throw e; // 6 = ALREADY_EXISTS → already processed
  }
  if (!task.recurrence || !task.dueAt) return null;
  const tz = await householdTz(ctx, hid);
  const seriesStart = (task.seriesStartAt ?? task.dueAt).toDate().toISOString();
  const next = nextOccurrence(task.recurrence as RecurrenceRule, seriesStart, tz, task.dueAt.toDate().toISOString());
  if (!next) return null;
  const seriesId = task.seriesId ?? taskId;
  const nextId = `${seriesId}_${new Date(next).getTime()}`;
  try {
    await ctx.db.doc(`${paths.col(hid, "tasks")}/${nextId}`).create({
      householdId: hid,
      title: task.title,
      notes: task.notes ?? null,
      category: task.category ?? null,
      priority: task.priority,
      status: "open",
      dueAt: Timestamp.fromDate(new Date(next)),
      assigneeUid: task.assigneeUid ?? null,
      recurrence: task.recurrence,
      seriesId,
      seriesStartAt: task.seriesStartAt ?? task.dueAt,
      checklist: (task.checklist ?? []).map((c: { id: string; text: string }) => ({ ...c, done: false })),
      completedAt: null,
      completedBy: null,
      createdBy: task.createdBy,
      createdAt: ts(ctx.now()),
      updatedBy: "system",
      updatedAt: ts(ctx.now()),
      version: 1,
      source: "recurrence",
    });
  } catch (e: unknown) {
    if ((e as { code?: number }).code !== 6) throw e;
  }
  return nextId;
}
