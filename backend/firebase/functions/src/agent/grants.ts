import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { AppError, Ctx, sha256, ts } from "../services/base";

/**
 * Agent grants bind a Hermes run to exactly one user in exactly one household.
 *
 * Why: Hermes connects to the HomeHub MCP server with a single service credential
 * (static header). That proves the caller is our Hermes runtime, but not on whose
 * behalf it acts. The gateway therefore mints a random, short-lived grant per run,
 * stores only its SHA-256 hash, and passes the token in the run instructions. Every
 * MCP tool requires it. A leaked or prompt-injected grant can never exceed what the
 * requesting user may already do, expires in minutes, is capped in tool calls, and
 * is revoked when the run ends. Approval-gated actions still need a human decision.
 */
export interface Grant {
  householdId: string;
  uid: string;
  sessionId: string;
  workflowId: string;
  agentId: string;
  expiresAt: Date;
  toolCalls: number;
  maxToolCalls: number;
}

export async function mintGrant(
  ctx: Ctx,
  g: { householdId: string; uid: string; sessionId: string; workflowId: string; ttlMinutes?: number; maxToolCalls?: number },
): Promise<string> {
  const token = `hhg_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(ctx.now().getTime() + (g.ttlMinutes ?? 20) * 60_000);
  await ctx.db.doc(`agentGrants/${sha256(token)}`).set({
    householdId: g.householdId, uid: g.uid, sessionId: g.sessionId, workflowId: g.workflowId,
    agentId: "homehub-hermes", expiresAt: Timestamp.fromDate(expiresAt), revoked: false,
    toolCalls: 0, maxToolCalls: g.maxToolCalls ?? 60, createdAt: ts(ctx.now()),
  });
  return token;
}

/** Validates and consumes one tool-call unit of the grant (transactional). */
export async function useGrant(ctx: Ctx, token: unknown): Promise<Grant> {
  if (typeof token !== "string" || !/^hhg_[A-Za-z0-9_-]{40,60}$/.test(token)) {
    throw new AppError(401, "invalid_grant", "A valid HomeHub grant is required for this tool");
  }
  const ref = ctx.db.doc(`agentGrants/${sha256(token)}`);
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError(401, "invalid_grant", "Unknown grant");
    const d = snap.data()!;
    if (d.revoked) throw new AppError(401, "grant_revoked", "This agent run has ended");
    if (d.expiresAt.toDate() <= ctx.now()) throw new AppError(401, "grant_expired", "This agent run's grant has expired");
    if (d.toolCalls >= d.maxToolCalls) throw new AppError(429, "tool_budget_exceeded", "Tool-call budget for this run is exhausted");
    tx.update(ref, { toolCalls: d.toolCalls + 1 });
    return {
      householdId: d.householdId, uid: d.uid, sessionId: d.sessionId, workflowId: d.workflowId, agentId: d.agentId,
      expiresAt: d.expiresAt.toDate(), toolCalls: d.toolCalls + 1, maxToolCalls: d.maxToolCalls,
    };
  });
}

export async function revokeGrantsForWorkflow(ctx: Ctx, workflowId: string): Promise<void> {
  const snap = await ctx.db.collection("agentGrants").where("workflowId", "==", workflowId).where("revoked", "==", false).get();
  const batch = ctx.db.batch();
  snap.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  if (!snap.empty) await batch.commit();
}
