import { beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { clearFirestore, testCtx } from "./helpers";
import { Actor, AppError } from "../../src/services/base";
import { acceptInvitation, changeMemberRole, createHousehold, invite, removeMember, setAutonomy, updateDisplayName } from "../../src/services/households";
import { completeTask, createTask, handleTaskCompleted, listTasks } from "../../src/services/tasks";
import { createMealPlan, generateMealShoppingList, markItemPurchased } from "../../src/services/food";
import { getBudgetSummary, recordBillPayment, recordExpense } from "../../src/services/finance";
import { decideApproval, expireApprovals, requestApproval } from "../../src/services/approvals";
import { computeBriefing } from "../../src/services/reports";
import { runDueJobs } from "../../src/services/jobs";
import { checkScheduleConflicts, createEvent } from "../../src/services/home";
import { correctMemory, deleteMemory, exportUserData, listMemories, recall, remember } from "../../src/services/memory";

const ctx = testCtx();
const owner: Actor = { uid: "u_owner", kind: "user" };
const adult: Actor = { uid: "u_adult", kind: "user" };
const staff: Actor = { uid: "u_staff", kind: "user" };
let hid: string;

async function join(as: { uid: string; email: string }, role: "adult" | "staff" | "child" | "admin", email = as.email) {
  const inv = await invite(ctx, owner, hid, { role, email });
  return acceptInvitation(ctx, { uid: as.uid, email, emailVerified: true, displayName: as.uid }, inv.token);
}

beforeEach(async () => {
  await clearFirestore();
  hid = (await createHousehold(ctx, { uid: owner.uid, displayName: "Owner", email: "owner@example.com" }, { name: "Sharma Home", currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" })).householdId;
  await join({ uid: adult.uid, email: "adult@example.com" }, "adult");
  await join({ uid: staff.uid, email: "staff@example.com" }, "staff");
});

describe("households, invitations and roles", () => {
  it("renaming a person updates their profile and every household they belong to", async () => {
    // A second household where the owner is also a member.
    const other = (await createHousehold(ctx, { uid: "u_other", displayName: "Other", email: "other@example.com" }, { name: "Other Home", currency: "INR", timezone: "Asia/Kolkata", locale: "en" })).householdId;
    const inv = await invite(ctx, { uid: "u_other", kind: "user" }, other, { role: "adult", email: "owner@example.com" });
    await acceptInvitation(ctx, { uid: owner.uid, email: "owner@example.com", emailVerified: true, displayName: "owner@example.com" }, inv.token);
    const r = await updateDisplayName(ctx, owner.uid, "  Sanaur   Rahman ");
    expect(r).toEqual({ displayName: "Sanaur Rahman", households: 2 });
    for (const h of [hid, other]) expect((await ctx.db.doc(`households/${h}/members/${owner.uid}`).get()).data()!.displayName).toBe("Sanaur Rahman");
    expect((await ctx.db.doc(`users/${owner.uid}`).get()).data()!.displayName).toBe("Sanaur Rahman");
    // Other members are untouched, and bad names are refused.
    expect((await ctx.db.doc(`households/${hid}/members/${adult.uid}`).get()).data()!.displayName).not.toBe("Sanaur Rahman");
    await expect(updateDisplayName(ctx, owner.uid, "   ")).rejects.toThrow();
    await expect(updateDisplayName(ctx, owner.uid, "x".repeat(81))).rejects.toThrow();
    await expect(updateDisplayName(ctx, owner.uid, "<script>")).rejects.toThrow();
  });

  it("creates default deterministic scheduled jobs", async () => {
    const jobs = await ctx.db.collection(`households/${hid}/scheduledJobs`).get();
    expect(jobs.size).toBe(8);
    const meal = jobs.docs.find((d) => d.id === "weekly_meal_planning")!.data();
    expect(meal.requiresAgent).toBe(true);
    expect(meal.enabled).toBe(false);
  });
  it("invitations are single-use, email-bound and expire", async () => {
    const inv = await invite(ctx, owner, hid, { role: "adult", email: "new@example.com" });
    await expect(acceptInvitation(ctx, { uid: "u_x", email: "other@example.com", emailVerified: true }, inv.token)).rejects.toMatchObject({ code: "forbidden" });
    await acceptInvitation(ctx, { uid: "u_new", email: "new@example.com", emailVerified: true }, inv.token);
    await expect(acceptInvitation(ctx, { uid: "u_new2", email: "new@example.com", emailVerified: true }, inv.token)).rejects.toMatchObject({ status: 404 });
    const late = await invite(ctx, owner, hid, { role: "adult" });
    const future = { ...ctx, now: () => new Date(Date.now() + 8 * 86400_000) };
    await expect(acceptInvitation(future, { uid: "u_late" }, late.token)).rejects.toMatchObject({ code: "invitation_expired" });
  });
  it("prevents privilege escalation and protects the owner", async () => {
    await expect(invite(ctx, adult, hid, { role: "adult" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeMemberRole(ctx, adult, hid, staff.uid, { role: "admin" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeMember(ctx, owner, hid, owner.uid)).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeMemberRole(ctx, owner, hid, staff.uid, { permissions: { finance: true } })).rejects.toMatchObject({ code: "invalid_argument" });
    await changeMemberRole(ctx, owner, hid, adult.uid, { role: "admin" });
    expect((await ctx.db.doc(`households/${hid}/members/${adult.uid}`).get()).data()!.role).toBe("admin");
  });
  it("any adult can pause the agent, only managers can resume", async () => {
    const paused = await setAutonomy(ctx, adult, hid, { paused: true });
    expect(paused.paused).toBe(true);
    await expect(setAutonomy(ctx, adult, hid, { paused: false })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setAutonomy(ctx, staff, hid, { paused: true })).rejects.toMatchObject({ code: "forbidden" });
    expect((await setAutonomy(ctx, owner, hid, { paused: false })).paused).toBe(false);
  });
});

describe("tasks and recurrence", () => {
  it("completing a recurring task records history and spawns the next occurrence once", async () => {
    const { id } = await createTask(ctx, hid, owner, {
      title: "Water plants", priority: "normal", dueAt: "2026-11-16T03:30:00.000Z", recurrence: { freq: "weekly" }, assigneeUid: staff.uid,
    });
    const done = await completeTask(ctx, hid, staff, id);
    expect(done.nextOccurrenceId).toBe(`${id}_${Date.parse("2026-11-23T03:30:00.000Z")}`);
    const task = (await ctx.db.doc(`households/${hid}/tasks/${id}`).get()).data()!;
    await handleTaskCompleted(ctx, hid, id, task); // trigger re-delivery is a no-op
    const occ = await ctx.db.collection(`households/${hid}/taskOccurrences`).get();
    expect(occ.size).toBe(1);
    const all = await ctx.db.collection(`households/${hid}/tasks`).get();
    expect(all.size).toBe(2);
  });
  it("staff only see and complete their own tasks", async () => {
    const mine = await createTask(ctx, hid, owner, { title: "Mop", priority: "normal", assigneeUid: staff.uid });
    const other = await createTask(ctx, hid, owner, { title: "Pay fees", priority: "high" });
    const rows = await listTasks(ctx, hid, staff, "open");
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
    await expect(completeTask(ctx, hid, staff, other.id)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects assignment to non-members", async () => {
    await expect(createTask(ctx, hid, owner, { title: "x", priority: "low", assigneeUid: "stranger" })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("meals → shopping (deterministic)", () => {
  it("scales recipes, subtracts pantry stock and estimates only from known prices", async () => {
    const now = Timestamp.now();
    const meta = { householdId: hid, createdBy: owner.uid, createdAt: now, updatedAt: now, updatedBy: owner.uid, version: 1 };
    await ctx.db.doc(`households/${hid}/recipes/dal`).set({ ...meta, name: "Dal", servings: 4, ingredients: [
      { name: "Toor dal", quantity: 250, unit: "g", estimatedPriceMinor: 4000, priceUnitQuantity: 250 },
      { name: "Onion", quantity: 2, unit: "pcs" },
      { name: "Ghee", quantity: 2, unit: "tbsp" },
    ] });
    await ctx.db.doc(`households/${hid}/pantryItems/onion`).set({ ...meta, name: "Onion", nameKey: "onion", quantity: 10, unit: "pcs", minQuantity: 3 });
    await createMealPlan(ctx, hid, owner, { weekStart: "2026-11-16", entries: [
      { date: "2026-11-16", slot: "dinner", recipeId: "dal", title: "Dal", servings: 4 },
      { date: "2026-11-18", slot: "dinner", recipeId: "dal", title: "Dal", servings: 8 },
    ] });
    const r = await generateMealShoppingList(ctx, hid, owner, "2026-11-16");
    // Toor dal: 250g + 500g = 750g → 3 × ₹40.00 = ₹120.00 (12000 paise). Onions: 6 needed, 10 in pantry → none.
    const dal = r.items.find((i) => i.name === "Toor dal")!;
    expect(dal).toMatchObject({ quantity: 750, unit: "g", estimatedPriceMinor: 12000 });
    expect(r.items.find((i) => i.name === "Onion")).toBeUndefined();
    expect(r.coveredByPantry).toBe(1);
    expect(r.estimate).toMatchObject({ totalMinor: 12000, currency: "INR", unpricedItems: 1 }); // ghee unpriced
    // Buying restocks the pantry through the movement ledger.
    await ctx.db.doc(`households/${hid}/pantryItems/dal`).set({ ...meta, name: "Toor dal", nameKey: "toor dal", quantity: 0, unit: "g", minQuantity: 200 });
    await markItemPurchased(ctx, hid, staff, dal.id, 11800);
    expect((await ctx.db.doc(`households/${hid}/pantryItems/dal`).get()).data()!.quantity).toBe(750);
  });
});

describe("finance", () => {
  it("summarises budgets with exact integer arithmetic", async () => {
    const now = Timestamp.now();
    await ctx.db.doc(`households/${hid}/budgets/b1`).set({ householdId: hid, period: "2026-11", category: "Groceries", limitMinor: 1000000, currency: "INR" });
    await ctx.db.doc(`households/${hid}/budgets/b0`).set({ householdId: hid, period: "2026-11", category: "*", limitMinor: 5000000, currency: "INR" });
    for (const amt of [10, 20, 899970]) await recordExpense(ctx, hid, adult, { amountMinor: amt, currency: "INR", category: "Groceries", paymentMethod: "upi", occurredAt: "2026-11-10T10:00:00+05:30" });
    await recordExpense(ctx, hid, adult, { type: "income", amountMinor: 9000000, currency: "INR", category: "Salary", paymentMethod: "bank_transfer", occurredAt: "2026-11-01T10:00:00+05:30" });
    const s = await getBudgetSummary(ctx, hid, adult, "2026-11");
    expect(s.expenseMinor).toBe(900000);
    expect(s.incomeMinor).toBe(9000000);
    expect(s.netMinor).toBe(8100000);
    expect(s.categories.find((c) => c.category === "Groceries")).toMatchObject({ spentMinor: 900000, remainingMinor: 100000, utilisationBps: 9000, status: "near" });
    expect(s.overall.utilisationBps).toBe(1800);
    void now;
    await expect(getBudgetSummary(ctx, hid, staff, "2026-11")).rejects.toMatchObject({ code: "forbidden" });
    await expect(recordExpense(ctx, hid, adult, { amountMinor: 100, currency: "USD", category: "x", paymentMethod: "cash", occurredAt: "2026-11-10T10:00:00Z" })).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it("records bill payments once, keeps history and advances the due date", async () => {
    const now = Timestamp.now();
    await ctx.db.doc(`households/${hid}/bills/elec`).set({ householdId: hid, name: "Electricity", category: "Utilities", amountMinor: 245000, currency: "INR",
      nextDueAt: Timestamp.fromDate(new Date("2026-11-20T04:30:00Z")), recurrence: { freq: "monthly" }, version: 1, createdAt: now });
    const input = { amountMinor: 245000, currency: "INR", paidAt: "2026-11-18T10:00:00+05:30", method: "upi" as const, idempotencyKey: "pay-elec-nov-2026" };
    const first = await recordBillPayment(ctx, hid, adult, "elec", input);
    const again = await recordBillPayment(ctx, hid, adult, "elec", input);
    expect(again.paymentId).toBe(first.paymentId);
    expect(again.replayed).toBe(true);
    expect((await ctx.db.collection(`households/${hid}/billPayments`).get()).size).toBe(1);
    expect(first.nextDueAt).toBe("2026-12-20T04:30:00.000Z");
    const tx = (await ctx.db.doc(`households/${hid}/transactions/${first.transactionId}`).get()).data()!;
    expect(tx).toMatchObject({ amountMinor: 245000, locked: true });
    await expect(recordBillPayment(ctx, hid, { uid: adult.uid, kind: "agent" }, "elec", { ...input, idempotencyKey: "agent-try-123" })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("approvals", () => {
  it("executes exactly the approved parameters, once, and only by a person", async () => {
    const agent: Actor = { uid: adult.uid, kind: "agent", agentId: "homehub-hermes", workflowId: "wf1" };
    const ap = await requestApproval(ctx, hid, agent, {
      action: "record_expense", title: "Record plumber payment", rationale: "Receipt uploaded",
      params: { amountMinor: 80000, currency: "INR", category: "Repairs", paymentMethod: "cash", occurredAt: "2026-11-15T12:00:00+05:30" },
      estimatedCostMinor: 80000, currency: "INR",
    });
    expect((await ctx.db.collection(`households/${hid}/transactions`).get()).size).toBe(0);
    await expect(decideApproval(ctx, hid, agent, ap.approvalId, "approve")).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideApproval(ctx, hid, staff, ap.approvalId, "approve")).rejects.toMatchObject({ code: "forbidden" });
    const res = await decideApproval(ctx, hid, owner, ap.approvalId, "approve");
    expect(res.status).toBe("executed");
    const txs = await ctx.db.collection(`households/${hid}/transactions`).get();
    expect(txs.docs[0].data()).toMatchObject({ amountMinor: 80000, category: "Repairs" });
    await expect(decideApproval(ctx, hid, owner, ap.approvalId, "approve")).rejects.toMatchObject({ code: "approval_decided" });
  });
  it("never claims manual external actions were done", async () => {
    const ap = await requestApproval(ctx, hid, adult, { action: "book_service_provider", title: "Book AC service", rationale: "Not cooling",
      params: { maintenanceRecordId: "m1", providerName: "CoolAir", proposedDate: "2026-11-20" } });
    const res = await decideApproval(ctx, hid, owner, ap.approvalId, "approve");
    expect(res.executionResult).toMatchObject({ outcome: "requires_manual_completion" });
  });
  it("rejects invalid parameters and expires stale approvals", async () => {
    await expect(requestApproval(ctx, hid, adult, { action: "record_expense", title: "x", rationale: "y", params: { amountMinor: 1.5 } })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(requestApproval(ctx, hid, adult, { action: "wire_money", title: "x", rationale: "y", params: {} })).rejects.toMatchObject({ code: "invalid_argument" });
    const ap = await requestApproval(ctx, hid, adult, { action: "purchase_items", title: "Buy groceries", rationale: "Weekly", params: { listId: "l1" }, expiresInHours: 1 });
    const later = { ...ctx, now: () => new Date(Date.now() + 2 * 3600_000) };
    await expect(decideApproval(later, hid, owner, ap.approvalId, "approve")).rejects.toMatchObject({ code: "approval_expired" });
    const ap2 = await requestApproval(ctx, hid, adult, { action: "purchase_items", title: "Buy", rationale: "y", params: { listId: "l1" }, expiresInHours: 1 });
    expect(await expireApprovals(later)).toBeGreaterThanOrEqual(1);
    expect((await ctx.db.doc(`households/${hid}/approvals/${ap2.approvalId}`).get()).data()!.status).toBe("expired");
  });
});

describe("calendar, briefing, memory", () => {
  it("detects schedule conflicts", async () => {
    await createEvent(ctx, hid, owner, { title: "Dentist", startAt: "2026-11-21T05:00:00Z", endAt: "2026-11-21T06:00:00Z", category: "appointment", attendeeUids: [adult.uid], visibility: "household", staffVisible: false });
    const c = await checkScheduleConflicts(ctx, hid, owner, "2026-11-21T05:30:00Z", "2026-11-21T07:00:00Z", [adult.uid]);
    expect(c.hasConflicts).toBe(true);
    const none = await checkScheduleConflicts(ctx, hid, owner, "2026-11-21T06:00:00Z", "2026-11-21T07:00:00Z", [adult.uid]);
    expect(none.hasConflicts).toBe(false);
  });
  it("builds the daily briefing without any LLM", async () => {
    await createTask(ctx, hid, owner, { title: "Renew insurance", priority: "high", dueAt: new Date(Date.now() - 86400_000).toISOString() });
    const b = await computeBriefing(ctx, hid, owner);
    expect(b.generatedBy).toBe("deterministic");
    expect(b.overdueTasks[0].title).toBe("Renew insurance");
    expect(b.nextAction).toMatchObject({ kind: "task" });
  });
  it("scopes, recalls, corrects, deletes and exports memory", async () => {
    await remember(ctx, hid, owner, { scope: "household", kind: "preference", text: "We are vegetarian on Tuesdays" });
    const priv = await remember(ctx, hid, adult, { scope: "private", kind: "fact", text: "Adult likes filter coffee" });
    await expect(remember(ctx, hid, staff, { scope: "household", kind: "fact", text: "x" })).rejects.toBeInstanceOf(AppError);
    expect((await recall(ctx, hid, adult.uid, "adult", "plan tuesday dinner")).map((m) => m.text)).toContain("We are vegetarian on Tuesdays");
    expect((await listMemories(ctx, hid, owner)).find((m) => m.id === priv.id)).toBeUndefined();
    await correctMemory(ctx, hid, adult, priv.id, "Adult prefers tea");
    const exported = await exportUserData(ctx, adult.uid);
    expect(exported.households[0].privateMemories[0].text).toBe("Adult prefers tea");
    await expect(deleteMemory(ctx, hid, owner, priv.id)).rejects.toMatchObject({ code: "forbidden" });
    await deleteMemory(ctx, hid, adult, priv.id);
  });
});

describe("scheduler", () => {
  it("never runs the same job slot twice, even when invoked concurrently", async () => {
    const jobRef = ctx.db.doc(`households/${hid}/scheduledJobs/morning_briefing`);
    await jobRef.update({ nextRunAt: Timestamp.fromDate(new Date(Date.now() - 60_000)) });
    const [a, b] = await Promise.all([runDueJobs(ctx), runDueJobs(ctx)]);
    const ran = [...a, ...b].filter((r) => r.job.startsWith("morning_briefing") && r.status === "succeeded");
    expect(ran.length).toBe(1);
    const runs = await jobRef.collection("runs").get();
    expect(runs.size).toBe(1);
    const job = (await jobRef.get()).data()!;
    expect(job.lastStatus).toBe("succeeded");
    expect(job.nextRunAt.toDate().getTime()).toBeGreaterThan(Date.now());
  });
  it("skips agent-only jobs when Hermes is unavailable instead of failing", async () => {
    const ref = ctx.db.doc(`households/${hid}/scheduledJobs/weekly_meal_planning`);
    await ref.update({ enabled: true, nextRunAt: Timestamp.fromDate(new Date(Date.now() - 1000)) });
    const r = await runDueJobs(ctx, { deviceGraceMs: 0 });
    expect(r.find((x) => x.job.startsWith("weekly_meal_planning"))!.status).toBe("skipped_agent_unavailable");
  });
});
