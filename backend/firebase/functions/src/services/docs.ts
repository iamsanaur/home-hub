import { DocumentReference, Timestamp, Transaction } from "firebase-admin/firestore";
import { Actor, conflict, Ctx, newId, notFound, paths, stripUndefined, ts } from "./base";

/** Standard metadata every client-editable document carries (mirrors firestore.rules). */
export function creationMeta(ctx: Ctx, hid: string, actor: Actor) {
  const now = ts(ctx.now());
  return {
    householdId: hid,
    createdBy: actor.uid,
    createdAt: now,
    updatedBy: actor.uid,
    updatedAt: now,
    version: 1,
    source: actor.kind === "agent" ? "agent" : "user",
    workflowId: actor.workflowId ?? null,
  };
}

export async function createDoc(
  ctx: Ctx, hid: string, collection: string, actor: Actor, data: Record<string, unknown>, id = newId(),
): Promise<{ id: string; ref: DocumentReference }> {
  const ref = ctx.db.doc(`${paths.col(hid, collection)}/${id}`);
  await ref.create({ ...stripUndefined(data), ...creationMeta(ctx, hid, actor) });
  return { id, ref };
}

/**
 * Versioned update. When `expectedVersion` is provided and the stored version
 * differs, the update is rejected as a conflict instead of silently overwriting.
 */
export async function updateDoc(
  ctx: Ctx, hid: string, collection: string, id: string, actor: Actor,
  patch: Record<string, unknown>, expectedVersion?: number,
  guard?: (current: FirebaseFirestore.DocumentData, tx: Transaction) => void,
): Promise<{ version: number; data: FirebaseFirestore.DocumentData }> {
  const ref = ctx.db.doc(`${paths.col(hid, collection)}/${id}`);
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound(collection.replace(/s$/, ""));
    const current = snap.data()!;
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw conflict("This record changed since you loaded it", { currentVersion: current.version, expectedVersion });
    }
    guard?.(current, tx);
    const version = (current.version ?? 0) + 1;
    const next = { ...stripUndefined(patch), version, updatedBy: actor.uid, updatedAt: ts(ctx.now()) };
    tx.update(ref, next);
    return { version, data: { ...current, ...next } };
  });
}

export function toIso(v: unknown): string | null {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  return typeof v === "string" ? v : null;
}

export function toTs(iso: string | undefined | null): Timestamp | null {
  return iso ? Timestamp.fromDate(new Date(iso)) : null;
}
