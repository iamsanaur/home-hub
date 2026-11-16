/**
 * Deterministic request router — no LLM call. Picks:
 *  - whether the request can be answered without the agent at all;
 *  - the single most relevant skill to load (progressive loading);
 *  - the model tier (economical vs. stronger reasoning).
 */
export type SkillName =
  | "household-manager" | "finance-manager" | "smart-shopping" | "meal-planner"
  | "home-maintenance" | "family-coordinator" | "household-reports" | "approval-manager";

export type Route =
  | { kind: "deterministic"; handler: "briefing" | "pending_approvals" }
  | { kind: "agent"; skill: SkillName; tier: "simple" | "complex"; workflow?: "weekly_preparation" | "guest_preparation" | "budget_protection" | "maintenance_coordination" | "daily_briefing" };

const RULES: Array<{ skill: SkillName; words: RegExp }> = [
  { skill: "approval-manager", words: /\b(approv\w*|pending requests?|reject)\b/ },
  { skill: "meal-planner", words: /\b(meal|meals|dinner|lunch|breakfast|recipe|menu|cook|snack|diet)\w*/ },
  { skill: "smart-shopping", words: /\b(grocer\w*|shopping|buy|pantry|stock|restock|supermarket|list)\b/ },
  { skill: "finance-manager", words: /\b(budget|expense|spend\w*|money|income|saving\w*|bill|bills|cost|paid|pay)\b/ },
  { skill: "home-maintenance", words: /\b(repair|fix|service|maintenance|warranty|plumb\w*|electric\w*|appliance|ac|leak|broken)\b/ },
  { skill: "family-coordinator", words: /\b(calendar|schedule|event|birthday|anniversary|appointment|school|assign|who)\b/ },
  { skill: "household-reports", words: /\b(report|trend|insight|how much|summary of|analy\w*|usage)\b/ },
];

export function route(message: string): Route {
  const m = message.toLowerCase().trim();
  if (/^(what('?s| is) (on |due )?today|today'?s (briefing|summary)|daily briefing|brief me)\??$/.test(m)) {
    return { kind: "deterministic", handler: "briefing" };
  }
  if (/^(show|list)( me)? (my )?pending approvals\??$/.test(m)) {
    return { kind: "deterministic", handler: "pending_approvals" };
  }
  if (/\bprepare everything\b|\b(prepare|get (everything |us )?ready) for (next|this|the coming) week\b|\bplan (our|the|next) week\b/.test(m)) {
    return { kind: "agent", skill: "household-manager", tier: "complex", workflow: "weekly_preparation" };
  }
  if (/\bguests?\b|\bvisitors?\b|\bhosting\b|\bparty\b/.test(m)) {
    return { kind: "agent", skill: "household-manager", tier: "complex", workflow: "guest_preparation" };
  }
  if (/\b(over ?spend\w*|overbudget|over budget|save money|cut costs?|unusual (spend|expense))/.test(m)) {
    return { kind: "agent", skill: "finance-manager", tier: "complex", workflow: "budget_protection" };
  }
  const hits = RULES.filter((r) => r.words.test(m));
  const skill = hits[0]?.skill ?? "household-manager";
  if (skill === "home-maintenance") return { kind: "agent", skill, tier: "complex", workflow: "maintenance_coordination" };
  // Several domains in one request, or long requests, deserve stronger reasoning.
  const tier = hits.length >= 3 || m.length > 400 ? "complex" : "simple";
  return { kind: "agent", skill, tier };
}

/** Model routing is configuration, not code: HERMES_MODEL_SIMPLE / HERMES_MODEL_COMPLEX (+ _PROVIDER). */
export function modelFor(tier: "simple" | "complex"): { model?: string; provider?: string } {
  const model = tier === "complex" ? process.env.HERMES_MODEL_COMPLEX : process.env.HERMES_MODEL_SIMPLE;
  const provider = tier === "complex" ? process.env.HERMES_PROVIDER_COMPLEX : process.env.HERMES_PROVIDER_SIMPLE;
  return { model: model || undefined, provider: provider || undefined };
}
