import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { canChangeRole, isRole, Role } from "../core/roles";
import { AutonomyMode, AutonomyState, DEFAULT_AUTONOMY } from "../core/autonomy";
import { CreateHouseholdInput, InviteInput } from "../core/schemas";
import {
  Actor, AppError, audit, Ctx, forbidden, getMembership, invalid, newId, notFound, paths,
  requireCapability, sha256, ts,
} from "./base";
import { defaultJobs } from "./jobs";

const INVITE_TTL_DAYS = 7;

export async function createHousehold(
  ctx: Ctx,
  user: { uid: string; displayName?: string | null; email?: string | null },
  input: z.infer<typeof CreateHouseholdInput>,
): Promise<{ householdId: string }> {
  if (!isValidTimezone(input.timezone)) throw invalid(`Unknown timezone ${input.timezone}`);
  const hid = newId();
  const now = ctx.now();
  const batch = ctx.db.batch();
  batch.set(ctx.db.doc(paths.household(hid)), {
    name: input.name,
    currency: input.currency,
    timezone: input.timezone,
    locale: input.locale,
    country: input.country ?? null,
    ownerUid: user.uid,
    autonomy: { mode: DEFAULT_AUTONOMY, paused: false } satisfies AutonomyState,
    memberCount: 1,
    createdAt: ts(now),
    updatedAt: ts(now),
    updatedBy: user.uid,
  });
  batch.set(ctx.db.doc(paths.member(hid, user.uid)), {
    uid: user.uid,
    role: "owner",
    status: "active",
    displayName: user.displayName ?? user.email ?? "Owner",
    email: user.email ?? null,
    permissions: { finance: true },
    joinedAt: ts(now),
  });
  for (const job of defaultJobs(hid, user.uid, input.timezone, now)) {
    batch.set(ctx.db.doc(`${paths.col(hid, "scheduledJobs")}/${job.id}`), job.data);
  }
  // Navigation index only — authorization always reads the member document.
  batch.set(ctx.db.doc(`users/${user.uid}`), { activeHouseholdId: hid, updatedAt: ts(now), memberships: { [hid]: { name: input.name, role: "owner" } } }, { merge: true });
  await batch.commit();
  await audit(ctx, hid, { uid: user.uid, kind: "user" }, "household.created", { type: "household", id: hid });
  return { householdId: hid };
}

export async function invite(
  ctx: Ctx,
  actor: Actor,
  hid: string,
  input: z.infer<typeof InviteInput>,
): Promise<{ invitationId: string; token: string; expiresAt: string }> {
  await requireCapability(ctx, hid, actor.uid, "members.manage");
  const token = randomBytes(24).toString("base64url");
  const invitationId = newId();
  const expires = new Date(ctx.now().getTime() + INVITE_TTL_DAYS * 86400_000);
  const batch = ctx.db.batch();
  batch.set(ctx.db.doc(`${paths.col(hid, "invitations")}/${invitationId}`), {
    householdId: hid,
    email: input.email?.toLowerCase() ?? null,
    displayName: input.displayName ?? null,
    role: input.role,
    status: "pending",
    invitedBy: actor.uid,
    tokenHash: sha256(token),
    createdAt: ts(ctx.now()),
    expiresAt: ts(expires),
  });
  batch.set(ctx.db.doc(`invitationTokens/${sha256(token)}`), {
    householdId: hid,
    invitationId,
    expiresAt: ts(expires),
  });
  await batch.commit();
  await audit(ctx, hid, actor, "member.invited", { type: "invitation", id: invitationId }, { role: input.role });
  // The plaintext token is returned once to the inviter (to share as a link/code) and never stored.
  return { invitationId, token, expiresAt: expires.toISOString() };
}

export async function acceptInvitation(
  ctx: Ctx,
  user: { uid: string; email?: string | null; emailVerified?: boolean; displayName?: string | null },
  token: string,
): Promise<{ householdId: string; role: Role }> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw invalid("Malformed invitation code");
  const tokenRef = ctx.db.doc(`invitationTokens/${sha256(token)}`);
  return ctx.db.runTransaction(async (tx) => {
    const tokenSnap = await tx.get(tokenRef);
    if (!tokenSnap.exists) throw notFound("Invitation");
    const { householdId, invitationId } = tokenSnap.data()!;
    const invRef = ctx.db.doc(`${paths.col(householdId, "invitations")}/${invitationId}`);
    const memberRef = ctx.db.doc(paths.member(householdId, user.uid));
    const hhRef = ctx.db.doc(paths.household(householdId));
    const [inv, existing, hhSnap] = await Promise.all([tx.get(invRef), tx.get(memberRef), tx.get(hhRef)]);
    if (!inv.exists) throw notFound("Invitation");
    const data = inv.data()!;
    if (data.status !== "pending") throw new AppError(410, "invitation_used", "This invitation has already been used or revoked");
    if (data.expiresAt.toDate() < ctx.now()) throw new AppError(410, "invitation_expired", "This invitation has expired");
    if (data.email && (!user.emailVerified || user.email?.toLowerCase() !== data.email)) {
      throw forbidden("This invitation was sent to a different email address");
    }
    if (existing.exists && existing.data()!.status === "active") throw new AppError(409, "already_member", "You are already a member");
    tx.set(memberRef, {
      uid: user.uid,
      role: data.role,
      status: "active",
      displayName: user.displayName ?? data.displayName ?? user.email ?? "Member",
      email: user.email ?? null,
      permissions: { finance: data.role === "owner" || data.role === "admin" || data.role === "adult" },
      invitedBy: data.invitedBy,
      joinedAt: ts(ctx.now()),
    });
    tx.update(invRef, { status: "accepted", acceptedBy: user.uid, acceptedAt: ts(ctx.now()) });
    tx.delete(tokenRef);
    tx.update(hhRef, { memberCount: FieldValue.increment(1) });
    const hhName = hhSnap.data()?.name ?? "Household";
    tx.set(ctx.db.doc(`users/${user.uid}`), { activeHouseholdId: householdId, memberships: { [householdId]: { name: hhName, role: data.role } } }, { merge: true });
    return { householdId, role: data.role as Role };
  });
}

export async function revokeInvitation(ctx: Ctx, actor: Actor, hid: string, invitationId: string): Promise<void> {
  await requireCapability(ctx, hid, actor.uid, "members.manage");
  const ref = ctx.db.doc(`${paths.col(hid, "invitations")}/${invitationId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Invitation");
  await ref.update({ status: "revoked", revokedBy: actor.uid, revokedAt: ts(ctx.now()) });
  await ctx.db.doc(`invitationTokens/${snap.data()!.tokenHash}`).delete();
  await audit(ctx, hid, actor, "member.invitation_revoked", { type: "invitation", id: invitationId });
}

export async function changeMemberRole(
  ctx: Ctx, actor: Actor, hid: string, targetUid: string,
  update: { role?: string; permissions?: { finance?: boolean; agent?: boolean } },
): Promise<void> {
  const [me, target] = await Promise.all([getMembership(ctx, hid, actor.uid), getMembership(ctx, hid, targetUid)]);
  if (!me || !target || target.status !== "active") throw notFound("Member");
  const patch: Record<string, unknown> = {};
  if (update.role !== undefined) {
    if (!isRole(update.role)) throw invalid("Unknown role");
    if (!canChangeRole(me, target, update.role)) throw forbidden("You cannot assign that role");
    if (update.role === "owner") {
      // Ownership transfer: the previous owner becomes an admin, atomically.
      const batch = ctx.db.batch();
      batch.update(ctx.db.doc(paths.member(hid, targetUid)), { role: "owner" });
      batch.update(ctx.db.doc(paths.member(hid, actor.uid)), { role: "admin" });
      batch.update(ctx.db.doc(paths.household(hid)), { ownerUid: targetUid });
      await batch.commit();
      await audit(ctx, hid, actor, "household.ownership_transferred", { type: "member", id: targetUid });
      return;
    }
    patch.role = update.role;
    if (update.role === "child" || update.role === "staff") patch["permissions.finance"] = false;
  }
  if (update.permissions) {
    await requireCapability(ctx, hid, actor.uid, "members.manage");
    if (target.role === "owner") throw forbidden("Owner permissions cannot be restricted");
    if (update.permissions.finance !== undefined) {
      if (update.permissions.finance && !["admin", "adult"].includes((patch.role as string) ?? target.role)) {
        throw invalid("Finance access is only available to adults");
      }
      patch["permissions.finance"] = update.permissions.finance;
    }
    if (update.permissions.agent !== undefined) patch["permissions.agent"] = update.permissions.agent;
  }
  if (Object.keys(patch).length === 0) throw invalid("Nothing to change");
  await ctx.db.doc(paths.member(hid, targetUid)).update(patch);
  if (patch.role) await ctx.db.doc(`users/${targetUid}`).set({ memberships: { [hid]: { role: patch.role } } }, { merge: true });
  await audit(ctx, hid, actor, "member.updated", { type: "member", id: targetUid }, patch);
}

export async function removeMember(ctx: Ctx, actor: Actor, hid: string, targetUid: string): Promise<void> {
  const target = await getMembership(ctx, hid, targetUid);
  if (!target || target.status !== "active") throw notFound("Member");
  if (target.role === "owner") throw forbidden("Transfer ownership before removing the owner");
  if (actor.uid !== targetUid) {
    const me = await requireCapability(ctx, hid, actor.uid, "members.manage");
    if (me.role === "admin" && target.role === "admin") throw forbidden("Admins cannot remove other admins");
  }
  await ctx.db.doc(paths.member(hid, targetUid)).update({ status: "removed", removedAt: ts(ctx.now()), removedBy: actor.uid });
  await ctx.db.doc(`users/${targetUid}`).set({ memberships: { [hid]: FieldValue.delete() } }, { merge: true });
  await ctx.db.doc(paths.household(hid)).update({ memberCount: FieldValue.increment(-1) });
  await audit(ctx, hid, actor, actor.uid === targetUid ? "member.left" : "member.removed", { type: "member", id: targetUid });
}

export async function getAutonomy(ctx: Ctx, hid: string): Promise<AutonomyState> {
  const snap = await ctx.db.doc(paths.household(hid)).get();
  if (!snap.exists) throw notFound("Household");
  return (snap.data()!.autonomy as AutonomyState) ?? { mode: DEFAULT_AUTONOMY, paused: false };
}

export async function setAutonomy(
  ctx: Ctx, actor: Actor, hid: string, input: { mode?: string; paused?: boolean },
): Promise<AutonomyState> {
  // Any adult may hit the emergency pause; only managers may resume or change the mode.
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  const isPauseOnly = input.paused === true && input.mode === undefined;
  if (isPauseOnly) {
    if (!["owner", "admin", "adult"].includes(m.role)) throw forbidden("Only adults can pause the agent");
  } else {
    await requireCapability(ctx, hid, actor.uid, "autonomy.manage");
  }
  const current = await getAutonomy(ctx, hid);
  const next: AutonomyState = {
    mode: (input.mode as AutonomyMode) ?? current.mode,
    paused: input.paused ?? current.paused,
    pausedBy: input.paused === true ? actor.uid : input.paused === false ? null : current.pausedBy ?? null,
    pausedAt: input.paused === true ? ctx.now().toISOString() : input.paused === false ? null : current.pausedAt ?? null,
  };
  await ctx.db.doc(paths.household(hid)).update({ autonomy: next });
  await audit(ctx, hid, actor, next.paused ? "agent.paused" : "agent.autonomy_updated", { type: "household", id: hid }, { ...next });
  return next;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
