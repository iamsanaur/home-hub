import { DateTime } from "luxon";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { ratioBasisPoints } from "../core/money";
import { nextOccurrence, RecurrenceRule } from "../core/recurrence";
import { BillPaymentInput, ExpenseInput } from "../core/schemas";
import {
  Actor, audit, Ctx, idempotent, invalid, notFound, paths, requireCapability, ts,
} from "./base";
import { createDoc, toIso } from "./docs";
import { closeCycleInTransaction } from "./vendorBills";

async function hh(ctx: Ctx, hid: string) {
  const snap = await ctx.db.doc(paths.household(hid)).get();
  if (!snap.exists) throw notFound("Household");
  return snap.data()! as { currency: string; timezone: string };
}

export function monthRange(period: string, tz: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}$/.test(period)) throw invalid("period must be YYYY-MM");
  const start = DateTime.fromISO(`${period}-01`, { zone: tz }).startOf("month");
  return { start: start.toJSDate(), end: start.plus({ months: 1 }).toJSDate() };
}

export async function recordExpense(
  ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof ExpenseInput> & { type?: "expense" | "income" },
  idempotencyKey?: string,
) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  const { currency } = await hh(ctx, hid);
  if (input.currency !== currency) throw invalid(`This household records amounts in ${currency}`);
  return idempotent(ctx, { hid, uid: actor.uid, op: "record_expense" }, idempotencyKey, async () => {
    const { id } = await createDoc(ctx, hid, "transactions", actor, {
      type: input.type ?? "expense",
      amountMinor: input.amountMinor,
      currency: input.currency,
      category: input.category,
      description: input.description ?? null,
      paymentMethod: input.paymentMethod,
      occurredAt: Timestamp.fromDate(new Date(input.occurredAt)),
      locked: false,
      receiptPath: null,
    });
    await audit(ctx, hid, actor, "finance.transaction_recorded", { type: "transaction", id },
      { amountMinor: input.amountMinor, currency: input.currency, category: input.category });
    return { id };
  });
}

export async function listExpenses(
  ctx: Ctx, hid: string, actor: Actor, opts: { from: string; to: string; category?: string; limit?: number },
) {
  await requireCapability(ctx, hid, actor.uid, "finance.read");
  let q: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, "transactions"))
    .where("occurredAt", ">=", Timestamp.fromDate(new Date(opts.from)))
    .where("occurredAt", "<", Timestamp.fromDate(new Date(opts.to)));
  if (opts.category) q = q.where("category", "==", opts.category);
  const snap = await q.orderBy("occurredAt", "desc").limit(Math.min(opts.limit ?? 50, 200)).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, type: x.type, amountMinor: x.amountMinor, currency: x.currency, category: x.category,
      description: x.description, paymentMethod: x.paymentMethod, occurredAt: toIso(x.occurredAt),
    };
  });
}

export interface BudgetSummary {
  period: string;
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  overall: { limitMinor: number | null; spentMinor: number; remainingMinor: number | null; utilisationBps: number | null };
  categories: Array<{ category: string; limitMinor: number | null; spentMinor: number; remainingMinor: number | null; utilisationBps: number | null; status: "ok" | "near" | "over" | "untracked" }>;
  transactionCount: number;
}

/** Budget summary computed with integer arithmetic only. */
export async function getBudgetSummary(ctx: Ctx, hid: string, actor: Actor, period: string): Promise<BudgetSummary> {
  await requireCapability(ctx, hid, actor.uid, "finance.read");
  const { currency, timezone } = await hh(ctx, hid);
  const { start, end } = monthRange(period, timezone);
  const [txs, budgets] = await Promise.all([
    ctx.db.collection(paths.col(hid, "transactions"))
      .where("occurredAt", ">=", Timestamp.fromDate(start)).where("occurredAt", "<", Timestamp.fromDate(end)).get(),
    ctx.db.collection(paths.col(hid, "budgets")).where("period", "==", period).get(),
  ]);
  let income = 0;
  let expense = 0;
  const byCat = new Map<string, number>();
  for (const d of txs.docs) {
    const x = d.data();
    if (x.currency !== currency) continue; // foreign-currency records are reported separately, never mixed
    if (x.type === "income") income += x.amountMinor;
    else {
      expense += x.amountMinor;
      byCat.set(x.category, (byCat.get(x.category) ?? 0) + x.amountMinor);
    }
  }
  let overallLimit: number | null = null;
  const catLimits = new Map<string, number>();
  budgets.docs.forEach((b) => {
    const x = b.data();
    if (x.category == null || x.category === "*") overallLimit = x.limitMinor;
    else catLimits.set(x.category, x.limitMinor);
  });
  const status = (spent: number, limit: number | null) => {
    if (limit == null) return "untracked" as const;
    const bps = ratioBasisPoints(spent, limit);
    return bps > 10000 ? ("over" as const) : bps >= 8500 ? ("near" as const) : ("ok" as const);
  };
  const cats = new Set([...byCat.keys(), ...catLimits.keys()]);
  return {
    period,
    currency,
    incomeMinor: income,
    expenseMinor: expense,
    netMinor: income - expense,
    overall: {
      limitMinor: overallLimit,
      spentMinor: expense,
      remainingMinor: overallLimit == null ? null : overallLimit - expense,
      utilisationBps: overallLimit == null ? null : ratioBasisPoints(expense, overallLimit),
    },
    categories: [...cats].sort().map((c) => {
      const spent = byCat.get(c) ?? 0;
      const limit = catLimits.get(c) ?? null;
      return {
        category: c, limitMinor: limit, spentMinor: spent,
        remainingMinor: limit == null ? null : limit - spent,
        utilisationBps: limit == null ? null : ratioBasisPoints(spent, limit),
        status: status(spent, limit),
      };
    }),
    transactionCount: txs.size,
  };
}

// ---------------- bills ----------------

export type BillState = "upcoming" | "due_today" | "overdue" | "paid" | "needs_attention";

export function billState(bill: { nextDueAt: Date | null; lastPaidAt: Date | null; amountMinor: number }, now: Date, tz: string): BillState {
  if (!bill.nextDueAt) return "needs_attention";
  if (bill.amountMinor <= 0) return "needs_attention";
  const today = DateTime.fromJSDate(now).setZone(tz);
  const due = DateTime.fromJSDate(bill.nextDueAt).setZone(tz);
  if (due.hasSame(today, "day")) return "due_today";
  if (due < today.startOf("day")) return "overdue";
  return "upcoming";
}

export async function getBillStatus(ctx: Ctx, hid: string, actor: Actor, withinDays = 30) {
  await requireCapability(ctx, hid, actor.uid, "finance.read");
  const { timezone } = await hh(ctx, hid);
  const horizon = new Date(ctx.now().getTime() + withinDays * 86400_000);
  const snap = await ctx.db.collection(paths.col(hid, "bills"))
    .where("nextDueAt", "<=", Timestamp.fromDate(horizon)).orderBy("nextDueAt").limit(100).get();
  return snap.docs.filter((d) => d.data().active !== false).map((d) => {
    const x = d.data();
    return {
      id: d.id, name: x.name, provider: x.provider ?? null, category: x.category ?? null,
      amountMinor: x.amountMinor, currency: x.currency, nextDueAt: toIso(x.nextDueAt),
      state: billState({ nextDueAt: x.nextDueAt?.toDate() ?? null, lastPaidAt: x.lastPaidAt?.toDate() ?? null, amountMinor: x.amountMinor }, ctx.now(), timezone),
      recurring: !!x.recurrence,
    };
  });
}

/**
 * Record a bill payment the USER confirmed (or a verified provider callback).
 * Never invoked by the agent. Appends to billPayments, records the expense, and
 * advances the bill's next due date — atomically and idempotently.
 */
export async function recordBillPayment(
  ctx: Ctx, hid: string, actor: Actor, billId: string, input: z.infer<typeof BillPaymentInput>,
) {
  if (actor.kind !== "user") throw invalid("Payments can only be recorded by a person");
  await requireCapability(ctx, hid, actor.uid, "bills.pay.record");
  const { timezone, currency } = await hh(ctx, hid);
  if (input.currency !== currency) throw invalid(`This household records amounts in ${currency}`);
  return idempotent(ctx, { hid, uid: actor.uid, op: `bill_payment:${billId}` }, input.idempotencyKey, async () => {
    const billRef = ctx.db.doc(`${paths.col(hid, "bills")}/${billId}`);
    const payRef = ctx.db.collection(paths.col(hid, "billPayments")).doc();
    const txRef = ctx.db.collection(paths.col(hid, "transactions")).doc();
    const result = await ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(billRef);
      if (!snap.exists) throw notFound("Bill");
      const bill = snap.data()!;
      // Pay-per-delivery bills close the month that was paid and open the next one.
      const cycle = bill.kind === "metered" ? await closeCycleInTransaction(ctx, tx, hid, billId, bill, timezone, input.amountMinor, payRef.id) : null;
      let nextDue: string | null = cycle ? cycle.nextDueAt.toDate().toISOString() : null;
      if (!cycle && bill.recurrence && bill.nextDueAt) {
        nextDue = nextOccurrence(bill.recurrence as RecurrenceRule,
          (bill.seriesStartAt ?? bill.nextDueAt).toDate().toISOString(), timezone, bill.nextDueAt.toDate().toISOString());
      }
      const now = ts(ctx.now());
      tx.set(payRef, {
        householdId: hid, billId, billName: bill.name, amountMinor: input.amountMinor, currency: input.currency,
        paidAt: Timestamp.fromDate(new Date(input.paidAt)), method: input.method, reference: input.reference ?? null,
        dueAt: bill.nextDueAt ?? null, confirmedBy: actor.uid, transactionId: txRef.id, createdAt: now,
      });
      tx.set(txRef, {
        householdId: hid, type: "expense", amountMinor: input.amountMinor, currency: input.currency,
        category: bill.category ?? "Bills", description: `Bill: ${bill.name}`, paymentMethod: input.method,
        occurredAt: Timestamp.fromDate(new Date(input.paidAt)), billPaymentId: payRef.id, locked: true,
        createdBy: actor.uid, createdAt: now, updatedBy: actor.uid, updatedAt: now, version: 1, source: "user",
      });
      tx.update(billRef, {
        ...(cycle ? { meter: cycle.meter, amountMinor: cycle.amountMinor } : {}),
        lastPaidAt: Timestamp.fromDate(new Date(input.paidAt)),
        lastPaymentId: payRef.id,
        nextDueAt: nextDue ? Timestamp.fromDate(new Date(nextDue)) : bill.nextDueAt,
        status: nextDue ? "upcoming" : "paid",
        seriesStartAt: bill.seriesStartAt ?? bill.nextDueAt ?? null,
        version: (bill.version ?? 0) + 1, updatedAt: now, updatedBy: actor.uid,
      });
      return { paymentId: payRef.id, transactionId: txRef.id, nextDueAt: nextDue };
    });
    await audit(ctx, hid, actor, "bills.payment_recorded", { type: "bill", id: billId }, { amountMinor: input.amountMinor });
    return result;
  });
}

/** Every active bill (not just those due soon), so people and the assistant can find a bill by name. */
export async function listBills(ctx: Ctx, hid: string, actor: Actor) {
  await requireCapability(ctx, hid, actor.uid, "finance.read");
  const snap = await ctx.db.collection(paths.col(hid, "bills")).limit(200).get();
  return snap.docs.filter((d) => d.data().active !== false).map((d) => {
    const x = d.data();
    return {
      id: d.id, name: x.name, vendor: x.provider ?? null, category: x.category ?? null, amountMinor: x.amountMinor, currency: x.currency, nextDueAt: toIso(x.nextDueAt),
      kind: x.kind ?? "fixed",
      ...(x.kind === "metered" && x.meter ? { meter: { unit: x.meter.unit, rateMinor: x.meter.rateMinor, defaultQuantity: x.meter.defaultQuantity, weekdays: x.meter.weekdays, dueDay: x.meter.dueDay, monthBeingCollected: x.meter.cycleMonth } } : {}),
    };
  });
}

/** A bill with a fixed amount (rent, a househelp's monthly pay, insurance, subscriptions). Not charged per delivery. */
export const FixedBillInput = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().max(120).optional(),
  amountMinor: z.number().int().min(1).max(100_000_000_00),
  /** Next due date, YYYY-MM-DD in the household's time zone. */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  repeat: z.enum(["monthly", "yearly", "none"]).default("monthly"),
  category: z.string().trim().min(1).max(60).default("Utilities"),
  reminderDaysBefore: z.number().int().min(0).max(30).default(3),
  idempotencyKey: z.string().max(128).optional(),
});

export async function createFixedBill(ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof FixedBillInput>) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  const { currency, timezone } = await hh(ctx, hid);
  const due = DateTime.fromISO(input.dueDate, { zone: timezone }).set({ hour: 10 });
  if (!due.isValid) throw invalid("dueDate must be YYYY-MM-DD");
  return idempotent(ctx, { hid, uid: actor.uid, op: "create_bill" }, input.idempotencyKey, async () => {
    const at = Timestamp.fromDate(due.toJSDate());
    const { id } = await createDoc(ctx, hid, "bills", actor, {
      name: input.name, provider: input.provider ?? null, category: input.category, amountMinor: input.amountMinor, currency,
      nextDueAt: at, seriesStartAt: at, recurrence: input.repeat === "none" ? null : { freq: input.repeat },
      reminderDaysBefore: input.reminderDaysBefore, active: true, status: "upcoming",
    });
    await audit(ctx, hid, actor, "bills.created", { type: "bill", id }, { amountMinor: input.amountMinor, repeat: input.repeat });
    return { id, amountMinor: input.amountMinor, currency, nextDueAt: due.toUTC().toISO() };
  });
}
