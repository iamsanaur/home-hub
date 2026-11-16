import { Timestamp } from "firebase-admin/firestore";
import { Actor, Ctx, paths, requireCapability, ts } from "./base";

/**
 * Agent usage ledger. One document per agent run (plus delegated child usage as
 * fields), partitioned under the household so no single document becomes hot.
 */
export interface UsageRecord {
  sessionId: string;
  runId: string;
  workflowId?: string | null;
  agentId: string; // e.g. "homehub-hermes"
  skill?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number | null;
  delegatedTokens?: number | null;
  toolCalls: number;
  retries: number;
  durationMs: number;
  status: "completed" | "failed" | "cancelled";
  requestedBy: string;
}

/** Optional pricing table: MODEL_PRICING='{"model-id":{"inputPerMTokMicros":3000000,"outputPerMTokMicros":15000000}}' (USD micros). */
export function estimateCostMicrosUsd(model: string | null | undefined, input: number, output: number, cached = 0): number | null {
  if (!model || !process.env.MODEL_PRICING) return null;
  try {
    const table = JSON.parse(process.env.MODEL_PRICING) as Record<string, { inputPerMTokMicros: number; outputPerMTokMicros: number; cachedPerMTokMicros?: number }>;
    const p = table[model];
    if (!p) return null;
    const billableInput = Math.max(0, input - cached);
    const micros = (billableInput * p.inputPerMTokMicros + output * p.outputPerMTokMicros + cached * (p.cachedPerMTokMicros ?? p.inputPerMTokMicros)) / 1_000_000;
    return Math.round(micros);
  } catch {
    return null;
  }
}

export async function recordUsage(ctx: Ctx, hid: string, rec: UsageRecord): Promise<string> {
  const ref = ctx.db.doc(`${paths.col(hid, "agentUsage")}/${rec.runId}`);
  await ref.set({
    householdId: hid,
    ...rec,
    totalTokens: rec.inputTokens + rec.outputTokens,
    estimatedCostMicrosUsd: estimateCostMicrosUsd(rec.model, rec.inputTokens, rec.outputTokens, rec.cachedTokens ?? 0),
    createdAt: ts(ctx.now()),
  }, { merge: true });
  return ref.id;
}

export async function getAgentUsageReport(ctx: Ctx, hid: string, actor: Actor, from: string, to: string) {
  await requireCapability(ctx, hid, actor.uid, "usage.read");
  const snap = await ctx.db.collection(paths.col(hid, "agentUsage"))
    .where("createdAt", ">=", Timestamp.fromDate(new Date(from)))
    .where("createdAt", "<", Timestamp.fromDate(new Date(to))).limit(2000).get();
  let input = 0, output = 0, cached = 0, delegated = 0, runs = 0, completed = 0, failed = 0, cancelled = 0, cost = 0, costKnown = 0, tools = 0, duration = 0;
  const byModel = new Map<string, { runs: number; tokens: number }>();
  const bySkill = new Map<string, { runs: number; tokens: number; completed: number }>();
  for (const d of snap.docs) {
    const x = d.data();
    runs++;
    input += x.inputTokens ?? 0;
    output += x.outputTokens ?? 0;
    cached += x.cachedTokens ?? 0;
    delegated += x.delegatedTokens ?? 0;
    tools += x.toolCalls ?? 0;
    duration += x.durationMs ?? 0;
    if (x.status === "completed") completed++;
    else if (x.status === "failed") failed++;
    else cancelled++;
    if (x.estimatedCostMicrosUsd != null) { cost += x.estimatedCostMicrosUsd; costKnown++; }
    const model = x.model ?? "unknown";
    const m = byModel.get(model) ?? { runs: 0, tokens: 0 };
    m.runs++; m.tokens += x.totalTokens ?? 0; byModel.set(model, m);
    const skill = x.skill ?? "general";
    const s = bySkill.get(skill) ?? { runs: 0, tokens: 0, completed: 0 };
    s.runs++; s.tokens += x.totalTokens ?? 0; if (x.status === "completed") s.completed++; bySkill.set(skill, s);
  }
  return {
    from, to, runs, completed, failed, cancelled,
    tokens: { input, output, cached, delegated, total: input + output },
    // Measured, not claimed: tokens spent per successful workflow in this window.
    tokensPerSuccessfulRun: completed ? Math.round((input + output) / completed) : null,
    toolCalls: tools,
    avgDurationMs: runs ? Math.round(duration / runs) : null,
    estimatedCostMicrosUsd: costKnown ? cost : null,
    costCoverage: runs ? `${costKnown}/${runs} runs priced` : "no runs",
    byModel: [...byModel].map(([model, v]) => ({ model, ...v })),
    bySkill: [...bySkill].map(([skill, v]) => ({ skill, ...v, tokensPerSuccess: v.completed ? Math.round(v.tokens / v.completed) : null })),
  };
}
