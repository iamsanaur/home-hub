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
import { createFixedBill, getBillStatus, getBudgetSummary, listExpenses, listBills, recordExpense } from "../services/finance";
import { addPantryItems, PantryBulkItem } from "../services/food";
import { createVendorBill, getBillLedger, resolveBill, setDeliveries, updateVendorBill } from "../services/vendorBills";
import { parseDecimal } from "../core/money";
import {
  checkScheduleConflicts, createEvent, createMaintenanceRequest, getHouseholdMembers, getHouseholdSummary,
  getMemberPermissions, listEvents, listMaintenanceRecords, scheduleServiceReminder,
} from "../services/home";
import { getHouseholdReport, ReportKind } from "../services/reports";
import { getAgentUsageReport } from "../services/usage";
import {
  adjustPantryByName, cancelEvent, createCleaningRoutine, createNote, createRecipe, EventPatch, findShoppingItem, FixedBillPatch, getShoppingList,
  addTaskComment, addToSavingsGoal, createAsset, createSavingsGoal, findMember, listAssets, listDocuments, listSavingsGoals, listTaskComments,
  listCleaning, listNotes, listRecipes, listShoppingLists, markCleaned, RecipeInput, removeShoppingItem, setBudget, updateEvent, updateFixedBill, updateShoppingItem,
} from "../services/assistantTools";
import { executeDeviceAction, listDevices, DeviceAction } from "../devices/devices";
import { AutomationInput, saveAutomation } from "../automations/automations";
import { executePluginTool, listIntegrations } from "../plugins/runtime";
import { PLUGIN_INDEX } from "../plugins/catalog";
import { listMemories, remember, deleteMemory } from "../services/memory";
import { getMembership, requireMember, ts } from "../services/base";
import { changeMemberRole, invite as inviteMember } from "../services/households";
import { recordBillPayment } from "../services/finance";
import { BillPaymentInput, InviteInput } from "../core/schemas";

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

const billRef = {
  bill: z.string().max(128).optional().describe("Which bill: its name, the vendor's name (e.g. 'Ramesh', 'milk') or its id. Optional when there is only one pay-per-delivery bill."),
  bill_id: z.string().max(128).optional().describe("Bill id, if you have it"),
  name: z.string().max(120).optional().describe("Alias of `bill`"),
};
const pickBill = (x: { bill?: string; bill_id?: string; name?: string }) => ({ billId: x.bill_id, name: x.bill ?? x.name });
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
  tool({ name: "mark_item_purchased", description: "Record that a person bought an item (restocks pantry). Does not buy anything. Pass the item's name (and the list if several) or its id; use get_shopping_list to see items.",
    shape: { item: z.string().max(120).optional().describe("Item name, e.g. 'milk'"), list: z.string().max(120).optional().describe("List name when the item could be on several"), item_id: z.string().max(128).optional(), actual_price_minor: z.number().int().min(0).optional() }, risk: "bounded_write",
    run: async (ctx, hid, a, x) => markItemPurchased(ctx, hid, a, await findShoppingItem(ctx, hid, a, { itemId: x.item_id, item: x.item, list: x.list }), x.actual_price_minor) }),
  tool({ name: "list_shopping_lists", description: "The household's shopping lists with item counts.", shape: {}, risk: "read", run: (ctx, hid, a) => listShoppingLists(ctx, hid, a) }),
  tool({ name: "get_shopping_list", description: "Items on a shopping list (what is still to buy by default). Omit list when there is only one.",
    shape: { list: z.string().max(120).optional().describe("List name or id"), include_purchased: z.boolean().default(false) }, risk: "read",
    run: (ctx, hid, a, x) => getShoppingList(ctx, hid, a, { list: x.list, includePurchased: x.include_purchased }) }),
  tool({ name: "update_shopping_item", description: "Change an item's quantity, unit, price estimate, brand or category.",
    shape: { item: z.string().max(120).optional(), list: z.string().max(120).optional(), item_id: z.string().max(128).optional(), quantity: z.number().positive().max(100000).optional(), unit: z.string().max(20).optional(), estimated_price_minor: z.number().int().min(0).nullable().optional(), preferred_brand: z.string().max(80).nullable().optional(), category: z.string().max(60).optional() }, risk: "reversible_write",
    run: async (ctx, hid, a, x) => updateShoppingItem(ctx, hid, a, await findShoppingItem(ctx, hid, a, { itemId: x.item_id, item: x.item, list: x.list }), { quantity: x.quantity, unit: x.unit, estimatedPriceMinor: x.estimated_price_minor, preferredBrand: x.preferred_brand, category: x.category }) }),
  tool({ name: "remove_shopping_item", description: "Take an item off a shopping list (it was added by mistake or is no longer needed).",
    shape: { item: z.string().max(120).optional(), list: z.string().max(120).optional(), item_id: z.string().max(128).optional() }, risk: "reversible_write",
    run: async (ctx, hid, a, x) => removeShoppingItem(ctx, hid, a, await findShoppingItem(ctx, hid, a, { itemId: x.item_id, item: x.item, list: x.list })) }),
  tool({ name: "adjust_pantry", description: "Record pantry use: kind consume (used), waste (thrown away) or restock (added), with the quantity in the item's own unit. Finds the item by name.",
    shape: { item: z.string().min(1).max(120), kind: z.enum(["consume", "waste", "restock"]), quantity: z.number().positive().max(100000), note: z.string().max(200).optional(), idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => adjustPantryByName(ctx, hid, a, { item: x.item, kind: x.kind, quantity: x.quantity, note: x.note }) }),

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

  tool({ name: "list_bills", description: "All active bills: id, name, vendor, amount, next due date, and for pay-per-delivery bills (milk, newspaper, maid…) the unit and rate. Use this to find a bill id.",
    shape: {}, risk: "read", run: (ctx, hid, a) => listBills(ctx, hid, a) }),

  tool({ name: "create_bill",
    description: "Create a bill with a FIXED amount: rent, a househelp's or driver's monthly salary, insurance, loan EMI, school fees, subscriptions, utilities. Use this whenever the person gives one amount for the period (e.g. '₹2,000 a month', 'rent 13,000'). amount is in MAJOR units (₹13,000 → 13000). Do NOT use create_vendor_bill for these.",
    shape: {
      name: z.string().min(1).max(120).describe("e.g. 'Rent'"), provider: z.string().max(120).optional(),
      amount: z.number().positive().max(100_000_000).describe("the full amount for each period in major units, at most 2 decimals"),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("next due date YYYY-MM-DD"),
      repeat: z.enum(["monthly", "yearly", "none"]).default("monthly"), category: z.string().max(60).default("Utilities"),
      idempotency_key: idem,
    }, risk: "reversible_write",
    run: async (ctx, hid, a, x) => {
      const cur = (await ctx.db.doc(paths.household(hid)).get()).data()?.currency ?? "INR";
      return createFixedBill(ctx, hid, a, { name: x.name, provider: x.provider, amountMinor: parseDecimal(String(x.amount), cur).amountMinor, dueDate: x.due_date, repeat: x.repeat, category: x.category, reminderDaysBefore: 3, idempotencyKey: x.idempotency_key });
    } }),

  // ---- vendor bills: pay by what was actually delivered (milk per liter, newspaper per copy, maid per day, water cans, tiffin) ----
  tool({ name: "create_vendor_bill",
    description: "ONLY for a bill that is priced PER UNIT delivered, where a missed day is not charged: milk per liter, newspaper per copy, maid paid per day worked, water cans, tiffin per meal. If the person gives a single monthly/fixed amount (rent, a salary, '₹2,000 a month'), use create_bill instead. If you are unsure whether the amount is per unit or per month, ask. The monthly amount is quantity delivered × rate. Examples: milk (unit l, ₹60/l, 1 l a day), newspaper (copies), maid or cook (days, weekdays Mon–Sat), water cans, tiffin (meals). rate_per_unit is in MAJOR units (₹60 → 60, ₹52.50 → 52.5). The bill for a month's deliveries falls due on due_day of the next month.",
    shape: {
      name: z.string().min(1).max(120).describe("e.g. 'Milk vendor'"), vendor: z.string().max(120).optional().describe("vendor's name"),
      unit: z.string().min(1).max(20).default("l").describe("l, kg, copies, days, cans, meals…"),
      rate_per_unit: z.number().positive().max(1_000_000).describe("price of ONE unit in major currency units, at most 2 decimals"),
      default_quantity: z.number().min(0).max(1000).default(1).describe("normal quantity on a delivery day"),
      weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]).describe("ISO weekdays delivered: 1=Mon … 7=Sun"),
      due_day: z.number().int().min(1).max(28).default(5).describe("day of the following month the bill is due"),
      category: z.string().max(60).default("Groceries"), start_month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("first month to track, YYYY-MM (default: this month)"),
      confirm_large: z.boolean().default(false).describe("Set true ONLY after the person confirmed the per-unit rate really gives a large monthly total"),
      idempotency_key: idem,
    }, risk: "reversible_write",
    run: async (ctx, hid, a, x) => {
      const cur = (await ctx.db.doc(paths.household(hid)).get()).data()?.currency ?? "INR";
      const rateMinor = parseDecimal(String(x.rate_per_unit), cur).amountMinor;
      // Sanity check: a monthly amount mistaken for a per-unit rate gets multiplied by ~30. Catch that before it is stored.
      const monthlyMinor = Math.round(rateMinor * x.default_quantity * x.weekdays.length * 52 / 12);
      if (monthlyMinor > 2_500_000 && !x.confirm_large) {
        throw new AppError(400, "needs_confirmation", `At ${x.rate_per_unit} per ${x.unit} this bill would come to about ${Math.round(monthlyMinor / 100).toLocaleString("en-IN")} a month. If ${x.rate_per_unit} is the total for the month (rent, a salary), call create_bill instead. If it really is per ${x.unit}, ask the person to confirm, then call again with confirm_large=true.`);
      }
      return createVendorBill(ctx, hid, a, { name: x.name, vendor: x.vendor, unit: x.unit, rateMinor, defaultQuantity: x.default_quantity, weekdays: x.weekdays, dueDay: x.due_day, category: x.category, startMonth: x.start_month, idempotencyKey: x.idempotency_key });
    } }),
  tool({ name: "update_vendor_bill",
    description: "Change a pay-per-delivery bill: price, normal quantity, delivery weekdays or due day. A new price applies from NEXT month unless apply_to_current_month is true. Identify the bill by bill_id or by name.",
    shape: {
      ...billRef,
      rate_per_unit: z.number().positive().max(1_000_000).optional(), default_quantity: z.number().min(0).max(1000).optional(),
      weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(), due_day: z.number().int().min(1).max(28).optional(),
      apply_to_current_month: z.boolean().default(false),
    }, risk: "bounded_write",
    run: async (ctx, hid, a, x) => {
      const bill = await resolveBill(ctx, hid, pickBill(x));
      const cur = (await ctx.db.doc(paths.household(hid)).get()).data()?.currency ?? "INR";
      return updateVendorBill(ctx, hid, a, bill.id, {
        rateMinor: x.rate_per_unit !== undefined ? parseDecimal(String(x.rate_per_unit), cur).amountMinor : undefined,
        defaultQuantity: x.default_quantity, weekdays: x.weekdays, dueDay: x.due_day, applyToCurrentMonth: x.apply_to_current_month,
      });
    } }),
  tool({ name: "record_deliveries",
    description: "Record what the vendor actually delivered. quantity 0 = did not come (not charged); a number = that quantity (extra or less); null = back to the normal schedule. Use entries for single dates and ranges for leave periods (e.g. vendor away 10–15 Nov: from 2026-11-10, to 2026-11-15, quantity 0). Dates are YYYY-MM-DD. Returns the updated month total.",
    shape: {
      ...billRef,
      entries: z.array(z.object({ date: IsoDate, quantity: z.number().min(0).max(1000).nullable() })).max(62).default([]),
      ranges: z.array(z.object({ from: IsoDate, to: IsoDate, quantity: z.number().min(0).max(1000).nullable() })).max(10).default([]),
      // Shorthand the model often reaches for: several dates sharing one quantity (0 = did not come), or one from–to range.
      dates: z.array(IsoDate).max(62).optional().describe("Shorthand: dates that all get `quantity`"),
      from: IsoDate.optional(), to: IsoDate.optional(), date: IsoDate.optional().describe("Shorthand: one date that gets `quantity`"),
      items: z.array(z.object({ quantity: z.number().min(0).max(1000).nullable().optional() }).passthrough()).max(5).optional().describe("Ignored except for a quantity when `quantity` is omitted"),
      quantity: z.number().min(0).max(1000).nullable().optional().describe("Quantity for `dates` or from–to (0 = did not come)"),
    }, risk: "reversible_write",
    run: async (ctx, hid, a, x) => {
      const bill = await resolveBill(ctx, hid, pickBill(x));
      const q = x.quantity !== undefined ? x.quantity : (x.items?.[0]?.quantity ?? 0);
      // Explicit entries win; the shorthand only adds dates the entries don't already cover.
      const covered = new Set(x.entries.map((e) => e.date));
      const all = [...x.entries, ...[...(x.dates ?? []), ...(x.date ? [x.date] : [])].filter((d) => !covered.has(d)).map((date) => ({ date, quantity: q }))];
      if (x.from) x.ranges.push({ from: x.from, to: x.to ?? x.from, quantity: q });
      if (!all.length && !x.ranges.length) throw new AppError(400, "invalid_argument", 'Nothing to record. Send entries:[{"date":"2026-11-03","quantity":0}] and/or ranges:[{"from":"2026-11-09","to":"2026-11-11","quantity":0}]');
      for (const r of x.ranges) {
        let d = DateTime.fromISO(r.from, { zone: "utc" }); const end = DateTime.fromISO(r.to, { zone: "utc" });
        if (end < d || end.diff(d, "days").days > 61) throw new AppError(400, "invalid_argument", "Each range must be 1–62 days and end after it starts");
        for (; d <= end; d = d.plus({ days: 1 })) all.push({ date: d.toISODate()!, quantity: r.quantity });
      }
      return setDeliveries(ctx, hid, a, bill.id, all);
    } }),
  tool({ name: "get_bill_ledger",
    description: "A pay-per-delivery bill for one month (YYYY-MM, default: the month being collected): each day's quantity, how many days were skipped, quantity delivered, the charge so far and the month's total in minor units.",
    shape: { ...billRef, month: z.string().regex(/^\d{4}-\d{2}$/).optional() }, risk: "read",
    run: async (ctx, hid, a, x) => {
      const bill = await resolveBill(ctx, hid, pickBill(x));
      const l = await getBillLedger(ctx, hid, a, bill.id, x.month);
      // Compact for the model: list only the days that differ from the normal schedule.
      return { bill: l.bill, month: l.month, paid: l.paid, dueAt: l.dueAt, totals: l.totals, exceptions: l.days.filter((d) => d.status === "skipped" || d.status === "extra" || (d.scheduled && d.quantity !== l.bill.defaultQuantity)).map((d) => ({ date: d.date, quantity: d.quantity, status: d.status })) };
    } }),

  // ---- pantry in bulk ----
  tool({ name: "add_pantry_items",
    description: "Add several items to the pantry in one call (up to 100). Items already in the pantry with the same name and unit have the quantity added instead of duplicated. Convert the user's wording into items yourself, e.g. '2 kg rice, milk 2 l, a dozen eggs' → [{name:'Rice',quantity:2,unit:'kg'},{name:'Milk',quantity:2,unit:'l'},{name:'Eggs',quantity:1,unit:'dozen'}]. Units: pcs, kg, g, l, ml, pack, dozen, bunch.",
    shape: { items: z.array(PantryBulkItem).min(1).max(100), idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => idempotent(ctx, { hid, uid: a.uid, op: "add_pantry_items" }, x.idempotency_key, () => addPantryItems(ctx, hid, a, x.items) as Promise<Record<string, unknown>>) }),

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

  // ---- more of what the apps can do ----
  tool({ name: "record_income", description: "Record income the household already received (salary, rent received, refund). Bookkeeping only. Amount in minor units.",
    shape: { amountMinor: ExpenseInput.shape.amountMinor, currency: ExpenseInput.shape.currency, category: z.string().min(1).max(60).default("Income"), description: z.string().max(200).optional(), paymentMethod: ExpenseInput.shape.paymentMethod.default("bank_transfer"), occurredAt: IsoDateTime, idempotency_key: idem },
    risk: "bounded_write", run: (ctx, hid, a, x) => { const { idempotency_key, ...e } = x; return recordExpense(ctx, hid, a, { ...ExpenseInput.parse(e), type: "income" }, idempotency_key); } }),
  tool({ name: "set_budget", description: "Set (or change) a monthly budget limit. category '*' is the overall monthly budget. limit is in MAJOR units (₹40,000 → 40000).",
    shape: { period: z.string().regex(/^\d{4}-\d{2}$/).describe("YYYY-MM"), category: z.string().min(1).max(60).default("*"), limit: z.number().positive().max(100_000_000), idempotency_key: idem }, risk: "bounded_write",
    run: async (ctx, hid, a, x) => { const cur = (await ctx.db.doc(paths.household(hid)).get()).data()?.currency ?? "INR"; return setBudget(ctx, hid, a, { period: x.period, category: x.category, limitMinor: parseDecimal(String(x.limit), cur).amountMinor }); } }),
  tool({ name: "update_bill", description: "Change a FIXED bill: its name, amount (major units), next due date, repeat, or switch it off (active:false). For pay-per-delivery bills use update_vendor_bill.",
    shape: { bill: z.string().max(128).describe("Bill name or id"), name: z.string().max(120).optional(), amount: z.number().positive().max(100_000_000).optional(), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), repeat: z.enum(["monthly", "yearly", "none"]).optional(), active: z.boolean().optional() }, risk: "bounded_write",
    run: async (ctx, hid, a, x) => {
      const cur = (await ctx.db.doc(paths.household(hid)).get()).data()?.currency ?? "INR";
      const bills = (await listBills(ctx, hid, a)) as unknown as Array<{ id: string; name: string }>;
      const b = bills.find((y) => y.id === x.bill) ?? bills.filter((y) => y.name.toLowerCase().includes(x.bill.toLowerCase()));
      const hit = Array.isArray(b) ? (b.length === 1 ? b[0] : null) : b;
      if (!hit) throw new AppError(400, "invalid_argument", `Say which bill. Yours: ${bills.map((y) => y.name).join(", ")}`);
      return updateFixedBill(ctx, hid, a, hit.id, FixedBillPatch.parse({ name: x.name, amountMinor: x.amount === undefined ? undefined : parseDecimal(String(x.amount), cur).amountMinor, dueDate: x.due_date, repeat: x.repeat, active: x.active }));
    } }),
  tool({ name: "update_event", description: "Change a calendar event (title, start/end, place, type). Returns any new conflicts.",
    shape: { event_id: z.string().max(128), ...EventPatch.shape }, risk: "reversible_write",
    run: (ctx, hid, a, x) => { const { event_id, ...p } = x; return updateEvent(ctx, hid, a, event_id, p); } }),
  tool({ name: "cancel_event", description: "Cancel (remove) a calendar event.", shape: { event_id: z.string().max(128) }, risk: "bounded_write",
    run: (ctx, hid, a, x) => cancelEvent(ctx, hid, a, x.event_id) }),
  tool({ name: "list_recipes", description: "Saved recipes with ingredients.", shape: { limit: z.number().int().min(1).max(100).default(30) }, risk: "read", run: (ctx, hid, a, x) => listRecipes(ctx, hid, a, x.limit) }),
  tool({ name: "create_recipe", description: "Save a recipe (name, servings, ingredients with quantity and unit). Meal plans and shopping lists can then use it.",
    shape: { ...RecipeInput.shape, idempotency_key: idem }, risk: "reversible_write", run: (ctx, hid, a, x) => { const { idempotency_key, ...r } = x; return createRecipe(ctx, hid, a, RecipeInput.parse(r)); } }),
  tool({ name: "list_cleaning", description: "Cleaning routines: room, how often, who, next due, last done.", shape: {}, risk: "read", run: (ctx, hid, a) => listCleaning(ctx, hid, a) }),
  tool({ name: "create_cleaning_routine", description: "Add a room-wise cleaning routine (daily, weekly, monthly or seasonal), optionally assigned and as a deep clean.",
    shape: { title: z.string().min(1).max(120), room: z.string().max(80).optional(), frequency: z.enum(["daily", "weekly", "monthly", "seasonal"]), assignee_uid: z.string().max(128).optional(), next_due_at: IsoDateTime.optional(), deep_clean: z.boolean().default(false), idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => createCleaningRoutine(ctx, hid, a, { title: x.title, roomName: x.room, frequency: x.frequency, assigneeUid: x.assignee_uid, nextDueAt: x.next_due_at, deepClean: x.deep_clean }) }),
  tool({ name: "mark_cleaned", description: "Record that a cleaning routine was done now; schedules the next one.", shape: { routine: z.string().min(1).max(120).describe("Routine name or id") }, risk: "reversible_write", run: (ctx, hid, a, x) => markCleaned(ctx, hid, a, x.routine) }),
  tool({ name: "list_notes", description: "Shared household notes and your own private notes (title and a short excerpt).", shape: { limit: z.number().int().min(1).max(50).default(20) }, risk: "read", run: (ctx, hid, a, x) => listNotes(ctx, hid, a, x.limit) }),
  tool({ name: "create_note", description: "Save a note. visibility 'private' (only the person) or 'household'.",
    shape: { title: z.string().min(1).max(120), body: z.string().max(20000), visibility: z.enum(["private", "household"]).default("private"), idempotency_key: idem }, risk: "reversible_write", run: (ctx, hid, a, x) => createNote(ctx, hid, a, { title: x.title, body: x.body, visibility: x.visibility }) }),

  // ---- memory ----
  tool({ name: "list_memories", description: "What HomeHub remembers (household preferences and the person's private ones), with ids.", shape: {}, risk: "read", run: (ctx, hid, a) => listMemories(ctx, hid, a) }),
  tool({ name: "remember_preference", description: "Save a lasting preference or fact the person told you (e.g. 'we are vegetarian', 'no onions on Tuesdays'). Not for passing remarks, passwords or sensitive data.",
    shape: { text: z.string().min(3).max(300), scope: z.enum(["household", "private"]).default("household"), kind: z.enum(["preference", "fact"]).default("preference"), idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => remember(ctx, hid, a, { scope: x.scope, kind: x.kind, text: x.text }) }),
  tool({ name: "forget_memory", description: "Delete one remembered item by id (see list_memories).", shape: { memory_id: z.string().max(128) }, risk: "bounded_write", run: async (ctx, hid, a, x) => { await deleteMemory(ctx, hid, a, x.memory_id); return { forgotten: x.memory_id }; } }),

  // ---- devices, automations and connected services ----
  tool({ name: "list_devices", description: "Smart-home devices with room, current state and what they can do.", shape: {}, risk: "read",
    run: async (ctx, hid, a) => { const r = await listDevices(ctx, hid, a); return { rooms: r.rooms, devices: r.devices.map((d: Record<string, unknown>) => ({ id: d.id, name: d.name, type: d.type, room: d.roomName ?? d.roomId ?? null, state: d.state, reachable: d.reachable, capabilities: d.capabilities, safety: d.safety })) }; } }),
  tool({ name: "control_device", description: "Switch or adjust a device and check it really changed. Locks, doors and heaters always need a person's approval; the result says so. action: power_on, power_off, lock, unlock, set_brightness (value 0-100), set_temperature (value in °C).",
    shape: { device: z.string().min(1).max(120).describe("Device name or id"), action: z.enum(["power_on", "power_off", "lock", "unlock", "set_brightness", "set_temperature"]), value: z.number().min(0).max(100).optional(), idempotency_key: idem }, risk: "reversible_write",
    run: async (ctx, hid, a, x) => {
      const all = (await listDevices(ctx, hid, a)).devices as Array<{ id: string; name: string }>;
      const key = x.device.toLowerCase();
      const hits = all.filter((d) => d.id === x.device || d.name.toLowerCase() === key);
      const some = hits.length ? hits : all.filter((d) => d.name.toLowerCase().includes(key));
      if (some.length !== 1) throw new AppError(400, "invalid_argument", some.length ? `More than one device matches: ${some.map((d) => d.name).join(", ")}` : `No device called "${x.device}". Devices: ${all.slice(0, 12).map((d) => d.name).join(", ")}`);
      const act: DeviceAction = x.action === "power_on" ? { type: "power", value: "ON" } : x.action === "power_off" ? { type: "power", value: "OFF" } : x.action === "lock" ? { type: "lock" } : x.action === "unlock" ? { type: "unlock" }
        : x.action === "set_brightness" ? { type: "brightness", value: Math.round(x.value ?? NaN) } : { type: "thermostat", targetTemperature: x.value };
      if ((x.action === "set_brightness" || x.action === "set_temperature") && x.value === undefined) throw new AppError(400, "invalid_argument", "This action needs a value");
      const r = await executeDeviceAction(ctx, hid, a, some[0].id, act, { channel: "agent_server", idempotencyKey: x.idempotency_key });
      return { device: some[0].name, ...r, done: r.status === "verified" };
    } }),
  tool({ name: "list_automations", description: "Automations (when X happens, do Y) with whether each is on and when it last ran.", shape: {}, risk: "read",
    run: async (ctx, hid, a) => { await requireMember(ctx, hid, a.uid); const s = await ctx.db.collection(paths.col(hid, "automations")).limit(100).get(); return s.docs.map((d) => ({ id: d.id, name: d.data().name, enabled: d.data().enabled !== false, trigger: d.data().trigger, lastStatus: d.data().lastStatus ?? null })); } }),
  tool({ name: "set_automation_enabled", description: "Turn an automation on or off (owners and administrators).", shape: { automation: z.string().min(1).max(120).describe("Name or id"), enabled: z.boolean() }, risk: "bounded_write",
    run: async (ctx, hid, a, x) => {
      const m = await getMembership(ctx, hid, a.uid);
      if (!m || !["owner", "admin"].includes(m.role)) throw new AppError(403, "forbidden", "Only managers can change automations");
      const s = await ctx.db.collection(paths.col(hid, "automations")).limit(100).get();
      const hits = s.docs.filter((d) => d.id === x.automation || String(d.data().name).toLowerCase().includes(x.automation.toLowerCase()));
      if (hits.length !== 1) throw new AppError(400, "invalid_argument", hits.length ? `More than one automation matches: ${hits.map((d) => d.data().name).join(", ")}` : "No automation with that name");
      await hits[0].ref.update({ enabled: x.enabled, updatedBy: a.uid, updatedAt: ts(ctx.now()) });
      return { id: hits[0].id, name: hits[0].data().name, enabled: x.enabled };
    } }),
  tool({ name: "create_automation", description: "Propose a new automation (trigger, conditions, actions). Always needs a manager's approval before it exists.",
    shape: { ...AutomationInput.shape, idempotency_key: idem }, risk: "sensitive", sensitive: "irreversible",
    run: (ctx, hid, a, x) => { const { idempotency_key, ...auto } = x; return saveAutomation(ctx, a, hid, auto); } }),
  tool({ name: "list_integrations", description: "Connected services (calendar, messaging, smart-home hubs…) and the tools each offers, with which need approval.", shape: {}, risk: "read",
    run: async (ctx, hid, a) => (await listIntegrations(ctx, a, hid)).filter((i) => i.status === "connected" && i.category !== "ai_provider").map((i) => ({
      id: i.id, name: i.name, tools: (PLUGIN_INDEX.get(i.pluginId)?.manifest.tools ?? []).filter((t) => i.enabledTools.includes(t.name)).map((t) => ({ name: t.name, what: t.description, access: t.access, needsApproval: t.confirmation === "approval" || t.physicalSafety })),
    })) }),
  tool({ name: "call_integration_tool", description: "Use a connected service's tool (e.g. read the Google Calendar, post to Telegram). Anything that sends or changes something outside HomeHub is held for approval and NOT done until approved. Use list_integrations first.",
    shape: { integration: z.string().min(1).max(120).describe("Integration name or id"), tool: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()).default({}), idempotency_key: idem }, risk: "reversible_write",
    run: async (ctx, hid, a, x) => {
      const items = (await listIntegrations(ctx, a, hid)).filter((i) => i.status === "connected");
      const q = x.integration.toLowerCase();
      const hits = items.filter((i) => i.id === x.integration) .concat(items.filter((i) => i.id !== x.integration && (i.name.toLowerCase().includes(q) || i.pluginId.toLowerCase().includes(q))));
      if (hits.length !== 1) throw new AppError(400, "invalid_argument", hits.length ? `More than one integration matches: ${hits.map((i) => i.name).join(", ")}` : `No connected integration "${x.integration}". Connected: ${items.map((i) => i.name).join(", ") || "none"}`);
      const r = await executePluginTool(ctx, hid, a, hits[0].id, x.tool, x.input, { channel: "agent_server", idempotencyKey: x.idempotency_key });
      return r.ok ? { done: true, result: r.data } : { done: false, status: r.status, approvalId: "approvalId" in r ? r.approvalId : undefined, message: r.message };
    } }),

  // ---- savings, assets, comments, documents ----
  tool({ name: "list_savings_goals", description: "Savings goals with saved, remaining and percent (amounts in minor units).", shape: {}, risk: "read", run: (ctx, hid, a) => listSavingsGoals(ctx, hid, a) }),
  tool({ name: "create_savings_goal", description: "Create a savings goal. target is in MAJOR units (₹60,000 → 60000). Bookkeeping only.",
    shape: { name: z.string().min(1).max(120), target: z.number().positive().max(1_000_000_000), already_saved: z.number().min(0).max(1_000_000_000).default(0), target_date: IsoDateTime.optional(), idempotency_key: idem }, risk: "bounded_write",
    run: async (ctx, hid, a, x) => { const cur = (await ctx.db.doc(paths.household(hid)).get()).data()?.currency ?? "INR"; return createSavingsGoal(ctx, hid, a, { name: x.name, targetMinor: parseDecimal(String(x.target), cur).amountMinor, savedMinor: parseDecimal(String(x.already_saved), cur).amountMinor, targetDate: x.target_date }); } }),
  tool({ name: "add_to_savings_goal", description: "Record money set aside for a goal (positive) or taken out (negative), in MAJOR units. Bookkeeping only; it never moves money.",
    shape: { goal: z.string().min(1).max(120).describe("Goal name or id"), amount: z.number().min(-1_000_000_000).max(1_000_000_000), idempotency_key: idem }, risk: "bounded_write",
    run: async (ctx, hid, a, x) => { const cur = (await ctx.db.doc(paths.household(hid)).get()).data()?.currency ?? "INR"; const m = parseDecimal(String(Math.abs(x.amount)), cur).amountMinor; return addToSavingsGoal(ctx, hid, a, x.goal, x.amount < 0 ? -m : m); } }),
  tool({ name: "list_assets", description: "Household assets (appliances, vehicles, big items) with warranty and next service dates.", shape: {}, risk: "read", run: (ctx, hid, a) => listAssets(ctx, hid, a) }),
  tool({ name: "create_asset", description: "Add an asset so maintenance and warranty can be tracked.",
    shape: { name: z.string().min(1).max(120), category: z.string().max(40).optional(), brand: z.string().max(60).optional(), model: z.string().max(60).optional(), location: z.string().max(80).optional(), purchase_date: IsoDateTime.optional(), warranty_expires_at: IsoDateTime.optional(), service_interval_days: z.number().int().min(1).max(3650).optional(), idempotency_key: idem }, risk: "reversible_write",
    run: (ctx, hid, a, x) => createAsset(ctx, hid, a, { name: x.name, category: x.category, brand: x.brand, model: x.model, location: x.location, purchaseDate: x.purchase_date, warrantyExpiresAt: x.warranty_expires_at, serviceIntervalDays: x.service_interval_days }) }),
  tool({ name: "list_task_comments", description: "Comments on a task, oldest first.", shape: { task_id: z.string().max(128) }, risk: "read", run: (ctx, hid, a, x) => listTaskComments(ctx, hid, a, x.task_id) }),
  tool({ name: "add_task_comment", description: "Add a comment to a task (visible to adults and the assignee).", shape: { task_id: z.string().max(128), body: z.string().min(1).max(2000), idempotency_key: idem }, risk: "reversible_write", run: (ctx, hid, a, x) => addTaskComment(ctx, hid, a, x.task_id, x.body) }),
  tool({ name: "list_documents", description: "Document records (title, category, expiry) the person may see — never file contents. Use expiring_within_days for renewals.",
    shape: { category: z.string().max(60).optional(), expiring_within_days: z.number().int().min(0).max(3650).optional(), limit: z.number().int().min(1).max(100).default(30) }, risk: "read",
    run: (ctx, hid, a, x) => listDocuments(ctx, hid, a, { category: x.category, expiringWithinDays: x.expiring_within_days, limit: x.limit }) }),

  // ---- people and payments: always held for a person's approval, then run as that person ----
  tool({ name: "invite_member", description: "Propose inviting someone to the household. ALWAYS needs a manager's approval; once approved the invitation is created and shown in Family (you never see or send the link).",
    shape: { email: z.string().email().max(254), role: z.enum(["admin", "adult", "child", "staff"]), display_name: z.string().max(120).optional() }, risk: "sensitive", sensitive: "external_message",
    run: async (ctx, hid, a, x) => { const r = await inviteMember(ctx, a, hid, InviteInput.parse({ email: x.email, role: x.role, displayName: x.display_name })); return { invitationId: r.invitationId, expiresAt: r.expiresAt }; } }),
  tool({ name: "change_member_role", description: "Propose changing a member's role (admin, adult, child, staff). ALWAYS needs approval from an owner or administrator.",
    shape: { member: z.string().min(1).max(120).describe("Member's name or id"), role: z.enum(["admin", "adult", "child", "staff"]) }, risk: "sensitive", sensitive: "irreversible",
    run: async (ctx, hid, a, x) => { const m = await findMember(ctx, hid, x.member); await changeMemberRole(ctx, a, hid, m.uid, { role: x.role }); return { member: m.name, role: x.role }; } }),
  tool({ name: "record_bill_payment", description: "Propose recording that a bill was paid (amount in MAJOR units, paid date, method). ALWAYS needs a person's approval and is bookkeeping only: HomeHub never pays anything. Do not use unless the person says they already paid.",
    shape: { bill: z.string().min(1).max(128).describe("Bill name or id"), amount: z.number().positive().max(100_000_000), paid_at: IsoDateTime, method: z.enum(["cash", "upi", "card", "bank_transfer", "wallet", "other"]), reference: z.string().max(120).optional(), idempotency_key: idem }, risk: "sensitive", sensitive: "payment",
    run: async (ctx, hid, a, x) => {
      const cur = (await ctx.db.doc(paths.household(hid)).get()).data()?.currency ?? "INR";
      const bills = (await listBills(ctx, hid, a)) as unknown as Array<{ id: string; name: string }>;
      const hit = bills.find((b) => b.id === x.bill) ?? (() => { const c = bills.filter((b) => b.name.toLowerCase().includes(x.bill.toLowerCase())); return c.length === 1 ? c[0] : undefined; })();
      if (!hit) throw new AppError(400, "invalid_argument", `Say which bill. Yours: ${bills.map((b) => b.name).join(", ")}`);
      return recordBillPayment(ctx, hid, a, hit.id, BillPaymentInput.parse({ amountMinor: parseDecimal(String(x.amount), cur).amountMinor, currency: cur, paidAt: x.paid_at, method: x.method, reference: x.reference, idempotencyKey: x.idempotency_key ?? `agent-pay-${hit.id}-${x.paid_at}` }));
    } }),

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
