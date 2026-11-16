import { FieldValue } from "firebase-admin/firestore";
import { Ctx, paths, ts } from "./base";

export type Channel = "app" | "agent_phone" | "agent_server" | "alexa" | "automation" | "webhook" | "bridge" | "system";

export interface AuditEventInput {
  actorUid: string | null;
  actorKind: "user" | "agent" | "system" | "automation" | "integration";
  channel: Channel;
  agentId?: string | null;
  pluginId?: string | null;
  integrationId?: string | null;
  tool?: string | null;
  target: { type: string; id?: string | null; name?: string | null };
  requestedAction: string;
  approvalId?: string | null;
  result: "succeeded" | "failed" | "denied" | "approval_required" | "skipped";
  details?: Record<string, unknown>;
}

/**
 * Household audit trail for gateway activity (plugins, devices, Alexa, automations).
 * Payloads are summaries only — never secrets, tokens or raw voice.
 */
export async function recordAuditEvent(ctx: Ctx, hid: string, e: AuditEventInput): Promise<string> {
  const ref = ctx.db.collection(paths.col(hid, "auditEvents")).doc();
  await ref.set({
    householdId: hid, ...e,
    agentId: e.agentId ?? null, pluginId: e.pluginId ?? null, integrationId: e.integrationId ?? null, tool: e.tool ?? null,
    approvalId: e.approvalId ?? null, details: e.details ?? {},
    searchText: [e.requestedAction, e.target.type, e.target.name, e.pluginId, e.channel, e.result].filter(Boolean).join(" ").toLowerCase(),
    createdAt: ts(ctx.now()),
  });
  await bumpUsage(ctx, hid, { [`channel_${e.channel}`]: 1, [`result_${e.result}`]: 1, ...(e.pluginId ? { [`plugin_${e.pluginId.replace(/\./g, "_")}`]: 1 } : {}) });
  return ref.id;
}

/** Daily counters (one doc per day) so dashboards don't scan the audit log. */
export async function bumpUsage(ctx: Ctx, hid: string, counters: Record<string, number>): Promise<void> {
  const day = ctx.now().toISOString().slice(0, 10);
  const inc: Record<string, unknown> = { householdId: hid, day, updatedAt: ts(ctx.now()) };
  for (const [k, v] of Object.entries(counters)) inc[`counters.${k}`] = FieldValue.increment(v);
  await ctx.db.doc(`${paths.col(hid, "usageMetrics")}/${day}`).set({}, { merge: true });
  await ctx.db.doc(`${paths.col(hid, "usageMetrics")}/${day}`).update(inc);
}
