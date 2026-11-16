import { DateTime } from "luxon";
import { z } from "zod";
import { ActionRisk, decide, SensitiveKind } from "../core/autonomy";
import {
  ExpenseInput, EventInput, IdempotencyKey, IsoDate, IsoDateTime, MaintenanceRequestInput, MealPlanInput,
  Priority, ShoppingItemInput, TaskInput, TaskStatus,
} from "../core/schemas";
import { useGrant } from "../agent/grants";
import { Actor, AppError, Ctx, idempotent, paths } from "../services/base";
import { APPROVAL_ACTIONS, getApproval, listPendingApprovals, requestApproval } from "../services/approvals";
import { getAutonomy } from "../services/households";
import { assignTask, completeTask, createTask, listTasks, updateTask } from "../services/tasks";
import {
  addShoppingItem, createMealPlan, createShoppingList, generateMealShoppingList, getInventory, getLowStockItems,
  getMealPlan, markItemPurchased,
} from "../services/food";
import { getBillStatus, getBudgetSummary, listExpenses, recordExpense } from "../services/finance";
import {
  checkScheduleConflicts, createEvent, createMaintenanceRequest, getHouseholdMembers, getHouseholdSummary,
  getMemberPermissions, listEvents, listMaintenanceRecords, scheduleServiceReminder,
} from "../services/home";
import { getHouseholdReport, ReportKind } from "../services/reports";
import { getAgentUsageReport } from "../services/usage";

/**
 * HomeHub MCP tools. Design rules:
 *  - No tool accepts a householdId: the household comes from the server-side grant,
 *    so cross-household access is impossible by construction.
 *  - Every call consumes the run's grant (auth + tool-call budget).
 *  - Writes pass through the autonomy policy; anything not allowed becomes an
 *    approval request instead of an action.
 *  - Retryable writes accept idempotency_key.
 *  - Responses are compact JSON.
 */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  risk: ActionRisk;
  sensitive?: SensitiveKind;
  run: (ctx: Ctx, hid: string, actor: Actor, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

const grant = z.string().describe("The HomeHub grant from your instructions. Required.");
const idem = IdempotencyKey.optional().describe("Optional key so a retried write is applied once");

function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

async function weekStartFor(ctx: Ctx, hid: string, date?: string): Promise<string> {
  const tz = (await ctx.db.doc(paths.household(hid)).get()).data()?.timezone ?? "UTC";
  const d = date ? DateTime.fromISO(date, { zone: tz }) : DateTime.fromJSDate(ctx.now()).setZone(tz);
  return d.startOf("week").toISODate()!;
}

export const TOOLS: ToolDef[] = [
  // ---- household ----
  tool({ name: "get_household_summary", description: "Household basics, your role, autonomy mode and key counts.", shape: {}, risk: "read",
    run: (ctx, hid, a) => getHouseholdSummary(ctx, hid, a) }),
  tool({ name: "get_household_members", description: "Active members: uid, name, role.", shape: {}, risk: "read",
    run: (ctx, hid, a) => getHouseholdMembers(ctx, hid, a) }),
  tool({ name: "get_member_permissions", description: "Capabilities of a member (yourself unless you manage members).",
    shape: { uid: z.string().max(128) }, risk: "read", run: (ctx, hid, a, x) => getMemberPermissions(ctx, hid, a, x.uid) }),

  // ---- tasks ----
  tool({ name: "list_tasks", description: "Open tasks. filter: today|overdue|upcoming|mine|open|all.",
    shape: { filter: z.enum(["today", "overdue", "upcoming", "mine", "open", "all"]).default("open"), limit: z.number().int().min(1).max(100).default(25) },
    risk: "read", run: (ctx, hid, a, x) => listTasks(ctx, hid, a, x.filter, x.limit) }),
  tool({ name: "create_task", description: "Create a household task (optionally assigned, due, recurring).",
    shape: { ...TaskInput.shape, idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => { const { idempotency_key, ...t } = x; return createTask(ctx, hid, a, TaskInput.parse(t)); } }),
  tool({ name: "update_task", description: "Edit task fields. Pass expected_version to avoid overwriting others' edits.",
    shape: { task_id: z.string().max(128), title: z.string().max(200).optional(), notes: z.string().max(4000).optional(), priority: Priority.optional(), dueAt: IsoDateTime.optional(), status: TaskStatus.optional(), expected_version: z.number().int().optional() },
    risk: "reversible_write", run: (ctx, hid, a, x) => { const { task_id, expected_version, ...p } = x; return updateTask(ctx, hid, a, task_id, p, expected_version); } }),
  tool({ name: "complete_task", description: "Mark a task done (recurring tasks schedule their next occurrence).",
    shape: { task_id: z.string().max(128) }, risk: "reversible_write", run: (ctx, hid, a, x) => completeTask(ctx, hid, a, x.task_id) }),
  tool({ name: "assign_task", description: "Assign a task to a member uid (or null to unassign).",
    shape: { task_id: z.string().max(128), assignee_uid: z.string().max(128).nullable() }, risk: "reversible_write",
    run: (ctx, hid, a, x) => assignTask(ctx, hid, a, x.task_id, x.assignee_uid) }),

  // ---- shopping & pantry ----
  tool({ name: "get_inventory", description: "Pantry stock (name, quantity, unit, min, lowStock, expiry).",
    shape: { location: z.string().max(60).optional(), limit: z.number().int().min(1).max(200).default(50) }, risk: "read",
    run: (ctx, hid, a, x) => getInventory(ctx, hid, a, x) }),
  tool({ name: "get_low_stock_items", description: "Items at/below minimum stock and items expiring within 3 days.", shape: {}, risk: "read",
    run: (ctx, hid, a) => getLowStockItems(ctx, hid, a) }),
  tool({ name: "create_shopping_list", description: "Create a shopping list.",
    shape: { name: z.string().min(1).max(80), store: z.string().max(80).optional(), idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => createShoppingList(ctx, hid, a, x.name, x.store) }),
  tool({ name: "add_shopping_item", description: "Add an item to a list; merges with an identical unpurchased line.",
    shape: { ...ShoppingItemInput.shape, idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => { const { idempotency_key, ...i } = x; return addShoppingItem(ctx, hid, a, ShoppingItemInput.parse(i)); } }),
  tool({ name: "mark_item_purchased", description: "Record that a person bought an item (restocks pantry). Does not buy anything.",
    shape: { item_id: z.string().max(128), actual_price_minor: z.number().int().min(0).optional() }, risk: "bounded_write",
    run: (ctx, hid, a, x) => markItemPurchased(ctx, hid, a, x.item_id, x.actual_price_minor) }),

  // ---- meals ----
  tool({ name: "get_meal_plan", description: "Meal plan for the week containing `date` (default: this week).",
    shape: { date: IsoDate.optional() }, risk: "read",
    run: async (ctx, hid, a, x) => getMealPlan(ctx, hid, a, await weekStartFor(ctx, hid, x.date)) }),
  tool({ name: "create_meal_plan", description: "Create or replace the plan for a week (weekStart = Monday).",
    shape: MealPlanInput.shape, risk: "bounded_write", run: (ctx, hid, a, x) => createMealPlan(ctx, hid, a, MealPlanInput.parse(x)) }),
  tool({ name: "generate_meal_shopping_list", description: "Deterministically build a shopping list from a week's plan minus pantry stock, with known-price estimates.",
    shape: { week_start: IsoDate, list_id: z.string().max(128).optional(), idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => generateMealShoppingList(ctx, hid, a, x.week_start, x.list_id) }),

  // ---- finance ----
  tool({ name: "get_budget_summary", description: "Income, spending and budget utilisation for a month (YYYY-MM). Amounts in minor units.",
    shape: { period: z.string().regex(/^\d{4}-\d{2}$/) }, risk: "read", run: (ctx, hid, a, x) => getBudgetSummary(ctx, hid, a, x.period) }),
  tool({ name: "list_expenses", description: "Transactions in a date range (ISO datetimes).",
    shape: { from: IsoDateTime, to: IsoDateTime, category: z.string().max(60).optional(), limit: z.number().int().min(1).max(200).default(50) },
    risk: "read", run: (ctx, hid, a, x) => listExpenses(ctx, hid, a, x) }),
  tool({ name: "record_expense", description: "Record an expense the household already made (bookkeeping only; never pays).",
    shape: { ...ExpenseInput.shape, idempotency_key: idem }, risk: "bounded_write",
    run: (ctx, hid, a, x) => { const { idempotency_key, ...e } = x; return recordExpense(ctx, hid, a, ExpenseInput.parse(e), idempotency_key); } }),
  tool({ name: "get_bill_status", description: "Bills due within N days with state upcoming|due_today|overdue|needs_attention.",
    shape: { within_days: z.number().int().min(1).max(120).default(30) }, risk: "read", run: (ctx, hid, a, x) => getBillStatus(ctx, hid, a, x.within_days) }),

  // ---- maintenance ----
  tool({ name: "list_maintenance_records", description: "Maintenance requests and service records.",
    shape: { status: z.enum(["requested", "scheduled", "in_progress", "done", "cancelled"]).optional(), limit: z.number().int().min(1).max(100).default(30) },
    risk: "read", run: (ctx, hid, a, x) => listMaintenanceRecords(ctx, hid, a, x.status, x.limit) }),
  tool({ name: "create_maintenance_request", description: "Log a repair/service request. Does NOT contact any provider.",
    shape: { ...MaintenanceRequestInput.shape, idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => { const { idempotency_key, ...m } = x; return createMaintenanceRequest(ctx, hid, a, MaintenanceRequestInput.parse(m)); } }),
  tool({ name: "schedule_service_reminder", description: "Set an asset's next service date and a reminder task.",
    shape: { asset_id: z.string().max(128), due_at: IsoDateTime, note: z.string().max(500).optional() }, risk: "reversible_write",
    run: (ctx, hid, a, x) => scheduleServiceReminder(ctx, hid, a, { assetId: x.asset_id, dueAt: x.due_at, note: x.note }) }),

  // ---- calendar ----
  tool({ name: "list_events", description: "Calendar events between two ISO datetimes.",
    shape: { from: IsoDateTime, to: IsoDateTime, limit: z.number().int().min(1).max(200).default(50) }, risk: "read",
    run: (ctx, hid, a, x) => listEvents(ctx, hid, a, x.from, x.to, x.limit) }),
  tool({ name: "create_event", description: "Create a calendar event; returns any conflicts found.",
    shape: { ...EventInput.shape, idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => { const { idempotency_key, ...e } = x; return createEvent(ctx, hid, a, EventInput.parse(e)); } }),
  tool({ name: "check_schedule_conflicts", description: "Overlapping events for a time range and attendees.",
    shape: { start_at: IsoDateTime, end_at: IsoDateTime, attendee_uids: z.array(z.string().max(128)).max(30).default([]) }, risk: "read",
    run: (ctx, hid, a, x) => checkScheduleConflicts(ctx, hid, a, x.start_at, x.end_at, x.attendee_uids) }),

  // ---- approvals ----
  tool({ name: "request_approval", description: `Ask a person to approve an action. action: ${Object.keys(APPROVAL_ACTIONS).join("|")}. Include exact params, cost in minor units, recipient, date, data shared and consequences.`,
    shape: {
      action: z.string().max(60), title: z.string().min(1).max(160), rationale: z.string().min(1).max(1000),
      params: z.record(z.string(), z.unknown()), estimated_cost_minor: z.number().int().min(0).optional(), currency: z.string().length(3).optional(),
      recipient: z.string().max(200).optional(), relevant_date: z.string().max(40).optional(), data_shared: z.string().max(300).optional(),
      consequences: z.string().max(500).optional(), expires_in_hours: z.number().int().min(1).max(336).optional(), idempotency_key: idem,
    },
    risk: "read", // creating an approval record never performs the action itself
    run: (ctx, hid, a, x) => requestApproval(ctx, hid, a, {
      action: x.action, title: x.title, rationale: x.rationale, params: x.params as Record<string, unknown>,
      estimatedCostMinor: x.estimated_cost_minor, currency: x.currency, recipient: x.recipient, relevantDate: x.relevant_date,
      dataShared: x.data_shared, consequences: x.consequences, expiresInHours: x.expires_in_hours,
    }) }),
  tool({ name: "list_pending_approvals", description: "Approvals awaiting a decision.", shape: {}, risk: "read",
    run: (ctx, hid, a) => listPendingApprovals(ctx, hid, a) }),
  tool({ name: "get_approval_status", description: "Status and execution result of one approval.",
    shape: { approval_id: z.string().max(128) }, risk: "read", run: (ctx, hid, a, x) => getApproval(ctx, hid, a, x.approval_id) }),

  // ---- reports ----
  tool({ name: "get_household_report", description: "Facts for a period: overview|expenditure|tasks|shopping|maintenance|wastage.",
    shape: { kind: z.enum(["overview", "expenditure", "tasks", "shopping", "maintenance", "wastage"]), from: IsoDateTime, to: IsoDateTime },
    risk: "read", run: (ctx, hid, a, x) => getHouseholdReport(ctx, hid, a, x.kind as ReportKind, x.from, x.to) }),
  tool({ name: "get_agent_usage_report", description: "Agent runs, tokens and cost for a period (managers only).",
    shape: { from: IsoDateTime, to: IsoDateTime }, risk: "read", run: (ctx, hid, a, x) => getAgentUsageReport(ctx, hid, a, x.from, x.to) }),
];

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/** Lets an approval execute an agent-proposed tool call exactly as proposed, as the approving person. */
APPROVAL_ACTIONS.agent_tool_call = {
  schema: z.object({ tool: z.string().refine((n) => TOOL_INDEX.has(n) && TOOL_INDEX.get(n)!.risk !== "read", "Unknown or read-only tool"), args: z.record(z.string(), z.unknown()) })
    .superRefine((v, c) => {
      const t = TOOL_INDEX.get(v.tool);
      if (t && !z.object(t.shape).safeParse(v.args).success) c.addIssue({ code: "custom", message: `Invalid args for ${v.tool}` });
    }),
  run: async (ctx, hid, actor, p: { tool: string; args: Record<string, unknown> }) => {
    const t = TOOL_INDEX.get(p.tool)!;
    const args = z.object(t.shape).parse(p.args);
    return { tool: p.tool, result: (await t.run(ctx, hid, actor, args)) as Record<string, unknown> };
  },
};

export type ToolResult = { ok: true; data: unknown } | { ok: false; status?: string; error: { code: string; message: string; details?: unknown }; approvalId?: string };

/** Single entry point used by the MCP transport and by contract tests. */
export async function executeTool(ctx: Ctx, name: string, rawArgs: Record<string, unknown>, callerUid?: string): Promise<ToolResult> {
  const def = TOOL_INDEX.get(name);
  if (!def) return { ok: false, error: { code: "unknown_tool", message: `Unknown tool ${name}` } };
  try {
    const g = await useGrant(ctx, rawArgs.grant);
    // Hermes Mobile authenticates as the user; the grant must have been minted for that same user.
    if (callerUid !== undefined && g.uid !== callerUid) {
      return { ok: false, error: { code: "invalid_grant", message: "This grant belongs to a different user" } };
    }
    const { grant: _g, ...rest } = rawArgs;
    const parsed = z.object(def.shape).safeParse(rest);
    if (!parsed.success) {
      return { ok: false, error: { code: "invalid_argument", message: "Invalid arguments", details: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) } };
    }
    const actor: Actor = { uid: g.uid, kind: "agent", agentId: g.agentId, workflowId: g.workflowId };
    const hid = g.householdId;
    const policy = decide(await getAutonomy(ctx, hid), def.risk, def.sensitive);
    if (policy.outcome === "deny") return { ok: false, error: { code: "autonomy_paused", message: policy.reason } };
    if (policy.outcome === "approval_required") {
      const { idempotency_key: _k, ...args } = parsed.data as Record<string, unknown>;
      const approval = await requestApproval(ctx, hid, actor, {
        action: "agent_tool_call", title: `${name.replace(/_/g, " ")}`, rationale: policy.reason, params: { tool: name, args },
      });
      return { ok: false, status: "approval_required", approvalId: approval.approvalId, error: { code: "approval_required", message: `${policy.reason}. Approval ${approval.approvalId} was requested; this has NOT been done yet.` } };
    }
    const key = (parsed.data as { idempotency_key?: string }).idempotency_key;
    const data = def.risk === "read" && name !== "request_approval"
      ? await def.run(ctx, hid, actor, parsed.data)
      : await idempotent(ctx, { hid, uid: g.uid, op: `mcp:${name}` }, key, async () => ({ value: (await def.run(ctx, hid, actor, parsed.data)) as unknown })).then((r) => r.value ?? r);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
    return { ok: false, error: { code: "internal", message: "Tool failed" } };
  }
}

export { grant as grantArg };
