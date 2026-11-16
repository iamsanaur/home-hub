import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { SensitiveKind } from "../core/autonomy";
import { ExpenseInput, MaintenanceRequestInput, MealPlanInput, ShoppingItemInput, TaskInput } from "../core/schemas";
import { Actor, AppError, audit, Ctx, forbidden, invalid, newId, notFound, paths, requireCapability, requireMember, ts } from "./base";
import { addShoppingItem, createMealPlan } from "./food";
import { recordExpense } from "./finance";
import { createMaintenanceRequest } from "./home";
import { createTask } from "./tasks";
import { notify } from "./notifications";
import { DELETABLE, deleteRecord } from "./records";

/**
 * Executable approval actions. When an approval is granted, the server executes the
 * stored, validated parameters itself — the agent cannot change them afterwards.
 * Actions with no real integration (purchases, bookings, external messages) are
 * recorded as approved for MANUAL completion; nothing is claimed as done.
 */
type Executor = { schema: z.ZodTypeAny; sensitive?: SensitiveKind; manual?: boolean; run?: (ctx: Ctx, hid: string, actor: Actor, params: never) => Promise<Record<string, unknown>> };

export const APPROVAL_ACTIONS: Record<string, Executor> = {
  create_tasks: {
    schema: z.object({ tasks: z.array(TaskInput).min(1).max(30) }),
    run: async (ctx, hid, actor, p: { tasks: z.infer<typeof TaskInput>[] }) => {
      const ids: string[] = [];
      for (const t of p.tasks) ids.push((await createTask(ctx, hid, actor, t)).id);
      return { taskIds: ids };
    },
  },
  add_shopping_items: {
    schema: z.object({ items: z.array(ShoppingItemInput).min(1).max(100) }),
    run: async (ctx, hid, actor, p: { items: z.infer<typeof ShoppingItemInput>[] }) => {
      const ids: string[] = [];
      for (const i of p.items) ids.push((await addShoppingItem(ctx, hid, actor, i)).id);
      return { itemIds: ids };
    },
  },
  create_meal_plan: {
    schema: MealPlanInput,
    run: async (ctx, hid, actor, p: z.infer<typeof MealPlanInput>) => createMealPlan(ctx, hid, actor, p),
  },
  record_expense: {
    schema: ExpenseInput,
    run: async (ctx, hid, actor, p: z.infer<typeof ExpenseInput>) => recordExpense(ctx, hid, actor, p),
  },
  create_maintenance_request: {
    schema: MaintenanceRequestInput,
    run: async (ctx, hid, actor, p: z.infer<typeof MaintenanceRequestInput>) => createMaintenanceRequest(ctx, hid, actor, p),
  },
  purchase_items: {
    sensitive: "purchase", manual: true,
    schema: z.object({ listId: z.string().max(128), store: z.string().max(120).optional(), note: z.string().max(500).optional() }),
  },
  book_service_provider: {
    sensitive: "external_booking", manual: true,
    schema: z.object({ maintenanceRecordId: z.string().max(128), providerName: z.string().max(120), proposedDate: z.string().max(40), note: z.string().max(500).optional() }),
  },
  send_external_message: {
    sensitive: "external_message", manual: true,
    schema: z.object({ recipient: z.string().max(200), channel: z.enum(["sms", "email", "whatsapp", "call"]), message: z.string().max(1000) }),
  },
  share_information: {
    sensitive: "share_sensitive", manual: true,
    schema: z.object({ recipient: z.string().max(200), what: z.string().max(500) }),
  },
  delete_record: {
    sensitive: "delete_important",
    schema: z.object({ collection: z.enum(DELETABLE), id: z.string().max(128), reason: z.string().max(300).optional() }),
    run: async (ctx, hid, actor, p: { collection: string; id: string }) => deleteRecord(ctx, hid, actor, p.collection, p.id),
  },
  delete_document: {
    sensitive: "delete_important",
    schema: z.object({ documentId: z.string().max(128) }),
    run: async (ctx, hid, actor, p: { documentId: string }) => {
      const ref = ctx.db.doc(`${paths.col(hid, "documents")}/${p.documentId}`);
      const snap = await ref.get();
      if (!snap.exists) throw notFound("Document");
      await ref.update({ deleted: true, deletedAt: ts(ctx.now()), deletedBy: actor.uid });
      return { documentId: p.documentId, softDeleted: true };
    },
  },
};

export interface ApprovalRequest {
  action: string;
  title: string;
  rationale: string;
  params: Record<string, unknown>;
  estimatedCostMinor?: number;
  currency?: string;
  recipient?: string;
  relevantDate?: string;
  dataShared?: string;
  consequences?: string;
  expiresInHours?: number;
}

export async function requestApproval(ctx: Ctx, hid: string, actor: Actor, req: ApprovalRequest) {
  await requireMember(ctx, hid, actor.uid);
  const exec = APPROVAL_ACTIONS[req.action];
  if (!exec) throw invalid(`Unknown approval action "${req.action}". Allowed: ${Object.keys(APPROVAL_ACTIONS).join(", ")}`);
  const parsed = exec.schema.safeParse(req.params);
  if (!parsed.success) throw invalid("Approval parameters are invalid", parsed.error.issues.slice(0, 5));
  if (req.estimatedCostMinor != null && (!Number.isSafeInteger(req.estimatedCostMinor) || req.estimatedCostMinor < 0)) {
    throw invalid("estimatedCostMinor must be a non-negative integer");
  }
  const hours = Math.min(Math.max(req.expiresInHours ?? 48, 1), 24 * 14);
  const id = newId();
  const expiresAt = new Date(ctx.now().getTime() + hours * 3600_000);
  await ctx.db.doc(`${paths.col(hid, "approvals")}/${id}`).set({
    householdId: hid,
    action: req.action,
    sensitiveKind: exec.sensitive ?? null,
    manualCompletion: !!exec.manual,
    title: req.title.slice(0, 160),
    rationale: req.rationale.slice(0, 1000),
    params: parsed.data,
    estimatedCostMinor: req.estimatedCostMinor ?? null,
    currency: req.currency ?? null,
    recipient: req.recipient ?? null,
    relevantDate: req.relevantDate ?? null,
    dataShared: req.dataShared ?? null,
    consequences: req.consequences ?? null,
    requestedBy: actor.uid,
    requestedVia: actor.kind,
    agentId: actor.agentId ?? null,
    workflowId: actor.workflowId ?? null,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    executionResult: null,
    createdAt: ts(ctx.now()),
    expiresAt: Timestamp.fromDate(expiresAt),
  });
  await audit(ctx, hid, actor, "approval.requested", { type: "approval", id }, { action: req.action });
  // Notify approvers (adults+, excluding the requester when a person asked).
  const approvers = await ctx.db.collection(paths.col(hid, "members")).where("status", "==", "active").get();
  const recipients = approvers.docs.filter((d) => ["owner", "admin", "adult"].includes(d.data().role)).map((d) => d.id);
  await notify(ctx, hid, {
    recipients, category: "approvals", title: "Approval needed", body: req.title.slice(0, 120),
    deepLink: `homehub://approvals/${id}`, dedupeKey: `approval:${id}`,
  });
  return { approvalId: id, status: "pending", expiresAt: expiresAt.toISOString() };
}

export async function getApproval(ctx: Ctx, hid: string, actor: Actor, approvalId: string) {
  const m = await requireMember(ctx, hid, actor.uid);
  const snap = await ctx.db.doc(`${paths.col(hid, "approvals")}/${approvalId}`).get();
  if (!snap.exists) throw notFound("Approval");
  const d = snap.data()!;
  if (!["owner", "admin", "adult"].includes(m.role) && d.requestedBy !== actor.uid) throw forbidden();
  return serialize(snap.id, d);
}

function serialize(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id, action: d.action, title: d.title, rationale: d.rationale, params: d.params, status: d.status,
    estimatedCostMinor: d.estimatedCostMinor, currency: d.currency, recipient: d.recipient, relevantDate: d.relevantDate,
    dataShared: d.dataShared, consequences: d.consequences, manualCompletion: d.manualCompletion,
    requestedBy: d.requestedBy, agentId: d.agentId, workflowId: d.workflowId,
    createdAt: d.createdAt?.toDate().toISOString(), expiresAt: d.expiresAt?.toDate().toISOString(),
    decidedBy: d.decidedBy, decidedAt: d.decidedAt?.toDate?.().toISOString() ?? null, executionResult: d.executionResult,
  };
}

export async function listPendingApprovals(ctx: Ctx, hid: string, actor: Actor, limit = 20) {
  await requireCapability(ctx, hid, actor.uid, "approvals.decide");
  const snap = await ctx.db.collection(paths.col(hid, "approvals")).where("status", "==", "pending")
    .orderBy("createdAt", "desc").limit(Math.min(limit, 50)).get();
  const now = ctx.now();
  return snap.docs.filter((d) => d.data().expiresAt.toDate() > now).map((d) => serialize(d.id, d.data()));
}

/**
 * A person approves or rejects. Approval executes the stored action server-side.
 * Only active adults+ may decide, an expired approval cannot be approved, and the
 * state transition pending → approved/rejected happens exactly once (transaction).
 */
export async function decideApproval(
  ctx: Ctx, hid: string, actor: Actor, approvalId: string, decision: "approve" | "reject", note?: string,
) {
  if (actor.kind !== "user") throw forbidden("Only a person can decide approvals");
  await requireCapability(ctx, hid, actor.uid, "approvals.decide");
  const ref = ctx.db.doc(`${paths.col(hid, "approvals")}/${approvalId}`);
  const data = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Approval");
    const d = snap.data()!;
    if (d.status !== "pending") throw new AppError(409, "approval_decided", `Approval is already ${d.status}`);
    if (d.expiresAt.toDate() <= ctx.now()) {
      tx.update(ref, { status: "expired" });
      throw new AppError(410, "approval_expired", "This approval has expired");
    }
    tx.update(ref, {
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: actor.uid, decidedAt: ts(ctx.now()), decisionNote: note ?? null,
    });
    return d;
  });
  await audit(ctx, hid, actor, `approval.${decision}d`, { type: "approval", id: approvalId }, { action: data.action });
  if (decision === "reject") return { id: approvalId, status: "rejected" };

  const exec = APPROVAL_ACTIONS[data.action];
  const execActor: Actor = { uid: actor.uid, kind: "user", workflowId: data.workflowId ?? undefined };
  if (exec.manual || !exec.run) {
    const result = { outcome: "requires_manual_completion", note: "Approved. HomeHub has no integration to perform this externally, so a person must complete it. Nothing has been purchased, booked or sent." };
    await ref.update({ status: "approved", executionResult: result });
    return { id: approvalId, status: "approved", executionResult: result };
  }
  try {
    const result = await exec.run(ctx, hid, execActor, data.params as never);
    await ref.update({ status: "executed", executionResult: { outcome: "success", ...result }, executedAt: ts(ctx.now()) });
    await audit(ctx, hid, execActor, "approval.executed", { type: "approval", id: approvalId }, { action: data.action });
    return { id: approvalId, status: "executed", executionResult: { outcome: "success", ...result } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ref.update({ status: "failed", executionResult: { outcome: "failed", error: message } });
    return { id: approvalId, status: "failed", executionResult: { outcome: "failed", error: message } };
  }
}

/** Scheduler: mark stale pending approvals as expired. */
export async function expireApprovals(ctx: Ctx): Promise<number> {
  const snap = await ctx.db.collectionGroup("approvals").where("status", "==", "pending")
    .where("expiresAt", "<=", Timestamp.fromDate(ctx.now())).limit(200).get();
  const batch = ctx.db.batch();
  snap.docs.forEach((d) => batch.update(d.ref, { status: "expired" }));
  if (!snap.empty) await batch.commit();
  return snap.size;
}
