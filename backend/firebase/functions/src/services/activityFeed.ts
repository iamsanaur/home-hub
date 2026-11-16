/**
 * Deleting entries from the household's "Recent activity" feed. Only owners and administrators can.
 * The separate security audit trail (auditEvents: devices, automations, Alexa, tools) is never deletable;
 * every deletion here is itself written to it, so removing a feed entry never hides that something was removed.
 */
import { Actor, AppError, Ctx, forbidden, getMembership, notFound, paths } from "./base";
import { recordAuditEvent } from "./auditEvents";

async function requireManager(ctx: Ctx, hid: string, actor: Actor) {
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  if (!["owner", "admin"].includes(m.role)) throw forbidden("Only owners and administrators can delete activity");
}

const audited = (ctx: Ctx, hid: string, actor: Actor, removed: number, id?: string) =>
  recordAuditEvent(ctx, hid, {
    actorUid: actor.uid, actorKind: "user", channel: "app", target: { type: "activityFeed", id: id ?? null },
    requestedAction: id ? "activity.entry_deleted" : "activity.feed_cleared", result: "succeeded", details: { removed },
  });

export async function deleteActivityEntry(ctx: Ctx, hid: string, actor: Actor, logId: string) {
  await requireManager(ctx, hid, actor);
  const ref = ctx.db.doc(`${paths.col(hid, "activityLogs")}/${logId}`);
  if (!(await ref.get()).exists) throw notFound("Activity entry");
  await ref.delete();
  await audited(ctx, hid, actor, 1, logId);
  return { removed: 1 };
}

/** Clears the whole feed (in batches). Entries from runs still in progress are kept so their results can be verified. */
export async function clearActivity(ctx: Ctx, hid: string, actor: Actor) {
  await requireManager(ctx, hid, actor);
  const running = new Set((await ctx.db.collection(paths.col(hid, "agentWorkflows")).where("status", "==", "executing").limit(50).get()).docs.map((d) => d.id));
  let removed = 0;
  for (let round = 0; round < 25; round++) {
    const snap = await ctx.db.collection(paths.col(hid, "activityLogs")).limit(400).get();
    const doomed = snap.docs.filter((d) => !running.has(String(d.data().workflowId ?? "")));
    if (!doomed.length) break;
    const batch = ctx.db.batch();
    doomed.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += doomed.length;
    if (snap.size < 400 || doomed.length < snap.size) break;
  }
  if (removed === 0) throw new AppError(200, "nothing_to_clear", "There was nothing to clear");
  await audited(ctx, hid, actor, removed);
  return { removed };
}
