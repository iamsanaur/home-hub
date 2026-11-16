import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { callTool, clearFirestore, createUser, fakeHermes, listen, mcpClient, MCP_KEY, startMcp, testCtx } from "./helpers";
import { createHousehold, invite, acceptInvitation, setAutonomy } from "../../src/services/households";
import { mintGrant } from "../../src/agent/grants";
import { TOOLS } from "../../src/mcp/tools";
import { createGatewayApp } from "../../src/gateway/app";
import { HermesClient } from "../../src/agent/hermesClient";

const ctx = testCtx();
let mcp: Awaited<ReturnType<typeof startMcp>>;

beforeAll(async () => { mcp = await startMcp(ctx); });
afterAll(async () => { await mcp.close(); });

async function setup() {
  await clearFirestore();
  const a = await createHousehold(ctx, { uid: "ownerA" }, { name: "A", currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" });
  const b = await createHousehold(ctx, { uid: "ownerB" }, { name: "B", currency: "USD", timezone: "UTC", locale: "en" });
  const inv = await invite(ctx, { uid: "ownerA", kind: "user" }, a.householdId, { role: "staff" });
  await acceptInvitation(ctx, { uid: "staffA" }, inv.token);
  return { A: a.householdId, B: b.householdId };
}

describe("MCP server contract", () => {
  let A: string; let B: string;
  beforeEach(async () => { ({ A, B } = await setup()); });

  it("exposes exactly the documented tool set with JSON schemas", async () => {
    const client = await mcpClient(mcp.url);
    const tools = (await client.listTools()).tools;
    // Exactly the initial tool set from the product brief (§8).
    const SPEC = ["get_household_summary", "get_household_members", "get_member_permissions", "list_tasks", "create_task", "update_task",
      "complete_task", "assign_task", "get_inventory", "get_low_stock_items", "create_shopping_list", "add_shopping_item", "mark_item_purchased",
      "get_meal_plan", "create_meal_plan", "generate_meal_shopping_list", "get_budget_summary", "list_expenses", "record_expense", "get_bill_status",
      "list_maintenance_records", "create_maintenance_request", "schedule_service_reminder", "list_events", "create_event", "check_schedule_conflicts",
      "request_approval", "list_pending_approvals", "get_approval_status", "get_household_report", "get_agent_usage_report"];
    // Documented extensions beyond the brief: vendor bills (pay per delivery), bill listing and bulk pantry entry.
    const EXTENSIONS = ["list_bills", "create_vendor_bill", "update_vendor_bill", "record_deliveries", "get_bill_ledger", "add_pantry_items"];
    expect(tools.map((t) => t.name).sort()).toEqual([...SPEC, ...EXTENSIONS].sort());
    expect(TOOLS.length).toBe(SPEC.length + EXTENSIONS.length);
    for (const t of tools) expect((t.inputSchema as { required?: string[] }).required).toContain("grant");
    expect(tools.some((t) => /householdId|household_id/.test(JSON.stringify(t.inputSchema)))).toBe(false);
    await client.close();
  });

  it("rejects callers without the service key", async () => {
    await expect(mcpClient(mcp.url, "wrong-key-wrong-key-wrong-key")).rejects.toThrow();
  });

  it("scopes every call to the grant's household and user", async () => {
    const client = await mcpClient(mcp.url);
    const gA = await mintGrant(ctx, { householdId: A, uid: "ownerA", sessionId: "s", workflowId: "wfA" });
    const created = await callTool(client, "create_task", { grant: gA, title: "Clean balcony", priority: "normal" });
    expect(created.ok).toBe(true);
    expect((await ctx.db.doc(`households/${A}/tasks/${created.data.id}`).get()).data()!.source).toBe("agent");
    // A grant for B's owner can only ever see B.
    const gB = await mintGrant(ctx, { householdId: B, uid: "ownerB", sessionId: "s", workflowId: "wfB" });
    const listB = await callTool(client, "list_tasks", { grant: gB, filter: "all" });
    expect(listB.data).toEqual([]);
    // Smuggled household IDs are rejected as unknown arguments are stripped; data stays in A.
    const sneaky = await callTool(client, "create_task", { grant: gB, title: "Sneaky", priority: "low", householdId: A });
    expect(sneaky.ok).toBe(true);
    expect((await ctx.db.doc(`households/${A}/tasks/${sneaky.data.id}`).get()).exists).toBe(false);
    expect((await ctx.db.doc(`households/${B}/tasks/${sneaky.data.id}`).get()).exists).toBe(true);
    // Staff grant inherits staff restrictions.
    const gS = await mintGrant(ctx, { householdId: A, uid: "staffA", sessionId: "s", workflowId: "wfS" });
    const fin = await callTool(client, "get_budget_summary", { grant: gS, period: "2026-11" });
    expect(fin).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await client.close();
  });

  it("validates grants, budgets and inputs", async () => {
    const client = await mcpClient(mcp.url);
    expect(await callTool(client, "list_tasks", { grant: "hhg_forged" })).toMatchObject({ ok: false, error: { code: "invalid_grant" } });
    const g = await mintGrant(ctx, { householdId: A, uid: "ownerA", sessionId: "s", workflowId: "wf", maxToolCalls: 2 });
    expect((await callTool(client, "create_task", { grant: g, title: "", priority: "normal" })).error?.code).toBe("invalid_argument");
    // Schema-invalid calls are rejected by the SDK before consuming budget; two valid calls exhaust it.
    await callTool(client, "list_tasks", { grant: g });
    await callTool(client, "list_tasks", { grant: g });
    expect(await callTool(client, "list_tasks", { grant: g })).toMatchObject({ ok: false, error: { code: "tool_budget_exceeded" } });
    const expired = await mintGrant({ ...ctx, now: () => new Date(Date.now() - 3600_000) }, { householdId: A, uid: "ownerA", sessionId: "s", workflowId: "wf2", ttlMinutes: 5 });
    expect(await callTool(client, "list_tasks", { grant: expired })).toMatchObject({ ok: false, error: { code: "grant_expired" } });
    await client.close();
  });

  it("enforces autonomy: pause blocks writes; bounded writes become approvals; approval executes stored args", async () => {
    const client = await mcpClient(mcp.url);
    const g = await mintGrant(ctx, { householdId: A, uid: "ownerA", sessionId: "s", workflowId: "wfP" });
    await setAutonomy(ctx, { uid: "ownerA", kind: "user" }, A, { paused: true });
    expect(await callTool(client, "create_task", { grant: g, title: "x", priority: "normal" })).toMatchObject({ ok: false, error: { code: "autonomy_paused" } });
    expect((await callTool(client, "list_tasks", { grant: g })).ok).toBe(true); // reads still work
    await setAutonomy(ctx, { uid: "ownerA", kind: "user" }, A, { paused: false });
    const exp = await callTool(client, "record_expense", { grant: g, amountMinor: 45000, currency: "INR", category: "Groceries", paymentMethod: "upi", occurredAt: "2026-11-15T10:00:00+05:30" });
    expect(exp).toMatchObject({ ok: false, status: "approval_required" });
    expect((await ctx.db.collection(`households/${A}/transactions`).get()).size).toBe(0);
    const { decideApproval } = await import("../../src/services/approvals");
    const res = await decideApproval(ctx, A, { uid: "ownerA", kind: "user" }, exp.approvalId!, "approve");
    expect(res.status).toBe("executed");
    expect((await ctx.db.collection(`households/${A}/transactions`).get()).docs[0].data().amountMinor).toBe(45000);
    await client.close();
  });

  it("applies retried writes once with idempotency keys", async () => {
    const client = await mcpClient(mcp.url);
    const g = await mintGrant(ctx, { householdId: A, uid: "ownerA", sessionId: "s", workflowId: "wfI" });
    const a = await callTool(client, "create_task", { grant: g, title: "Once", priority: "normal", idempotency_key: "task-once-001" });
    const b = await callTool(client, "create_task", { grant: g, title: "Once", priority: "normal", idempotency_key: "task-once-001" });
    expect(b.data.id).toBe(a.data.id);
    expect((await ctx.db.collection(`households/${A}/tasks`).where("title", "==", "Once").get()).size).toBe(1);
    await client.close();
  });
});

describe("gateway → Hermes → MCP end-to-end (weekly preparation)", () => {
  it("runs the workflow, streams progress, verifies results from Firestore and records usage", async () => {
    await clearFirestore();
    const owner = await createUser(`owner${Date.now()}@example.com`, "Priya");
    const outsider = await createUser(`out${Date.now()}@example.com`, "Mallory");
    const hermesDouble = fakeHermes({
      mcpUrl: mcp.url,
      script: async (call) => {
        await call("get_household_summary", {});
        await call("get_low_stock_items", {});
        const plan = await call("create_meal_plan", { weekStart: "2026-11-23", entries: [{ date: "2026-11-23", slot: "dinner", title: "Khichdi", servings: 4 }] });
        const list = await call("create_shopping_list", { name: "Week of 23 Nov" });
        await call("add_shopping_item", { listId: list.data.id, name: "Rice", quantity: 2, unit: "kg", category: "Staples" });
        await call("create_task", { title: "Deep clean kitchen", priority: "normal", dueAt: "2026-11-24T04:30:00.000Z" });
        return plan.status === "approval_required"
          ? "Created a shopping list and a cleaning task. The meal plan is awaiting your approval."
          : "Done.";
      },
    });
    const hermesServer = await listen(hermesDouble.app);
    const gateway = createGatewayApp({ ctx, hermes: () => new HermesClient({ baseUrl: hermesServer.url, apiKey: "hermes-test-key" }), enforceAppCheck: false });
    const gw = await listen(gateway);
    const H = { Authorization: `Bearer ${owner.idToken}`, "Content-Type": "application/json" };
    try {
      const created = await (await fetch(`${gw.url}/v1/households`, { method: "POST", headers: H, body: JSON.stringify({ name: "Iyer Home", currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" }) })).json();
      const hid = created.householdId;
      // Outsiders cannot use another household's agent.
      const denied = await fetch(`${gw.url}/v1/households/${hid}/agent/runs`, { method: "POST", headers: { ...H, Authorization: `Bearer ${outsider.idToken}` }, body: JSON.stringify({ message: "Prepare everything for next week." }) });
      expect(denied.status).toBe(403);
      expect((await fetch(`${gw.url}/v1/households/${hid}/agent/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);

      const start = await fetch(`${gw.url}/v1/households/${hid}/agent/runs`, { method: "POST", headers: H, body: JSON.stringify({ message: "Prepare everything for next week.", idempotencyKey: "prep-week-48" }) });
      expect(start.status).toBe(202);
      const run = await start.json();
      expect(run.mode).toBe("agent");
      expect(hermesDouble.received[0].body.instructions).toContain("`household-manager` skill");
      expect(hermesDouble.received[0].body.instructions).toContain("weekly_preparation");
      expect(hermesDouble.received[0].idempotencyKey).toBe(`${hid}:${owner.uid}:prep-week-48`);

      const sse = await fetch(`${gw.url}/v1/households/${hid}/agent/workflows/${run.workflowId}/events`, { headers: H });
      const text = await sse.text();
      const events = text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("status");
      expect(types).toContain("tool");
      expect(types).toContain("delta");
      expect(events.find((e) => e.type === "approvals").items[0].action).toBe("agent_tool_call");
      const verified = events.find((e) => e.type === "verified").actions.map((a: { action: string }) => a.action);
      expect(verified).toEqual(expect.arrayContaining(["shopping.list_created", "task.created"]));
      expect(verified).not.toContain("meals.plan_created"); // gated: not executed
      expect(events.at(-1)).toEqual({ type: "status", state: "awaiting_approval" });

      const usage = (await ctx.db.collection(`households/${hid}/agentUsage`).get()).docs[0].data();
      expect(usage).toMatchObject({ inputTokens: 1200, outputTokens: 180, totalTokens: 1380, skill: "household-manager", status: "completed" });
      expect(usage.toolCalls).toBe(6);
      const wf = (await ctx.db.doc(`households/${hid}/agentWorkflows/${run.workflowId}`).get()).data()!;
      expect(wf.status).toBe("awaiting_approval");
      // Grant revoked after the run.
      const grants = await ctx.db.collection("agentGrants").where("workflowId", "==", run.workflowId).get();
      expect(grants.docs.every((d) => d.data().revoked)).toBe(true);
      const report = await (await fetch(`${gw.url}/v1/households/${hid}/agent/usage`, { headers: H })).json();
      expect(report).toMatchObject({ runs: 1, completed: 1, tokensPerSuccessfulRun: 1380 });

      // Deterministic requests never reach Hermes.
      const brief = await (await fetch(`${gw.url}/v1/households/${hid}/agent/runs`, { method: "POST", headers: H, body: JSON.stringify({ message: "What's due today?" }) })).json();
      expect(brief.mode).toBe("deterministic");
      expect(hermesDouble.received.length).toBe(1);
    } finally {
      await gw.close();
      await hermesServer.close();
    }
  });

  it("keeps the app working when Hermes is unavailable", async () => {
    await clearFirestore();
    const owner = await createUser(`o2${Date.now()}@example.com`);
    const down = fakeHermes({ mcpUrl: mcp.url, down: true, script: async () => "" });
    const hermesServer = await listen(down.app);
    const gw = await listen(createGatewayApp({ ctx, hermes: () => new HermesClient({ baseUrl: hermesServer.url, apiKey: "hermes-test-key", timeoutMs: 2000 }), enforceAppCheck: false }));
    const H = { Authorization: `Bearer ${owner.idToken}`, "Content-Type": "application/json" };
    try {
      const { householdId } = await (await fetch(`${gw.url}/v1/households`, { method: "POST", headers: H, body: JSON.stringify({ name: "Home", currency: "EUR", timezone: "Europe/Berlin" }) })).json();
      const res = await fetch(`${gw.url}/v1/households/${householdId}/agent/runs`, { method: "POST", headers: H, body: JSON.stringify({ message: "Plan dinners" }) });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("agent_unavailable");
      const health = await (await fetch(`${gw.url}/v1/health`)).json();
      expect(health.agent).toBe("unreachable");
      const briefing = await fetch(`${gw.url}/v1/households/${householdId}/briefing`, { headers: H });
      expect(briefing.status).toBe(200);
      const tasks = await ctx.db.collection(`households/${householdId}/tasks`).get();
      expect(tasks.size).toBe(0);
      void Timestamp; void MCP_KEY;
    } finally {
      await gw.close();
      await hermesServer.close();
    }
  });
});
