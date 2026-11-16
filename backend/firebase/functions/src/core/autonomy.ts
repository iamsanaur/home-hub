/**
 * Autonomy policy. Enforced on the server for every agent tool call — the UI only
 * reflects it.
 *
 * Modes:
 *   1 assistant   — the agent may only read and suggest. Every write needs approval.
 *   2 copilot     — reversible writes need approval; reads are free.
 *   3 routine     — (default) safe, reversible household operations run automatically.
 *   4 advanced    — like routine, plus low-risk bounded writes (e.g. budget-limited
 *                   shopping-list edits) without approval. Never purchases/payments.
 *
 * Regardless of mode, the following ALWAYS require human approval and the
 * following are NEVER executed autonomously: see ALWAYS_APPROVAL.
 */
export type AutonomyMode = "assistant" | "copilot" | "routine" | "advanced";
export const AUTONOMY_MODES: AutonomyMode[] = ["assistant", "copilot", "routine", "advanced"];
export const DEFAULT_AUTONOMY: AutonomyMode = "routine";

export type ActionRisk =
  | "read"
  | "reversible_write" // create task, add shopping item, create reminder, checklist update
  | "bounded_write" // e.g. record a planned expense, generate meal plan (replaces plan)
  | "sensitive"; // always approval

export type SensitiveKind =
  | "purchase"
  | "external_booking"
  | "payment"
  | "external_message"
  | "share_sensitive"
  | "delete_important"
  | "irreversible";

export const ALWAYS_APPROVAL: ReadonlySet<SensitiveKind> = new Set([
  "purchase", "external_booking", "payment", "external_message",
  "share_sensitive", "delete_important", "irreversible",
]);

export interface AutonomyState {
  mode: AutonomyMode;
  paused: boolean; // emergency pause: blocks ALL autonomous writes
  pausedBy?: string | null;
  pausedAt?: string | null;
}

export type PolicyDecision =
  | { outcome: "allow" }
  | { outcome: "approval_required"; reason: string }
  | { outcome: "deny"; reason: string };

export function decide(
  state: AutonomyState,
  risk: ActionRisk,
  sensitive?: SensitiveKind,
): PolicyDecision {
  if (risk === "read") return { outcome: "allow" };
  if (state.paused) {
    return { outcome: "deny", reason: "Autonomous operations are paused for this household." };
  }
  if (risk === "sensitive" || (sensitive && ALWAYS_APPROVAL.has(sensitive))) {
    return { outcome: "approval_required", reason: `${sensitive ?? "sensitive"} actions always need human approval` };
  }
  switch (state.mode) {
    case "assistant":
      return { outcome: "approval_required", reason: "Assistant mode: every change needs approval" };
    case "copilot":
      return { outcome: "approval_required", reason: "Copilot mode: changes need approval" };
    case "routine":
      return risk === "reversible_write"
        ? { outcome: "allow" }
        : { outcome: "approval_required", reason: "Routine mode: this change is not a routine reversible operation" };
    case "advanced":
      return { outcome: "allow" };
  }
}
