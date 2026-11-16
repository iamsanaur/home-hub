import { DateTime } from "luxon";
import { Timestamp } from "firebase-admin/firestore";
import { can } from "../core/roles";
import { format, money } from "../core/money";
import { Actor, Ctx, invalid, notFound, paths, requireCapability, requireMember } from "./base";
import { toIso } from "./docs";
import { billState, getBudgetSummary } from "./finance";

async function hh(ctx: Ctx, hid: string) {
  const s = await ctx.db.doc(paths.household(hid)).get();
  if (!s.exists) throw notFound("Household");
  return s.data()!;
}

/**
 * Deterministic daily briefing — no LLM call. Each section is a factual query; the
 * text is template-generated. An AI-written briefing is only requested when the
 * user explicitly asks the agent.
 */
export async function computeBriefing(ctx: Ctx, hid: string, actor: Actor) {
  const m = await requireMember(ctx, hid, actor.uid);
  const h = await hh(ctx, hid);
  const tz = h.timezone ?? "UTC";
  const now = DateTime.fromJSDate(ctx.now()).setZone(tz);
  const endToday = Timestamp.fromDate(now.endOf("day").toJSDate());
  const nowTs = Timestamp.fromDate(now.toJSDate());

  let tq: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, "tasks")).where("status", "in", ["open", "in_progress"]);
  if (!can(m, "tasks.read.all")) tq = tq.where("assigneeUid", "==", actor.uid);
  const tasks = (await tq.where("dueAt", "<=", endToday).limit(100).get()).docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, any>);
  const overdue = tasks.filter((t) => t.dueAt && t.dueAt.toDate() < nowTs.toDate());
  const dueToday = tasks.filter((t) => !overdue.includes(t));

  const bills = can(m, "finance.read")
    ? (await ctx.db.collection(paths.col(hid, "bills"))
      .where("nextDueAt", "<=", Timestamp.fromDate(now.plus({ days: 3 }).endOf("day").toJSDate())).limit(50).get()).docs
      .map((d) => ({ id: d.id, ...d.data() }) as Record<string, any>)
      .filter((b) => b.active !== false)
    : [];

  let eq: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, "events"));
  if (m.role === "child") eq = eq.where("visibility", "==", "household");
  if (m.role === "staff") eq = eq.where("staffVisible", "==", true);
  const events = (await eq.where("startAt", ">=", Timestamp.fromDate(now.startOf("day").toJSDate()))
    .where("startAt", "<=", endToday).orderBy("startAt").limit(20).get()).docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, any>);

  const lowStock = (await ctx.db.collection(paths.col(hid, "pantryItems")).where("lowStock", "==", true).limit(20).get()).docs
    .map((d) => d.data().name as string);

  const maintenance = can(m, "maintenance.write")
    ? (await ctx.db.collection(paths.col(hid, "assets"))
      .where("nextServiceAt", "<=", Timestamp.fromDate(now.plus({ days: 7 }).toJSDate())).limit(10).get()).docs
      .map((d) => ({ id: d.id, name: d.data().name, nextServiceAt: toIso(d.data().nextServiceAt) }))
    : [];

  const lines: string[] = [];
  if (overdue.length) lines.push(`${overdue.length} overdue task${overdue.length > 1 ? "s" : ""}`);
  if (dueToday.length) lines.push(`${dueToday.length} task${dueToday.length > 1 ? "s" : ""} due today`);
  if (bills.length) lines.push(`${bills.length} bill${bills.length > 1 ? "s" : ""} due within 3 days`);
  if (events.length) lines.push(`${events.length} event${events.length > 1 ? "s" : ""} today`);
  if (lowStock.length) lines.push(`${lowStock.length} item${lowStock.length > 1 ? "s" : ""} running low`);
  if (maintenance.length) lines.push(`${maintenance.length} service reminder${maintenance.length > 1 ? "s" : ""} this week`);

  const nextAction = overdue[0]
    ? { kind: "task", id: overdue[0].id, label: `Overdue: ${overdue[0].title}` }
    : bills.find((b) => billState({ nextDueAt: b.nextDueAt?.toDate() ?? null, lastPaidAt: null, amountMinor: b.amountMinor }, ctx.now(), tz) !== "upcoming")
      ? { kind: "bill", id: bills[0].id, label: `Bill due: ${bills[0].name}` }
      : dueToday[0] ? { kind: "task", id: dueToday[0].id, label: dueToday[0].title }
        : events[0] ? { kind: "event", id: events[0].id, label: events[0].title } : null;

  return {
    date: now.toISODate(),
    summary: lines.length ? lines.join(" · ") : "Nothing urgent today.",
    nextAction,
    overdueTasks: overdue.map((t) => ({ id: t.id, title: t.title, dueAt: toIso(t.dueAt), priority: t.priority })),
    dueToday: dueToday.map((t) => ({ id: t.id, title: t.title, dueAt: toIso(t.dueAt), priority: t.priority })),
    bills: bills.map((b) => ({
      id: b.id, name: b.name, amount: format(money(b.amountMinor, b.currency), h.locale ?? "en"), amountMinor: b.amountMinor,
      currency: b.currency, nextDueAt: toIso(b.nextDueAt),
      state: billState({ nextDueAt: b.nextDueAt?.toDate() ?? null, lastPaidAt: null, amountMinor: b.amountMinor }, ctx.now(), tz),
    })),
    events: events.map((e) => ({ id: e.id, title: e.title, startAt: toIso(e.startAt) })),
    lowStock,
    maintenance,
    generatedBy: "deterministic",
  };
}

export type ReportKind = "overview" | "expenditure" | "tasks" | "shopping" | "maintenance" | "wastage";

export async function getHouseholdReport(ctx: Ctx, hid: string, actor: Actor, kind: ReportKind, from: string, to: string) {
  const m = await requireCapability(ctx, hid, actor.uid, "reports.read");
  const f = Timestamp.fromDate(new Date(from));
  const t = Timestamp.fromDate(new Date(to));
  if (!(t.toMillis() > f.toMillis())) throw invalid("to must be after from");
  const h = await hh(ctx, hid);
  const out: Record<string, unknown> = { kind, from, to, currency: h.currency, basis: "historical records" };

  if (kind === "expenditure" || kind === "overview") {
    if (can(m, "finance.read")) {
      const txs = await ctx.db.collection(paths.col(hid, "transactions")).where("occurredAt", ">=", f).where("occurredAt", "<", t).get();
      let income = 0, expense = 0;
      const byCategory = new Map<string, number>();
      const byMonth = new Map<string, { income: number; expense: number }>();
      for (const d of txs.docs) {
        const x = d.data();
        if (x.currency !== h.currency) continue;
        const month = DateTime.fromJSDate(x.occurredAt.toDate()).setZone(h.timezone).toFormat("yyyy-MM");
        const mm = byMonth.get(month) ?? { income: 0, expense: 0 };
        if (x.type === "income") { income += x.amountMinor; mm.income += x.amountMinor; }
        else { expense += x.amountMinor; mm.expense += x.amountMinor; byCategory.set(x.category, (byCategory.get(x.category) ?? 0) + x.amountMinor); }
        byMonth.set(month, mm);
      }
      out.finance = {
        incomeMinor: income, expenseMinor: expense, netMinor: income - expense, transactionCount: txs.size,
        byCategory: [...byCategory].sort((a, b) => b[1] - a[1]).map(([category, amountMinor]) => ({ category, amountMinor })),
        byMonth: [...byMonth].sort().map(([month, v]) => ({ month, incomeMinor: v.income, expenseMinor: v.expense })),
      };
      const period = DateTime.fromJSDate(ctx.now()).setZone(h.timezone).toFormat("yyyy-MM");
      out.currentBudget = await getBudgetSummary(ctx, hid, actor, period);
    } else {
      out.finance = null;
    }
  }
  if (kind === "tasks" || kind === "overview") {
    const occ = await ctx.db.collection(paths.col(hid, "taskOccurrences")).where("completedAt", ">=", f).where("completedAt", "<", t).get();
    const onTime = occ.docs.filter((d) => d.data().onTime).length;
    const byMember = new Map<string, number>();
    occ.docs.forEach((d) => { const u = d.data().completedBy ?? "unknown"; byMember.set(u, (byMember.get(u) ?? 0) + 1); });
    const open = (await ctx.db.collection(paths.col(hid, "tasks")).where("status", "in", ["open", "in_progress"]).count().get()).data().count;
    out.tasks = { completed: occ.size, onTime, openNow: open, byMember: [...byMember].map(([uid, count]) => ({ uid, count })) };
  }
  if (kind === "shopping" || kind === "overview") {
    const items = await ctx.db.collection(paths.col(hid, "groceryItems")).where("purchased", "==", true).get();
    const inRange = items.docs.filter((d) => { const p = d.data().purchasedAt; return p && p.toMillis() >= f.toMillis() && p.toMillis() < t.toMillis(); });
    out.shopping = {
      itemsPurchased: inRange.length,
      spentMinor: inRange.reduce((a, d) => a + (d.data().actualPriceMinor ?? 0), 0),
      unpricedItems: inRange.filter((d) => d.data().actualPriceMinor == null).length,
    };
  }
  if (kind === "maintenance" || kind === "overview") {
    const recs = await ctx.db.collection(paths.col(hid, "maintenanceRecords")).where("createdAt", ">=", f).where("createdAt", "<", t).get();
    out.maintenance = {
      requests: recs.size,
      completed: recs.docs.filter((d) => d.data().status === "done").length,
      costMinor: recs.docs.reduce((a, d) => a + (d.data().costMinor ?? 0), 0),
    };
  }
  if (kind === "wastage" || kind === "overview") {
    const mv = await ctx.db.collection(paths.col(hid, "pantryMovements")).where("createdAt", ">=", f).where("createdAt", "<", t).get();
    const waste = mv.docs.filter((d) => d.data().kind === "waste");
    const byItem = new Map<string, number>();
    waste.forEach((d) => byItem.set(d.data().name, (byItem.get(d.data().name) ?? 0) + Math.abs(d.data().delta)));
    out.wastage = { events: waste.length, byItem: [...byItem].map(([name, quantity]) => ({ name, quantity })) };
  }
  return out;
}
