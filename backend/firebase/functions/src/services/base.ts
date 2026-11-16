import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { Capability, can, Membership } from "../core/roles";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const forbidden = (why = "You do not have permission for this action") => new AppError(403, "forbidden", why);
export const invalid = (why: string, details?: unknown) => new AppError(400, "invalid_argument", why, details);
export const conflict = (why: string, details?: unknown) => new AppError(409, "conflict", why, details);

export interface Actor {
  uid: string;
  /** "user" for people acting through the apps; "agent" for Hermes acting on a user's behalf. */
  kind: "user" | "agent" | "system";
  agentId?: string;
  workflowId?: string;
}

export interface Ctx {
  db: Firestore;
  now: () => Date;
}

export const paths = {
  household: (hid: string) => `households/${hid}`,
  member: (hid: string, uid: string) => `households/${hid}/members/${uid}`,
  col: (hid: string, name: string) => `households/${hid}/${name}`,
};

export function newId(): string {
  return randomBytes(12).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function ts(date: Date): Timestamp {
  return Timestamp.fromDate(date);
}

export function isoOrNull(v: unknown): string | null {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return null;
}

export async function getMembership(ctx: Ctx, hid: string, uid: string): Promise<Membership | null> {
  const snap = await ctx.db.doc(paths.member(hid, uid)).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  return { uid, role: d.role, status: d.status, permissions: d.permissions };
}

/** Throws unless the actor is an active member holding the capability. Returns the membership. */
export async function requireCapability(ctx: Ctx, hid: string, uid: string, capability: Capability): Promise<Membership> {
  const m = await getMembership(ctx, hid, uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  if (!can(m, capability)) throw forbidden(`Missing permission: ${capability}`);
  return m;
}

export async function requireMember(ctx: Ctx, hid: string, uid: string): Promise<Membership> {
  const m = await getMembership(ctx, hid, uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  return m;
}

/** Append-only audit trail. Payloads are kept small and never include secrets. */
export async function audit(
  ctx: Ctx,
  hid: string,
  actor: Actor,
  action: string,
  target: { type: string; id?: string },
  payload: Record<string, unknown> = {},
): Promise<void> {
  await ctx.db.collection(paths.col(hid, "activityLogs")).add({
    householdId: hid,
    actorUid: actor.uid,
    actorKind: actor.kind,
    agentId: actor.agentId ?? null,
    workflowId: actor.workflowId ?? null,
    action,
    targetType: target.type,
    targetId: target.id ?? null,
    payload,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Run a retryable write exactly once per idempotency key. The key is scoped by
 * household + actor + operation so keys cannot collide across tenants. A retried
 * call returns the stored result instead of writing again.
 */
export async function idempotent<T extends Record<string, unknown>>(
  ctx: Ctx,
  scope: { hid: string; uid: string; op: string },
  key: string | undefined,
  fn: () => Promise<T>,
): Promise<T & { replayed?: boolean }> {
  if (!key) return fn();
  const ref = ctx.db.doc(`idempotency/${sha256(`${scope.hid}|${scope.uid}|${scope.op}|${key}`)}`);
  const reserved = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return snap.data()!;
    tx.set(ref, { state: "pending", op: scope.op, householdId: scope.hid, createdAt: FieldValue.serverTimestamp() });
    return null;
  });
  if (reserved) {
    if (reserved.state === "done") return { ...(reserved.result as T), replayed: true };
    throw conflict("An identical request is still in progress", { idempotencyKey: key });
  }
  try {
    const result = await fn();
    await ref.set({ state: "done", result, completedAt: FieldValue.serverTimestamp() }, { merge: true });
    return result;
  } catch (err) {
    await ref.delete();
    throw err;
  }
}

export function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
