/**
 * Vendor bills that depend on what was delivered (milk per liter, newspapers per copy, a maid per day…).
 *
 * A "metered" bill carries its terms in `meter` (unit, rate, normal quantity, delivery weekdays, due day, and the
 * `cycleMonth` currently being collected). Each month has a ledger document `billLedgers/{billId}_{YYYY-MM}` that
 * stores only the exceptions — a date and the quantity that actually applied (0 = vendor didn't come). The bill's
 * `amountMinor` always mirrors the open month's total so every existing screen, reminder and briefing shows the
 * right amount. Paying the bill closes the month and opens the next.
 *
 * All arithmetic is deterministic and in integer minor units (core/vendorBill.ts); no model is involved.
 */
import { DateTime } from "luxon";
import { Timestamp } from "firebase-admin/firestore";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  addMonths, ALL_DAYS, buildLedger, dueDateFor, LedgerTotals, MeterTerms, normalizeException, validateTerms, validMonth,
} from "../core/vendorBill";
import { Actor, audit, Ctx, idempotent, invalid, notFound, paths, requireCapability, ts } from "./base";
import { createDoc, toIso } from "./docs";

type Meter = MeterTerms & { dueDay: number; cycleMonth: string };

async function household(ctx: Ctx, hid: string) {
  const snap = await ctx.db.doc(paths.household(hid)).get();
  if (!snap.exists) throw notFound("Household");
  return snap.data()! as { currency: string; timezone: string };
}

const ledgerRef = (ctx: Ctx, hid: string, billId: string, month: string) => ctx.db.doc(`${paths.col(hid, "billLedgers")}/${billId}_${month}`);
const todayIn = (ctx: Ctx, tz: string) => DateTime.fromJSDate(ctx.now()).setZone(tz).toISODate()!;

function meterOf(bill: FirebaseFirestore.DocumentData): Meter {
  if (bill.kind !== "metered" || !bill.meter) throw invalid("This bill is a fixed amount, not a pay-per-delivery bill");
  return bill.meter as Meter;
}

/**
 * Finds a bill however the caller (a person or the assistant) refers to it: by id, by (part of) its name or vendor,
 * or — when there is only one pay-per-delivery bill — by nothing at all. Throws with the candidates when ambiguous.
 */
export async function resolveBill(ctx: Ctx, hid: string, ref: { billId?: string; name?: string }, onlyMetered = true) {
  const byId = async (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const snap = await ctx.db.doc(`${paths.col(hid, "bills")}/${id}`).get();
    return snap.exists ? { id: snap.id, data: snap.data()! } : null;
  };
  if (ref.billId) {
    const hit = await byId(ref.billId.trim());
    if (!hit) throw notFound("Bill");
    return hit;
  }
  const q = (ref.name ?? "").trim();
  if (q) { const hit = await byId(q); if (hit && (!onlyMetered || hit.data.kind === "metered")) return hit; }  // an id passed as a name
  const all = (await ctx.db.collection(paths.col(hid, "bills")).limit(300).get()).docs
    .filter((d) => d.data().active !== false && (!onlyMetered || d.data().kind === "metered"));
  const label = (d: FirebaseFirestore.QueryDocumentSnapshot) => `${d.data().name} (id ${d.id})`;
  if (!q) {
    if (all.length === 1) return { id: all[0].id, data: all[0].data() };
    if (all.length === 0) throw notFound("A pay-per-delivery bill — create one with create_vendor_bill first. Bill");
    throw invalid(`Which bill? ${all.map(label).join(", ")}. Pass its name or id as "bill".`);
  }
  const ql = q.toLowerCase();
  const words = ql.split(/\s+/).filter((w) => w.length > 1);
  const text = (d: FirebaseFirestore.QueryDocumentSnapshot) => `${d.data().name} ${d.data().provider ?? ""}`.toLowerCase();
  const exact = all.filter((d) => String(d.data().name).toLowerCase() === ql || String(d.data().provider ?? "").toLowerCase() === ql);
  const hits = exact.length ? exact : all.filter((d) => text(d).includes(ql) || (words.length > 0 && words.every((w) => text(d).includes(w))));
  if (hits.length === 0) throw notFound(`Bill "${q}". Your pay-per-delivery bills: ${all.map(label).join(", ") || "none"}. Bill`);
  if (hits.length > 1) throw invalid(`More than one bill matches "${q}": ${hits.map(label).join(", ")}. Pass the exact name or id as "bill".`);
  return { id: hits[0].id, data: hits[0].data() };
}

// ---------------------------------------------------------------- create / update

export const CreateVendorBillInput = z.object({
  name: z.string().trim().min(1).max(120),
  vendor: z.string().trim().max(120).optional(),
  unit: z.string().trim().min(1).max(20).default("l"),
  rateMinor: z.number().int().min(1).max(100_000_000),
  defaultQuantity: z.number().min(0).max(1000).default(1),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default(ALL_DAYS),
  dueDay: z.number().int().min(1).max(28).default(5),
  category: z.string().trim().min(1).max(60).default("Groceries"),
  /** First month being collected (YYYY-MM). Defaults to the current month. */
  startMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  idempotencyKey: z.string().max(128).optional(),
});

export async function createVendorBill(ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof CreateVendorBillInput>) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  const { currency, timezone } = await household(ctx, hid);
  const terms = { unit: input.unit, rateMinor: input.rateMinor, defaultQuantity: input.defaultQuantity, weekdays: [...new Set(input.weekdays)].sort(), dueDay: input.dueDay };
  const problem = validateTerms(terms);
  if (problem) throw invalid(problem);
  const cycleMonth = input.startMonth ?? DateTime.fromJSDate(ctx.now()).setZone(timezone).toFormat("yyyy-MM");
  if (!validMonth(cycleMonth)) throw invalid("startMonth must be YYYY-MM");
  return idempotent(ctx, { hid, uid: actor.uid, op: "create_vendor_bill" }, input.idempotencyKey, async () => {
    const meter: Meter = { ...terms, cycleMonth };
    const { totals } = buildLedger(cycleMonth, meter, {}, todayIn(ctx, timezone));
    const due = dueDateFor(cycleMonth, input.dueDay, timezone);
    const { id } = await createDoc(ctx, hid, "bills", actor, {
      name: input.name, provider: input.vendor ?? null, category: input.category, kind: "metered", meter,
      amountMinor: totals.totalMinor, currency, nextDueAt: Timestamp.fromDate(due), seriesStartAt: Timestamp.fromDate(due),
      recurrence: null, reminderDaysBefore: 3, active: true, status: "upcoming",
    });
    await audit(ctx, hid, actor, "bills.vendor_bill_created", { type: "bill", id }, { unit: input.unit, rateMinor: input.rateMinor });
    return { id, cycleMonth, projectedMinor: totals.totalMinor, nextDueAt: due.toISOString() };
  });
}

export const UpdateVendorBillInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  vendor: z.string().trim().max(120).nullable().optional(),
  rateMinor: z.number().int().min(1).max(100_000_000).optional(),
  defaultQuantity: z.number().min(0).max(1000).optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  dueDay: z.number().int().min(1).max(28).optional(),
  /** Also re-price/re-schedule the month being collected. Off by default: new prices usually start next month. */
  applyToCurrentMonth: z.boolean().default(false),
});

export async function updateVendorBill(ctx: Ctx, hid: string, actor: Actor, billId: string, input: z.infer<typeof UpdateVendorBillInput>) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  const { timezone } = await household(ctx, hid);
  const billRef = ctx.db.doc(`${paths.col(hid, "bills")}/${billId}`);
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(billRef);
    if (!snap.exists) throw notFound("Bill");
    const bill = snap.data()!;
    const old = meterOf(bill);
    const meter = { ...old };
    if (input.rateMinor !== undefined) meter.rateMinor = input.rateMinor;
    if (input.defaultQuantity !== undefined) meter.defaultQuantity = input.defaultQuantity;
    if (input.weekdays !== undefined) meter.weekdays = [...new Set(input.weekdays)].sort();
    if (input.dueDay !== undefined) meter.dueDay = input.dueDay;
    const problem = validateTerms(meter);
    if (problem) throw invalid(problem);
    // The month being collected keeps the terms it started with unless the caller asks to re-price it too.
    const lref = ledgerRef(ctx, hid, billId, meter.cycleMonth);
    const lsnap = await tx.get(lref);
    let ledger: FirebaseFirestore.DocumentData | null = lsnap.exists ? lsnap.data()! : null;
    if (input.applyToCurrentMonth) {
      if (ledger) { ledger = { ...ledger, rateMinor: meter.rateMinor, defaultQuantity: meter.defaultQuantity, weekdays: meter.weekdays }; tx.set(lref, ledger); }
    } else if (!ledger) {
      ledger = { householdId: hid, billId, month: meter.cycleMonth, rateMinor: old.rateMinor, defaultQuantity: old.defaultQuantity, weekdays: old.weekdays, exceptions: {} };
      tx.set(lref, ledger);
    }
    const terms: MeterTerms = ledger ? { unit: meter.unit, rateMinor: ledger.rateMinor, defaultQuantity: ledger.defaultQuantity, weekdays: ledger.weekdays } : meter;
    const { totals } = buildLedger(meter.cycleMonth, terms, ledger?.exceptions ?? {}, todayIn(ctx, timezone));
    tx.update(billRef, {
      meter, ...(input.name ? { name: input.name } : {}), ...(input.vendor !== undefined ? { provider: input.vendor } : {}),
      amountMinor: totals.totalMinor, nextDueAt: Timestamp.fromDate(dueDateFor(meter.cycleMonth, meter.dueDay, timezone)),
      version: (bill.version ?? 0) + 1, updatedAt: ts(ctx.now()), updatedBy: actor.uid,
    });
    return { id: billId, projectedMinor: totals.totalMinor };
  }).then(async (r) => { await audit(ctx, hid, actor, "bills.vendor_bill_updated", { type: "bill", id: billId }, {}); return r; });
}

// ---------------------------------------------------------------- ledger

export interface LedgerView {
  bill: { id: string; name: string; vendor: string | null; unit: string; rateMinor: number; defaultQuantity: number; weekdays: number[]; dueDay: number; currency: string };
  month: string;
  openMonth: string;
  paid: boolean;
  editable: boolean;
  dueAt: string | null;
  days: ReturnType<typeof buildLedger>["days"];
  totals: LedgerTotals;
}

/** The month's ledger: every day with what was delivered, plus the totals. Defaults to the month being collected. */
export async function getBillLedger(ctx: Ctx, hid: string, actor: Actor, billId: string, month?: string): Promise<LedgerView> {
  await requireCapability(ctx, hid, actor.uid, "finance.read");
  const { currency, timezone } = await household(ctx, hid);
  const snap = await ctx.db.doc(`${paths.col(hid, "bills")}/${billId}`).get();
  if (!snap.exists) throw notFound("Bill");
  const bill = snap.data()!;
  const meter = meterOf(bill);
  const m = month ?? meter.cycleMonth;
  if (!validMonth(m)) throw invalid("month must be YYYY-MM");
  const l = (await ledgerRef(ctx, hid, billId, m).get()).data();
  const terms: MeterTerms = l ? { unit: meter.unit, rateMinor: l.rateMinor, defaultQuantity: l.defaultQuantity, weekdays: l.weekdays } : meter;
  const { days, totals } = buildLedger(m, terms, l?.exceptions ?? {}, todayIn(ctx, timezone));
  const paid = !!l?.paidAt || m < meter.cycleMonth;
  return {
    bill: { id: snap.id, name: bill.name, vendor: bill.provider ?? null, unit: meter.unit, rateMinor: terms.rateMinor, defaultQuantity: terms.defaultQuantity, weekdays: terms.weekdays, dueDay: meter.dueDay, currency },
    month: m, openMonth: meter.cycleMonth, paid, editable: !paid && m <= addMonths(meter.cycleMonth, 2),
    dueAt: m === meter.cycleMonth ? toIso(bill.nextDueAt) : null, days, totals,
  };
}

export const DeliveryEntry = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Quantity that applied that day; 0 = not delivered; null = back to the normal schedule. */
  quantity: z.number().min(0).max(1000).nullable(),
});

/** Marks days as delivered, skipped or a different quantity. Idempotent per date. */
export async function setDeliveries(ctx: Ctx, hid: string, actor: Actor, billId: string, entries: Array<z.infer<typeof DeliveryEntry>>) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  if (entries.length === 0 || entries.length > 62) throw invalid("Send between 1 and 62 days at a time");
  const { timezone } = await household(ctx, hid);
  const billRef = ctx.db.doc(`${paths.col(hid, "bills")}/${billId}`);
  const result = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(billRef);
    if (!snap.exists) throw notFound("Bill");
    const bill = snap.data()!;
    const meter = meterOf(bill);
    const byMonth = new Map<string, typeof entries>();
    for (const e of entries) {
      if (DateTime.fromISO(e.date, { zone: "utc" }).isValid !== true) throw invalid(`Not a date: ${e.date}`);
      const m = e.date.slice(0, 7);
      if (m < meter.cycleMonth) throw invalid(`${m} is already paid and closed`);
      if (m > addMonths(meter.cycleMonth, 2)) throw invalid("Deliveries can only be set up to two months ahead");
      byMonth.set(m, [...(byMonth.get(m) ?? []), e]);
    }
    const loaded = await Promise.all([...byMonth.keys()].map(async (m) => ({ m, ref: ledgerRef(ctx, hid, billId, m), snap: await tx.get(ledgerRef(ctx, hid, billId, m)) })));
    const out: Array<{ month: string; totalMinor: number; skippedDays: number; deliveredDays: number }> = [];
    let openTotal: number | null = null;
    for (const { m, ref, snap: ls } of loaded) {
      const base = ls.exists ? ls.data()! : { householdId: hid, billId, month: m, rateMinor: meter.rateMinor, defaultQuantity: meter.defaultQuantity, weekdays: meter.weekdays, exceptions: {} as Record<string, number> };
      if (base.paidAt) throw invalid(`${m} is already paid and closed`);
      const exceptions: Record<string, number> = { ...(base.exceptions ?? {}) };
      for (const e of byMonth.get(m)!) {
        const n = normalizeException({ unit: meter.unit, rateMinor: base.rateMinor, defaultQuantity: base.defaultQuantity, weekdays: base.weekdays }, e.date, e.quantity);
        if (n === null) delete exceptions[e.date]; else exceptions[e.date] = n;
      }
      tx.set(ref, { ...base, exceptions, updatedAt: ts(ctx.now()), updatedBy: actor.uid });
      const { totals } = buildLedger(m, { unit: meter.unit, rateMinor: base.rateMinor, defaultQuantity: base.defaultQuantity, weekdays: base.weekdays }, exceptions, todayIn(ctx, timezone));
      out.push({ month: m, totalMinor: totals.totalMinor, skippedDays: totals.skippedDays, deliveredDays: totals.deliveredDays });
      if (m === meter.cycleMonth) openTotal = totals.totalMinor;
    }
    if (openTotal !== null) tx.update(billRef, { amountMinor: openTotal, version: (bill.version ?? 0) + 1, updatedAt: ts(ctx.now()), updatedBy: actor.uid });
    return out;
  });
  await audit(ctx, hid, actor, "bills.deliveries_recorded", { type: "bill", id: billId }, { days: entries.length });
  return { billId, months: result };
}

// ---------------------------------------------------------------- payment hook

/**
 * Called inside the payment transaction (finance.recordBillPayment). Closes the month that was paid, opens the
 * next one and returns the bill fields to write. The amount paid is whatever the person confirmed.
 */
export async function closeCycleInTransaction(
  ctx: Ctx, tx: FirebaseFirestore.Transaction, hid: string, billId: string, bill: FirebaseFirestore.DocumentData, timezone: string, paidAmountMinor: number, paymentId: string,
) {
  const meter = meterOf(bill);
  const lref = ledgerRef(ctx, hid, billId, meter.cycleMonth);
  const next = addMonths(meter.cycleMonth, 1);
  // Firestore transactions need every read before the first write.
  const [ls, nsnap] = await Promise.all([tx.get(lref), tx.get(ledgerRef(ctx, hid, billId, next))]);
  const closing = ls.exists ? ls.data()! : { householdId: hid, billId, month: meter.cycleMonth, rateMinor: meter.rateMinor, defaultQuantity: meter.defaultQuantity, weekdays: meter.weekdays, exceptions: {} };
  tx.set(lref, { ...closing, paidAt: ts(ctx.now()), paidAmountMinor, paymentId });
  const nextTerms: MeterTerms = nsnap.exists ? { unit: meter.unit, ...(nsnap.data() as { rateMinor: number; defaultQuantity: number; weekdays: number[] }) } : meter;
  const { totals } = buildLedger(next, nextTerms, nsnap.data()?.exceptions ?? {}, todayIn(ctx, timezone));
  return {
    meter: { ...meter, cycleMonth: next }, amountMinor: totals.totalMinor,
    nextDueAt: Timestamp.fromDate(dueDateFor(next, meter.dueDay, timezone)),
  };
}

// ---------------------------------------------------------------- routes (the apps)

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function mountVendorBillRoutes(app: Express, ctx: Ctx, wrap: Wrap) {
  const actor = (req: Request): Actor => ({ uid: req.user!.uid, kind: "user" });
  const p = (req: Request, k: string) => { const v = String(req.params[k] ?? ""); if (!ID.test(v)) throw invalid(`Invalid ${k}`); return v; };
  const parse = <T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> => {
    const r = schema.safeParse(v ?? {});
    if (!r.success) throw invalid("Invalid request", r.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })));
    return r.data;
  };
  app.post("/v1/households/:hid/vendor-bills", wrap(async (req, res) => { res.status(201).json(await createVendorBill(ctx, p(req, "hid"), actor(req), parse(CreateVendorBillInput, req.body))); }));
  app.patch("/v1/households/:hid/vendor-bills/:bid", wrap(async (req, res) => { res.json(await updateVendorBill(ctx, p(req, "hid"), actor(req), p(req, "bid"), parse(UpdateVendorBillInput, req.body))); }));
  app.get("/v1/households/:hid/vendor-bills/:bid/ledger", wrap(async (req, res) => {
    res.json(await getBillLedger(ctx, p(req, "hid"), actor(req), p(req, "bid"), typeof req.query.month === "string" ? req.query.month : undefined));
  }));
  app.put("/v1/households/:hid/vendor-bills/:bid/deliveries", wrap(async (req, res) => {
    const { entries } = parse(z.object({ entries: z.array(DeliveryEntry).min(1).max(62) }), req.body);
    res.json(await setDeliveries(ctx, p(req, "hid"), actor(req), p(req, "bid"), entries));
  }));
}
