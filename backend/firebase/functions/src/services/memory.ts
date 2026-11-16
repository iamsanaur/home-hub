import { Actor, audit, Ctx, forbidden, invalid, newId, notFound, paths, requireCapability, requireMember, ts } from "./base";

/**
 * Permission-scoped agent memory. Operational data stays in its own collections;
 * this store only keeps durable preferences/facts and short conversation summaries.
 *  - scope "household": visible to adults+, used as shared context.
 *  - scope "private":   visible only to its owner.
 * Raw conversations are never stored here.
 */
export type MemoryScope = "household" | "private";
export type MemoryKind = "preference" | "fact" | "summary";

const MAX_TEXT = 500;

export function extractTags(text: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "our", "are", "was", "from", "have", "has", "not", "but", "you", "your", "all", "any", "can", "will"]);
  return [...new Set(text.toLowerCase().match(/[a-zऀ-ॿ]{3,}/g) ?? [])].filter((w) => !stop.has(w)).slice(0, 20);
}

export async function remember(
  ctx: Ctx, hid: string, actor: Actor,
  input: { scope: MemoryScope; kind: MemoryKind; text: string; sessionId?: string },
) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (input.scope === "household" && !["owner", "admin", "adult"].includes(m.role)) {
    throw forbidden("Only adults can save household-wide memory");
  }
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (!text) throw invalid("Memory text is empty");
  const id = newId();
  await ctx.db.doc(`${paths.col(hid, "memories")}/${id}`).set({
    householdId: hid, scope: input.scope, kind: input.kind, text, tags: extractTags(text),
    ownerUid: actor.uid, source: actor.kind, sessionId: input.sessionId ?? null,
    createdAt: ts(ctx.now()), updatedAt: ts(ctx.now()),
  });
  return { id };
}

/** Relevant-only retrieval: keyword overlap ranking, capped to a few items. */
export async function recall(ctx: Ctx, hid: string, uid: string, role: string, query: string, limit = 5) {
  const tags = extractTags(query);
  const col = ctx.db.collection(paths.col(hid, "memories"));
  const queries: FirebaseFirestore.Query[] = [col.where("scope", "==", "private").where("ownerUid", "==", uid)];
  if (["owner", "admin", "adult"].includes(role)) queries.push(col.where("scope", "==", "household"));
  const snaps = await Promise.all(queries.map((q) => q.limit(200).get()));
  const scored = snaps.flatMap((s) => s.docs).map((d) => {
    const x = d.data();
    const overlap = (x.tags as string[]).filter((t) => tags.includes(t)).length;
    const boost = x.kind === "preference" ? 0.5 : 0;
    return { id: d.id, text: x.text as string, kind: x.kind as string, scope: x.scope as string, score: overlap + boost };
  }).filter((x) => x.score > 0.5 || x.kind === "preference");
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function listMemories(ctx: Ctx, hid: string, actor: Actor) {
  const m = await requireMember(ctx, hid, actor.uid);
  const col = ctx.db.collection(paths.col(hid, "memories"));
  const own = await col.where("scope", "==", "private").where("ownerUid", "==", actor.uid).get();
  const shared = ["owner", "admin", "adult"].includes(m.role) ? await col.where("scope", "==", "household").get() : null;
  return [...own.docs, ...(shared?.docs ?? [])].map((d) => ({
    id: d.id, scope: d.data().scope, kind: d.data().kind, text: d.data().text,
    ownerUid: d.data().ownerUid, updatedAt: d.data().updatedAt?.toDate().toISOString(),
  }));
}

async function editable(ctx: Ctx, hid: string, actor: Actor, id: string) {
  const m = await requireMember(ctx, hid, actor.uid);
  const ref = ctx.db.doc(`${paths.col(hid, "memories")}/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Memory");
  const d = snap.data()!;
  const ok = d.scope === "private" ? d.ownerUid === actor.uid : (d.ownerUid === actor.uid || ["owner", "admin"].includes(m.role));
  if (!ok) throw forbidden("You cannot change this memory");
  return ref;
}

export async function correctMemory(ctx: Ctx, hid: string, actor: Actor, id: string, text: string) {
  const ref = await editable(ctx, hid, actor, id);
  const clean = text.trim().slice(0, MAX_TEXT);
  if (!clean) throw invalid("Memory text is empty");
  await ref.update({ text: clean, tags: extractTags(clean), updatedAt: ts(ctx.now()), correctedBy: actor.uid });
  await audit(ctx, hid, actor, "memory.corrected", { type: "memory", id });
}

export async function deleteMemory(ctx: Ctx, hid: string, actor: Actor, id: string) {
  const ref = await editable(ctx, hid, actor, id);
  await ref.delete();
  await audit(ctx, hid, actor, "memory.deleted", { type: "memory", id });
}

/** Personal data export (DPDP / GDPR style): the user's own profile, memberships, private notes and memories. */
export async function exportUserData(ctx: Ctx, uid: string) {
  const user = await ctx.db.doc(`users/${uid}`).get();
  const memberships = await ctx.db.collectionGroup("members").where("uid", "==", uid).get();
  const households = [];
  for (const m of memberships.docs) {
    const hid = m.ref.parent.parent!.id;
    const [notes, memories, tasks] = await Promise.all([
      ctx.db.collection(paths.col(hid, "notes")).where("createdBy", "==", uid).where("visibility", "==", "private").get(),
      ctx.db.collection(paths.col(hid, "memories")).where("scope", "==", "private").where("ownerUid", "==", uid).get(),
      ctx.db.collection(paths.col(hid, "tasks")).where("assigneeUid", "==", uid).limit(500).get(),
    ]);
    households.push({
      householdId: hid, membership: m.data(),
      privateNotes: notes.docs.map((d) => d.data()), privateMemories: memories.docs.map((d) => d.data()),
      assignedTasks: tasks.docs.map((d) => ({ id: d.id, title: d.data().title, status: d.data().status })),
    });
  }
  return { exportedAt: ctx.now().toISOString(), profile: user.data() ?? null, households };
}

/**
 * Account deletion: removes personal profile, devices, private notes and private
 * memories; anonymises membership. Households the user OWNS with other active
 * members must be transferred first.
 */
export async function deleteUserData(ctx: Ctx, uid: string) {
  const memberships = await ctx.db.collectionGroup("members").where("uid", "==", uid).where("status", "==", "active").get();
  for (const m of memberships.docs) {
    if (m.data().role === "owner") {
      const hid = m.ref.parent.parent!.id;
      const others = await ctx.db.collection(paths.col(hid, "members")).where("status", "==", "active").get();
      if (others.size > 1) throw forbidden(`Transfer ownership of household ${hid} before deleting your account`);
    }
  }
  for (const m of memberships.docs) {
    const hid = m.ref.parent.parent!.id;
    const [notes, memories] = await Promise.all([
      ctx.db.collection(paths.col(hid, "notes")).where("createdBy", "==", uid).where("visibility", "==", "private").get(),
      ctx.db.collection(paths.col(hid, "memories")).where("scope", "==", "private").where("ownerUid", "==", uid).get(),
    ]);
    const batch = ctx.db.batch();
    notes.docs.forEach((d) => batch.delete(d.ref));
    memories.docs.forEach((d) => batch.delete(d.ref));
    batch.update(m.ref, { status: "removed", displayName: "Former member", email: null, removedAt: ts(ctx.now()) });
    await batch.commit();
  }
  const devices = await ctx.db.collection(`users/${uid}/devices`).get();
  const batch = ctx.db.batch();
  devices.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(ctx.db.doc(`users/${uid}`));
  await batch.commit();
  return { deleted: true, households: memberships.size };
}

export async function requireUsage(ctx: Ctx, hid: string, actor: Actor) {
  return requireCapability(ctx, hid, actor.uid, "usage.read");
}
