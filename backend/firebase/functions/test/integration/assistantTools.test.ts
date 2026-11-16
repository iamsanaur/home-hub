import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, clearFirestore, mcpClient, startMcp, testCtx } from "./helpers";
import { Actor } from "../../src/services/base";
import { acceptInvitation, createHousehold, invite, setAutonomy } from "../../src/services/households";
import { connectIntegration } from "../../src/plugins/runtime";
import { addPantryItems } from "../../src/services/food";
import { decideApproval } from "../../src/services/approvals";
import { mintGrant } from "../../src/agent/grants";

const NOW = new Date("2026-11-10T06:30:00Z");
const ctx = testCtx(() => NOW);
const owner: Actor = { uid: "at_owner", kind: "user" };
const child: Actor = { uid: "at_child", kind: "user" };
let hid: string;
let mcp: Awaited<ReturnType<typeof startMcp>>;
beforeAll(async () => { mcp = await startMcp(ctx); });
afterAll(async () => { await mcp.close(); });
beforeEach(async () => {
  await clearFirestore();
  hid = (await createHousehold(ctx, { uid: owner.uid, displayName: "O", email: "at@example.com" }, { name: "Home", currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" })).householdId;
  const inv = await invite(ctx, owner, hid, { role: "child", email: "at_child@example.com" });
  await acceptInvitation(ctx, { uid: child.uid, email: "at_child@example.com", emailVerified: true, displayName: "C" }, inv.token);
  await setAutonomy(ctx, owner, hid, { mode: "advanced" });
});

const as = (a: Actor) => async (name: string, args: Record<string, unknown> = {}) => {
  const grant = await mintGrant(ctx, { householdId: hid, uid: a.uid, sessionId: "s", workflowId: "w", maxToolCalls: 80 });
  const client = await mcpClient(mcp.url);
  try { const r = await callTool(client, name, { grant, ...args }) as { ok?: boolean; data?: unknown }; return r.ok ? r.data : r; } finally { await client.close(); }
};
const run = as(owner), runChild = as(child);
const err = (r: unknown) => JSON.stringify(r);

describe("shopping: the assistant can read lists and find items by name", () => {
  it("lists, reads, edits, marks purchased by name, and removes", async () => {
    const l = await run("create_shopping_list", { name: "Weekly" }) as { id: string };
    await run("add_shopping_item", { listId: l.id, name: "Milk", quantity: 2, unit: "l", category: "Dairy" });
    await run("add_shopping_item", { listId: l.id, name: "Eggs", quantity: 12, unit: "pcs", category: "Dairy" });
    expect(await run("list_shopping_lists")).toEqual([expect.objectContaining({ name: "Weekly", items: 2 })]);
    const got = await run("get_shopping_list", {}) as { items: Array<{ name: string; id: string }> };
    expect(got.items.map((i) => i.name).sort()).toEqual(["Eggs", "Milk"]);
    await run("update_shopping_item", { item: "milk", quantity: 3 });
    expect(((await run("get_shopping_list", {})) as { items: Array<{ name: string; quantity: number }> }).items.find((i) => i.name === "Milk")!.quantity).toBe(3);
    expect(await run("mark_item_purchased", { item: "milk" })).toMatchObject({ id: expect.any(String) });
    expect(((await run("get_shopping_list", {})) as { items: unknown[] }).items).toHaveLength(1);
    expect(await run("remove_shopping_item", { item: "eggs" })).toMatchObject({ removed: "Eggs" });
    expect(((await run("get_shopping_list", { include_purchased: true })) as { items: unknown[] }).items).toHaveLength(1);
    expect(err(await run("mark_item_purchased", { item: "bread" }))).toMatch(/not.?found|Unpurchased item/i);
  });
});

describe("pantry usage, budgets, income", () => {
  it("records use and waste against the ledger and never goes below zero", async () => {
    await addPantryItems(ctx, hid, owner, [{ name: "Rice", quantity: 5, unit: "kg" }]);
    expect(await run("adjust_pantry", { item: "rice", kind: "consume", quantity: 1.5 })).toMatchObject({ quantity: 3.5 });
    expect(await run("adjust_pantry", { item: "rice", kind: "waste", quantity: 10 })).toMatchObject({ quantity: 0 });
    const kinds = (await ctx.db.collection(`households/${hid}/pantryMovements`).get()).docs.map((d) => d.data().kind).sort();
    expect(kinds).toEqual(["consume", "waste"]);
  });
  it("sets a budget in major units, updates it in place, and records income as income", async () => {
    await run("set_budget", { period: "2026-11", category: "*", limit: 40000 });
    await run("set_budget", { period: "2026-11", category: "*", limit: 45000 });
    const b = (await ctx.db.collection(`households/${hid}/budgets`).get()).docs.map((d) => d.data());
    expect(b).toHaveLength(1); expect(b[0]).toMatchObject({ limitMinor: 4_500_000, category: "*" });
    await run("record_income", { amountMinor: 5_000_000, currency: "INR", occurredAt: "2026-11-01T05:00:00Z" });
    expect((await ctx.db.collection(`households/${hid}/transactions`).get()).docs[0].data()).toMatchObject({ type: "income", amountMinor: 5_000_000 });
  });
  it("children cannot touch money", async () => {
    expect(err(await runChild("set_budget", { period: "2026-11", limit: 100 }))).toMatch(/forbidden|permission|cannot|not allowed/i);
    expect(err(await runChild("record_income", { amountMinor: 100, currency: "INR", occurredAt: "2026-11-01T05:00:00Z" }))).toMatch(/forbidden|permission|cannot|not allowed/i);
  });
});

describe("calendar, fixed bills, recipes, cleaning, notes, memory", () => {
  it("edits and cancels an event, and reports conflicts after a move", async () => {
    const e = await run("create_event", { title: "Dentist", startAt: "2026-11-12T05:00:00Z", endAt: "2026-11-12T06:00:00Z" }) as { id: string };
    await run("create_event", { title: "Call", startAt: "2026-11-13T05:00:00Z", endAt: "2026-11-13T06:00:00Z" });
    const moved = await run("update_event", { event_id: e.id, startAt: "2026-11-13T05:30:00Z", endAt: "2026-11-13T06:30:00Z" }) as { conflicts: unknown[] };
    expect(moved.conflicts.length).toBeGreaterThan(0);
    expect(await run("cancel_event", { event_id: e.id })).toMatchObject({ cancelled: "Dentist" });
    expect((await ctx.db.doc(`households/${hid}/events/${e.id}`).get()).exists).toBe(false);
  });
  it("edits a fixed bill but refuses to edit a pay-per-delivery bill that way", async () => {
    await run("create_bill", { name: "Rent", amount: 13000, due_date: "2026-12-02" });
    await run("update_bill", { bill: "rent", amount: 14000 });
    expect((await ctx.db.collection(`households/${hid}/bills`).get()).docs[0].data().amountMinor).toBe(1_400_000);
    await run("create_vendor_bill", { name: "Milk", unit: "l", rate_per_unit: 60 });
    expect(err(await run("update_bill", { bill: "milk", amount: 10 }))).toMatch(/update_vendor_bill/);
  });
  it("saves and reads recipes, runs cleaning routines, notes and memory with the right privacy", async () => {
    await run("create_recipe", { name: "Dal", servings: 4, ingredients: [{ name: "Toor dal", quantity: 300, unit: "g" }] });
    expect(await run("list_recipes")).toEqual([expect.objectContaining({ name: "Dal", ingredients: ["300 g Toor dal"] })]);
    await run("create_cleaning_routine", { title: "Wipe counters", room: "Kitchen", frequency: "daily" });
    const done = await run("mark_cleaned", { routine: "counters" }) as { nextDueAt: string };
    expect(done.nextDueAt).toBe("2026-11-11T06:30:00.000Z");
    await run("create_note", { title: "Wifi", body: "pw is on the fridge", visibility: "private" });
    await run("create_note", { title: "Guests", body: "Saturday dinner", visibility: "household" });
    expect(((await run("list_notes")) as Array<{ title: string }>).map((n) => n.title).sort()).toEqual(["Guests", "Wifi"]);
    expect(((await runChild("list_notes")) as Array<{ title: string }>).map((n) => n.title)).toEqual(["Guests"]); // another person's private note stays private
    const m = await run("remember_preference", { text: "We are vegetarian", scope: "household" }) as { id: string };
    expect(((await run("list_memories")) as Array<{ text: string }>).map((x) => x.text)).toContain("We are vegetarian");
    await run("forget_memory", { memory_id: m.id });
    expect(await run("list_memories")).toEqual([]);
  });
});

describe("autonomy still applies to the new tools", () => {
  it("in routine mode money changes need approval but small reversible edits do not", async () => {
    await setAutonomy(ctx, owner, hid, { mode: "routine" });
    const r = await run("set_budget", { period: "2026-11", limit: 1000 }) as { status?: string };
    expect(r.status).toBe("approval_required");
    expect((await ctx.db.collection(`households/${hid}/budgets`).get()).size).toBe(0);
    expect(await run("create_note", { title: "x", body: "y" })).toMatchObject({ id: expect.any(String) });
    await setAutonomy(ctx, owner, hid, { paused: true });
    expect(err(await run("create_note", { title: "x", body: "y" }))).toMatch(/paused/i);
  });
});

describe("devices, automations and connected services", () => {
  it("controls a demo device by name, verifies it, and holds locks for approval", async () => {
    await connectIntegration(ctx, owner, hid, { pluginId: "homehub.demo-devices", consent: true });
    const devs = (await run("list_devices")) as { devices: Array<{ name: string; capabilities: string[] }> };
    const light = devs.devices.find((d) => d.capabilities?.includes("power") && !d.capabilities.includes("lock"))!;
    expect(await run("control_device", { device: light.name, action: "power_on" })).toMatchObject({ status: "verified", done: true });
    const lock = devs.devices.find((d) => d.capabilities?.includes("lock"))!;
    const r = await run("control_device", { device: lock.name, action: "unlock" }) as { status: string; done: boolean; approvalId?: string };
    expect(r).toMatchObject({ done: false }); expect(r.status).toBe("approval_required"); expect(r.approvalId).toBeTruthy();
  });
  it("lists integrations with their tools; sending is held for approval until a person approves", async () => {
    await connectIntegration(ctx, owner, hid, { pluginId: "homehub.webhook", consent: true, config: { outboundUrl: "https://example.com/hook" }, secrets: { signingSecret: "s3cret" } },
      { fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch });
    const li = (await run("list_integrations")) as Array<{ id: string; name: string; tools: Array<{ name: string; needsApproval: boolean }> }>;
    expect(li[0].tools.find((t) => t.name === "send_event")).toMatchObject({ needsApproval: true });
    const r = await run("call_integration_tool", { integration: li[0].name, tool: "send_event", input: { type: "hello" } }) as { done: boolean; status: string; approvalId: string };
    expect(r).toMatchObject({ done: false, status: "approval_required" });
    expect(err(await run("call_integration_tool", { integration: "nope", tool: "x" }))).toMatch(/No connected integration/);
    void decideApproval;
  });
  it("a new automation is only proposed (approval), and managers can switch existing ones", async () => {
    const r = await run("create_automation", { name: "Evening lights", trigger: { type: "schedule", time: "19:00" }, actions: [{ type: "notify", title: "Hi", body: "Evening" }] }) as { status?: string; approvalId?: string; error?: { code: string } };
    expect(r.error?.code ?? r.status).toMatch(/approval_required/);
    expect((await ctx.db.collection(`households/${hid}/automations`).get()).size).toBe(0);
    await ctx.db.doc(`households/${hid}/automations/a1`).set({ name: "Porch light", enabled: true, trigger: { type: "manual" }, actions: [] });
    expect(await run("set_automation_enabled", { automation: "porch", enabled: false })).toMatchObject({ enabled: false });
    expect(err(await runChild("set_automation_enabled", { automation: "porch", enabled: true }))).toMatch(/managers|forbidden/i);
  });
});
