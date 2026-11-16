import { z } from "zod";
import { ROLES } from "./roles";
import { AUTONOMY_MODES } from "./autonomy";

/**
 * Shared contract schemas. Exported as JSON Schema into shared/schemas by
 * `npm run schemas` so native clients and docs stay in sync with the server.
 */
export const Currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code");
export const MinorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const IsoDateTime = z.string().datetime({ offset: true });
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const IdempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9_:.-]+$/);

export const RecurrenceRuleSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(366).optional(),
  byWeekday: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  byMonthDay: z.number().int().min(-1).max(31).optional(),
  count: z.number().int().min(1).optional(),
  until: z.string().optional(),
});

export const Priority = z.enum(["low", "normal", "high", "urgent"]);
export const TaskStatus = z.enum(["open", "in_progress", "done", "cancelled"]);

export const CreateHouseholdInput = z.object({
  name: z.string().trim().min(1).max(80),
  currency: Currency,
  timezone: z.string().min(1).max(64),
  locale: z.string().min(2).max(35).default("en"),
  country: z.string().length(2).optional(),
});

export const InviteInput = z.object({
  email: z.string().email().max(254).optional(),
  displayName: z.string().max(120).optional(),
  role: z.enum(ROLES).refine((r) => r !== "owner", "Ownership is transferred, not invited"),
});

export const TaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(4000).optional(),
  category: z.string().max(60).optional(),
  priority: Priority.default("normal"),
  dueAt: IsoDateTime.optional(),
  assigneeUid: z.string().max(128).optional(),
  recurrence: RecurrenceRuleSchema.optional(),
  checklist: z.array(z.object({ id: z.string().max(64), text: z.string().max(200), done: z.boolean() })).max(50).optional(),
});

export const TaskUpdateInput = TaskInput.partial().extend({
  status: TaskStatus.optional(),
});

export const ShoppingItemInput = z.object({
  listId: Id,
  name: z.string().trim().min(1).max(120),
  quantity: z.number().positive().max(100000).default(1),
  unit: z.string().max(20).default("pcs"),
  category: z.string().max(60).default("Other"),
  preferredBrand: z.string().max(80).optional(),
  preferredStore: z.string().max(80).optional(),
  estimatedPriceMinor: MinorUnits.optional(),
});

export const ExpenseInput = z.object({
  amountMinor: MinorUnits.refine((v) => v > 0, "Amount must be positive"),
  currency: Currency,
  category: z.string().trim().min(1).max(60),
  description: z.string().max(200).optional(),
  paymentMethod: z.enum(["cash", "upi", "card", "bank_transfer", "wallet", "other"]),
  occurredAt: IsoDateTime,
});

export const MealSlot = z.enum(["breakfast", "lunch", "dinner", "snack"]);
export const MealPlanEntry = z.object({
  date: IsoDate,
  slot: MealSlot,
  recipeId: Id.optional(),
  title: z.string().max(120),
  servings: z.number().int().min(1).max(50).default(2),
});
export const MealPlanInput = z.object({
  weekStart: IsoDate,
  entries: z.array(MealPlanEntry).max(7 * 4 * 2),
});

export const EventInput = z.object({
  title: z.string().trim().min(1).max(160),
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  category: z.enum(["appointment", "birthday", "anniversary", "school", "bill", "task", "social", "other"]).default("other"),
  attendeeUids: z.array(z.string().max(128)).max(30).default([]),
  location: z.string().max(200).optional(),
  visibility: z.enum(["household", "adults"]).default("household"),
  staffVisible: z.boolean().default(false),
});

export const MaintenanceRequestInput = z.object({
  title: z.string().trim().min(1).max(160),
  assetId: Id.optional(),
  description: z.string().max(2000).optional(),
  priority: Priority.default("normal"),
  preferredDates: z.array(IsoDate).max(5).optional(),
  providerName: z.string().max(120).optional(),
});

export const ApprovalDecisionInput = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

export const AutonomyInput = z.object({
  mode: z.enum(AUTONOMY_MODES as [string, ...string[]]).optional(),
  paused: z.boolean().optional(),
});

export const AgentRunInput = z.object({
  message: z.string().trim().min(1).max(4000),
  sessionId: Id.optional(),
  idempotencyKey: IdempotencyKey.optional(),
});

export const BillPaymentInput = z.object({
  amountMinor: MinorUnits.refine((v) => v > 0),
  currency: Currency,
  paidAt: IsoDateTime,
  method: z.enum(["cash", "upi", "card", "bank_transfer", "wallet", "other"]),
  reference: z.string().max(120).optional(),
  idempotencyKey: IdempotencyKey,
});

export const DeviceInput = z.object({
  deviceId: Id,
  token: z.string().min(10).max(4096),
  platform: z.enum(["android", "ios"]),
  appVersion: z.string().max(40).optional(),
});

export const SCHEMAS = {
  CreateHouseholdInput, InviteInput, TaskInput, TaskUpdateInput, ShoppingItemInput, ExpenseInput,
  MealPlanInput, EventInput, MaintenanceRequestInput, ApprovalDecisionInput, AutonomyInput,
  AgentRunInput, BillPaymentInput, DeviceInput, RecurrenceRuleSchema,
};
