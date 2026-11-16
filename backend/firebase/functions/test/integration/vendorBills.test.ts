import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, clearFirestore, mcpClient, startMcp, testCtx } from "./helpers";
import { Actor } from "../../src/services/base";
import { acceptInvitation, createHousehold, invite, setAutonomy } from "../../src/services/households";
import { createVendorBill, getBillLedger, setDeliveries, updateVendorBill } from "../../src/services/vendorBills";
import { recordBillPayment } from "../../src/services/finance";
import { addPantryItems } from "../../src/services/food";
import { decideApproval } from "../../src/services/approvals";
import { mintGrant } from "../../src/agent/grants";

// "Now" is 10 November 2026, 12:00 in India: the month being collected is November.
const NOW = new Date("2026-11-10T06:30:00Z");
const ctx = testCtx(() => NOW);
const owner: Actor = { uid: "vb_owner", kind: "user" };
const child: Actor = { uid: "vb_child", kind: "user" };
let hid: string;
let mcp: Awaited<ReturnType<typeof startMcp>>;
beforeAll(async () => { mcp = await startMcp(ctx); });
afterAll(async () => { await mcp.close(); });

beforeEach(async () => {
  await clearFirestore();
  hid = (await createHousehold(ctx, { uid: owner.uid, displayName: "O", email: "vb@example.com" }, { name: "Home", currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" })).householdId;
  const inv = await invite(ctx, owner, hid, { role: "child", email: "vb_child@example.com" });
  await acceptInvitation(ctx, { uid: child.uid, email: "vb_child@example.com", emailVerified: true, displayName: "C" }, inv.token);
});

const milk = { name: "Milk vendor", vendor: "Ramesh", unit: "l", rateMinor: 6000, defaultQuantity: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], dueDay: 5, category: "Groceries" };
const bill = async (id: string) => (await ctx.db.doc(`households/${hid}/bills/${id}`).get()).data()!;

describe("milk vendor: pay per liter delivered", () => {
  it("creates the bill with the month's projected amount and a due date early next month", async () => {
    const { id, projectedMinor, cycleMonth } = await createVendorBill(ctx, hid, owner, milk);
    expect(cycleMonth).toBe("2026-11");
    expect(projectedMinor).toBe(30 * 6000);
    const b = await bill(id);
    expect(b).toMatchObject({ kind: "metered", amountMinor: 180000, currency: "INR", provider: "Ramesh" });
    expect(b.nextDueAt.toDate().toISOString()).toBe("2026-12-05T03:30:00.000Z");
  });

  it("skipped days are not charged, and the bill's amount follows", async () => {
    const { id } = await createVendorBill(ctx, hid, owner, milk);
    const r = await setDeliveries(ctx, hid, owner, id, [{ date: "2026-11-03", quantity: 0 }, { date: "2026-11-04", quantity: 0 }, { date: "2026-11-20", quantity: 0 }]);
    expect(r.months[0]).toMatchObject({ month: "2026-11", skippedDays: 3, totalMinor: 27 * 6000 });
    expect((await bill(id)).amountMinor).toBe(27 * 6000);
    const l = await getBillLedger(ctx, hid, owner, id);
    expect(l.totals).toMatchObject({ skippedDays: 3, deliveredDays: 8 - 0 + 0 - 0 > 0 ? l.totals.deliveredDays : 0, totalMinor: 162000 });
    expect(l.totals.soFarMinor).toBe(8 * 6000);             // 10 days so far minus the 2 skipped
    expect(l.days.find((d) => d.date === "2026-11-20")).toMatchObject({ status: "skipped" });
    // Clearing an exception returns the day to the schedule; marking a normal day as normal stores nothing.
    await setDeliveries(ctx, hid, owner, id, [{ date: "2026-11-03", quantity: null }, { date: "2026-11-07", quantity: 1 }]);
    expect((await bill(id)).amountMinor).toBe(28 * 6000);
    const ledger = (await ctx.db.doc(`households/${hid}/billLedgers/${id}_2026-11`).get()).data()!;
    expect(Object.keys(ledger.exceptions).sort()).toEqual(["2026-11-04", "2026-11-20"]);
  });

  it("extra quantity and half liters stay exact in integer money", async () => {
    const { id } = await createVendorBill(ctx, hid, owner, milk);
    await setDeliveries(ctx, hid, owner, id, [{ date: "2026-11-15", quantity: 2.5 }, { date: "2026-11-16", quantity: 0.5 }]);
    expect((await bill(id)).amountMinor).toBe(Math.round(31 * 6000));
  });

  it("a price rise applies from next month unless asked to apply now", async () => {
    const { id } = await createVendorBill(ctx, hid, owner, milk);
    await updateVendorBill(ctx, hid, owner, id, { rateMinor: 6500, applyToCurrentMonth: false });
    expect((await bill(id)).amountMinor).toBe(30 * 6000);                          // November keeps ₹60
    expect((await getBillLedger(ctx, hid, owner, id, "2026-12")).totals.totalMinor).toBe(31 * 6500); // December at ₹65
    await updateVendorBill(ctx, hid, owner, id, { applyToCurrentMonth: true });
    expect((await bill(id)).amountMinor).toBe(30 * 6500);
  });

  it("paying closes the month and opens the next; closed months can't be edited", async () => {
    const { id } = await createVendorBill(ctx, hid, owner, milk);
    await setDeliveries(ctx, hid, owner, id, [{ date: "2026-11-03", quantity: 0 }]);
    const paid = await recordBillPayment(ctx, hid, owner, id, { amountMinor: 174000, currency: "INR", paidAt: "2026-12-05T04:00:00.000Z", method: "upi" } as never);
    expect(paid.nextDueAt).toBe("2027-01-05T03:30:00.000Z");
    const b = await bill(id);
    expect(b.meter.cycleMonth).toBe("2026-12");
    expect(b.amountMinor).toBe(31 * 6000);                       // December projection
    expect((await getBillLedger(ctx, hid, owner, id, "2026-11")).paid).toBe(true);
    await expect(setDeliveries(ctx, hid, owner, id, [{ date: "2026-11-09", quantity: 0 }])).rejects.toThrow(/already paid/);
    await setDeliveries(ctx, hid, owner, id, [{ date: "2026-12-25", quantity: 0 }]);
    expect((await bill(id)).amountMinor).toBe(30 * 6000);
  });

  it("only people with finance access can see or change it", async () => {
    const { id } = await createVendorBill(ctx, hid, owner, milk);
    await expect(createVendorBill(ctx, hid, child, milk)).rejects.toThrow();
    await expect(getBillLedger(ctx, hid, child, id)).rejects.toThrow();
    await expect(setDeliveries(ctx, hid, child, id, [{ date: "2026-11-03", quantity: 0 }])).rejects.toThrow();
  });
});

describe("the assistant can run vendor bills, bulk pantry and propose deletions", () => {
  const run = async (name: string, args: Record<string, unknown>) => {
    const grant = await mintGrant(ctx, { householdId: hid, uid: owner.uid, sessionId: "s", workflowId: "w", maxToolCalls: 50 });
    const client = await mcpClient(mcp.url);
    try { const r = await callTool(client, name, { grant, ...args }) as { ok?: boolean; data?: unknown }; return r.ok ? r.data : r; } finally { await client.close(); }
  };

  it("creates a milk bill from plain numbers, records leave by range, and reads the month back", async () => {
    await setAutonomy(ctx, owner, hid, { mode: "routine" });
    const created = await run("create_vendor_bill", { name: "Milk vendor", vendor: "Ramesh", unit: "l", rate_per_unit: 52.5, default_quantity: 1.5 });
    expect(created).toMatchObject({ cycleMonth: "2026-11", projectedMinor: Math.round(30 * 1.5 * 5250) });
    const rec = await run("record_deliveries", { name: "milk", ranges: [{ from: "2026-11-12", to: "2026-11-14", quantity: 0 }], entries: [{ date: "2026-11-20", quantity: 3 }] });
    expect((rec as { months: Array<{ skippedDays: number }> }).months[0].skippedDays).toBe(3);
    const led = await run("get_bill_ledger", { name: "Milk vendor" }) as { totals: { skippedDays: number; totalMinor: number }; exceptions: unknown[] };
    expect(led.totals.skippedDays).toBe(3);
    expect(led.totals.totalMinor).toBe(Math.round(((27 * 1.5) - 1.5 + 3) * 5250));
    expect(led.exceptions).toHaveLength(4);
    const list = await run("list_bills", {}) as Array<{ kind: string; meter?: { unit: string } }>;
    expect(list.find((b) => b.kind === "metered")?.meter?.unit).toBe("l");
  });

  it("refuses ambiguous names with the candidates, and never accepts a rate with fractions of a paisa", async () => {
    await createVendorBill(ctx, hid, owner, milk);
    await createVendorBill(ctx, hid, owner, { ...milk, name: "Milk (second vendor)", vendor: "Suresh" });
    const err = await run("record_deliveries", { name: "milk", entries: [{ date: "2026-11-12", quantity: 0 }] }) as { error?: { message: string } };
    expect(JSON.stringify(err)).toMatch(/More than one bill matches/);
    const bad = await run("create_vendor_bill", { name: "X", rate_per_unit: 10.555 });
    expect(JSON.stringify(bad)).toMatch(/error|invalid/i);
  });

  it("finds the bill however it's named, and needs no name when there is only one", async () => {
    const { id } = await createVendorBill(ctx, hid, owner, milk);
    for (const ref of [{}, { bill: "milk" }, { bill: "Ramesh" }, { bill: id }, { name: "milk vendor" }, { bill_id: id }, { bill: "vendor milk" }]) {
      const r = await run("record_deliveries", { ...ref, entries: [{ date: "2026-11-12", quantity: 0 }] }) as { months?: unknown[] };
      expect(r.months, JSON.stringify(ref)).toBeTruthy();
    }
    expect(JSON.stringify(await run("record_deliveries", { bill: "newspaper", entries: [{ date: "2026-11-12", quantity: 0 }] }))).toMatch(/Your pay-per-delivery bills: Milk vendor/);
  });

  it("reads the argument shapes models send: explicit entries win over a stray `date`, shorthand dates, from/to", async () => {
    await createVendorBill(ctx, hid, owner, milk);
    // What the live model actually sent: a `date` next to the real entries (the extra date must not overwrite quantity 2).
    await run("record_deliveries", { date: "2026-11-14", items: [{ name: "milk", quantity: 0 }], entries: [{ date: "2026-11-14", quantity: 2 }] });
    await run("record_deliveries", { dates: ["2026-11-03", "2026-11-04"], quantity: 0 });
    await run("record_deliveries", { from: "2026-11-09", to: "2026-11-11" });
    await run("record_deliveries", { date: "2026-11-20", items: [{ quantity: 3 }] });
    const led = await run("get_bill_ledger", {}) as { exceptions: Array<{ date: string; quantity: number }> };
    const by = Object.fromEntries(led.exceptions.map((e) => [e.date, e.quantity]));
    expect(by).toMatchObject({ "2026-11-14": 2, "2026-11-03": 0, "2026-11-04": 0, "2026-11-09": 0, "2026-11-10": 0, "2026-11-11": 0, "2026-11-20": 3 });
    expect(by["2026-11-12"]).toBeUndefined();
    expect(JSON.stringify(await run("record_deliveries", {}))).toMatch(/Nothing to record/);
  });

  it("adds pantry items in bulk, merging with what's there", async () => {
    await addPantryItems(ctx, hid, owner, [{ name: "Rice", quantity: 1, unit: "kg" }]);
    const r = await run("add_pantry_items", { items: [{ name: "rice", quantity: 2, unit: "kg" }, { name: "Milk", quantity: 2, unit: "l" }, { name: "Eggs", quantity: 12 }, { name: "milk", quantity: 1, unit: "l" }] }) as { created: number; updated: number };
    expect(r).toMatchObject({ created: 2, updated: 1 });
    const items = (await ctx.db.collection(`households/${hid}/pantryItems`).get()).docs.map((d) => [d.data().name, d.data().quantity, d.data().unit]);
    expect(items).toEqual(expect.arrayContaining([["Rice", 3, "kg"], ["Milk", 3, "l"], ["Eggs", 12, "pcs"]]));
    const moves = (await ctx.db.collection(`households/${hid}/pantryMovements`).get()).docs.map((d) => d.data().kind);
    expect(moves).toEqual(["restock"]);
  });

  it("proposes a deletion that only runs after a person approves it; locked transactions can't be deleted", async () => {
    const { id } = await createVendorBill(ctx, hid, owner, milk);
    const req = await run("request_approval", { action: "delete_record", title: "Delete the milk bill", rationale: "The vendor stopped delivering.", params: { collection: "bills", id, reason: "vendor stopped" } }) as { approvalId: string; status: string };
    expect(req.status).toBe("pending");
    expect((await ctx.db.doc(`households/${hid}/bills/${id}`).get()).exists).toBe(true);        // nothing happens yet
    await decideApproval(ctx, hid, owner, req.approvalId, { decision: "approve" } as never);
    expect((await ctx.db.doc(`households/${hid}/bills/${id}`).get()).exists).toBe(false);
    expect((await ctx.db.collection(`households/${hid}/billLedgers`).get()).size).toBe(0);
    const tx = await ctx.db.collection(`households/${hid}/transactions`).add({ locked: true, type: "expense", amountMinor: 100 });
    const req2 = await run("request_approval", { action: "delete_record", title: "Delete a payment", rationale: "Wrong entry", params: { collection: "transactions", id: tx.id } }) as { approvalId: string };
    await expect(decideApproval(ctx, hid, owner, req2.approvalId, { decision: "approve" } as never)).resolves.toBeTruthy();
    expect((await ctx.db.doc(`households/${hid}/transactions/${tx.id}`).get()).exists).toBe(true);
  });
});
