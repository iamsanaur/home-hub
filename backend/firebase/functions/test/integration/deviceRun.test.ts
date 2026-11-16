import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { clearFirestore, createUser, listen, startMcp, testCtx } from "./helpers";
import { createGatewayApp } from "../../src/gateway/app";
import { runDueJobs } from "../../src/services/jobs";

const ctx = testCtx();
let mcp: Awaited<ReturnType<typeof startMcp>>;
beforeAll(async () => { mcp = await startMcp(ctx); });
afterAll(async () => { await mcp.close(); });

/** TEST DOUBLE of an OpenAI-compatible provider: scripted streamed responses with usage. */
function fakeProvider(script: Array<{ toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; text?: string }>) {
  const calls: any[] = [];
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/chat/completions", (req, res) => {
    if (req.header("authorization") !== "Bearer provider-key") { res.status(401).end(); return; }
    calls.push(req.body);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (step.toolCalls) {
      step.toolCalls.forEach((t, i) => send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${calls.length}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] } }] }));
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      for (const w of (step.text ?? "").split(" ")) send({ choices: [{ index: 0, delta: { content: `${w} ` } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    send({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 300 } } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return { app, calls };
}

async function readSse(res: Response): Promise<any[]> {
  const text = await res.text();
  return text.split("\n\n").map((f) => f.replace(/^data: /, "").trim()).filter((d) => d && d !== "[DONE]").map((d) => JSON.parse(d));
}

/**
 * Reference implementation of the Hermes Mobile protocol (what the Kotlin/Swift runtimes do):
 * model call via proxy → execute tool calls on MCP with the user's ID token + grant → repeat → complete.
 */
async function deviceLoop(gw: string, hid: string, idToken: string, run: any) {
  const H = { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" };
  const mcpClient = new Client({ name: "hermes-mobile-test", version: "1" });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${mcp.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${idToken}` } } }));
  const tools = (await mcpClient.listTools()).tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const messages: any[] = [{ role: "system", content: run.instructions }, { role: "user", content: "Prepare everything for next week." }];
  let toolCalls = 0;
  let output = "";
  for (let i = 0; i < run.limits.maxIterations; i++) {
    const res = await fetch(`${gw}/v1/households/${hid}/agent/workflows/${run.workflowId}/model`, { method: "POST", headers: H, body: JSON.stringify({ tier: run.tier, messages, tools }) });
    expect(res.status).toBe(200);
    const chunks = await readSse(res);
    const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    if (!calls.length) { output = text.trim(); break; }
    messages.push({ role: "assistant", content: null, tool_calls: calls.map((c: any) => ({ id: c.id, type: "function", function: c.function })) });
    for (const c of calls) {
      toolCalls++;
      const r = await mcpClient.callTool({ name: c.function.name, arguments: { grant: run.grant, ...JSON.parse(c.function.arguments) } });
      messages.push({ role: "tool", tool_call_id: c.id, content: (r.content as any)[0].text.slice(0, run.limits.toolOutputChars) });
    }
  }
  await mcpClient.close();
  const done = await fetch(`${gw}/v1/households/${hid}/agent/workflows/${run.workflowId}/complete`, { method: "POST", headers: H, body: JSON.stringify({ status: "completed", output, toolCalls }) });
  return done.json();
}

describe("Hermes Mobile: on-device agent loop against the HomeHub backend", () => {
  beforeEach(async () => { await clearFirestore(); });

  it("runs the loop on the device with server-side model metering, grant scoping and verification", async () => {
    const provider = fakeProvider([
      { toolCalls: [{ name: "get_household_summary", args: {} }, { name: "create_task", args: { title: "Deep clean kitchen", priority: "normal" } }] },
      { toolCalls: [{ name: "create_meal_plan", args: { weekStart: "2026-11-23", entries: [{ date: "2026-11-23", slot: "dinner", title: "Khichdi", servings: 4 }] } }] },
      { text: "Created a cleaning task. The meal plan is awaiting your approval." },
    ]);
    const prov = await listen(provider.app);
    const gwApp = createGatewayApp({
      ctx, hermes: () => null, enforceAppCheck: false,
      modelProxy: () => ({ baseUrl: prov.url, apiKey: "provider-key", modelSimple: "m-simple", modelComplex: "m-complex", maxCallsPerWorkflow: 5, maxTokensPerWorkflow: 100000 }),
    });
    const gw = await listen(gwApp);
    const owner = await createUser(`dev${Date.now()}@example.com`, "Priya");
    const other = await createUser(`dev-other${Date.now()}@example.com`, "Mallory");
    const H = { Authorization: `Bearer ${owner.idToken}`, "Content-Type": "application/json" };
    try {
      const { householdId: hid } = await (await fetch(`${gw.url}/v1/households`, { method: "POST", headers: H, body: JSON.stringify({ name: "Home", currency: "INR", timezone: "Asia/Kolkata" }) })).json();
      const startRes = await fetch(`${gw.url}/v1/households/${hid}/agent/device-runs`, { method: "POST", headers: H, body: JSON.stringify({ message: "Prepare everything for next week.", power: "normal" }) });
      expect(startRes.status).toBe(201);
      const run = await startRes.json();
      expect(run).toMatchObject({ mode: "device", skill: "household-manager", workflow: "weekly_preparation", tier: "complex" });
      expect(run.limits.maxIterations).toBe(14);
      // On device the runtime injects the grant; the model's instructions never contain it.
      expect(run.instructions).not.toContain(run.grant);
      expect(run.grant).toMatch(/^hhg_/);

      // Another user can neither drive this workflow's model calls nor use its grant on MCP.
      const stolen = await fetch(`${gw.url}/v1/households/${hid}/agent/workflows/${run.workflowId}/model`, { method: "POST", headers: { ...H, Authorization: `Bearer ${other.idToken}` }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
      expect(stolen.status).toBe(403);
      const otherMcp = new Client({ name: "x", version: "1" });
      await otherMcp.connect(new StreamableHTTPClientTransport(new URL(`${mcp.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${other.idToken}` } } }));
      const r = await otherMcp.callTool({ name: "list_tasks", arguments: { grant: run.grant } });
      expect(JSON.parse((r.content as any)[0].text).error.code).toBe("invalid_grant");
      await otherMcp.close();
      // No token → MCP refuses.
      const anon = new Client({ name: "anon", version: "1" });
      await expect(anon.connect(new StreamableHTTPClientTransport(new URL(`${mcp.url}/mcp`)))).rejects.toThrow();

      const result = await deviceLoop(gw.url, hid, owner.idToken, run);
      expect(result.state).toBe("awaiting_approval");
      expect(result.verified.map((a: any) => a.action)).toContain("task.created");
      expect(result.approvals).toHaveLength(1);
      // The client never chooses the model; the server picked the complex tier's model.
      expect(provider.calls.every((c) => c.model === "m-complex")).toBe(true);
      expect(provider.calls[0].stream_options).toEqual({ include_usage: true });

      const usage = (await ctx.db.collection(`households/${hid}/agentUsage`).get()).docs[0].data();
      expect(usage).toMatchObject({ agentId: "homehub-hermes-mobile", inputTokens: 2700, outputTokens: 180, cachedTokens: 900, toolCalls: 3, status: "completed", model: "m-complex" });
      const grants = await ctx.db.collection("agentGrants").where("workflowId", "==", run.workflowId).get();
      expect(grants.docs.every((d) => d.data().revoked)).toBe(true);
      // Finished workflow: further model calls are refused.
      const after = await fetch(`${gw.url}/v1/households/${hid}/agent/workflows/${run.workflowId}/model`, { method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: "again" }] }) });
      expect(after.status).toBe(409);
    } finally {
      await gw.close(); await prov.close();
    }
  });

  it("enforces per-workflow model budgets and power-saver limits", async () => {
    const provider = fakeProvider([{ toolCalls: [{ name: "list_tasks", args: {} }] }]);
    const prov = await listen(provider.app);
    const gw = await listen(createGatewayApp({ ctx, hermes: () => null, enforceAppCheck: false,
      modelProxy: () => ({ baseUrl: prov.url, apiKey: "provider-key", modelSimple: "m-simple", modelComplex: "m-complex", maxCallsPerWorkflow: 2, maxTokensPerWorkflow: 100000 }) }));
    const owner = await createUser(`bud${Date.now()}@example.com`);
    const H = { Authorization: `Bearer ${owner.idToken}`, "Content-Type": "application/json" };
    try {
      const { householdId: hid } = await (await fetch(`${gw.url}/v1/households`, { method: "POST", headers: H, body: JSON.stringify({ name: "Home", currency: "USD", timezone: "UTC" }) })).json();
      const run = await (await fetch(`${gw.url}/v1/households/${hid}/agent/device-runs`, { method: "POST", headers: H, body: JSON.stringify({ message: "Prepare everything for next week.", power: "saver" }) })).json();
      expect(run.tier).toBe("simple");
      expect(run.limits).toMatchObject({ maxIterations: 6, maxToolCalls: 20 });
      const call = () => fetch(`${gw.url}/v1/households/${hid}/agent/workflows/${run.workflowId}/model`, { method: "POST", headers: H, body: JSON.stringify({ tier: "complex", messages: [{ role: "user", content: "x" }] }) });
      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(200);
      const third = await call();
      expect(third.status).toBe(429);
      expect((await third.json()).error.code).toBe("model_budget_exceeded");
      expect(provider.calls.every((c) => c.model === "m-simple")).toBe(true); // saver run stays on the economical tier
    } finally {
      await gw.close(); await prov.close();
    }
  });

  it("reports model unavailability without breaking the rest of the app", async () => {
    const gw = await listen(createGatewayApp({ ctx, hermes: () => null, enforceAppCheck: false, modelProxy: () => null }));
    const owner = await createUser(`nomodel${Date.now()}@example.com`);
    const H = { Authorization: `Bearer ${owner.idToken}`, "Content-Type": "application/json" };
    try {
      const { householdId: hid } = await (await fetch(`${gw.url}/v1/households`, { method: "POST", headers: H, body: JSON.stringify({ name: "Home", currency: "USD", timezone: "UTC" }) })).json();
      const run = await (await fetch(`${gw.url}/v1/households/${hid}/agent/device-runs`, { method: "POST", headers: H, body: JSON.stringify({ message: "add milk to the list" }) })).json();
      const res = await fetch(`${gw.url}/v1/households/${hid}/agent/workflows/${run.workflowId}/model`, { method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
      expect(res.status).toBe(503);
      // No platform model and no member/household account: the app is told to connect one.
      expect((await res.json()).error.code).toBe("model_account_required");
      expect((await fetch(`${gw.url}/v1/households/${hid}/briefing`, { headers: H })).status).toBe(200);
    } finally { await gw.close(); }
  });
});

describe("scheduled agent jobs: device first, server fallback", () => {
  beforeEach(async () => { await clearFirestore(); });

  it("waits for the device during the grace period, never double-runs a claimed slot, then falls back", async () => {
    const gw = await listen(createGatewayApp({ ctx, hermes: () => null, enforceAppCheck: false }));
    const owner = await createUser(`job${Date.now()}@example.com`);
    const H = { Authorization: `Bearer ${owner.idToken}`, "Content-Type": "application/json" };
    try {
      const { householdId: hid } = await (await fetch(`${gw.url}/v1/households`, { method: "POST", headers: H, body: JSON.stringify({ name: "Home", currency: "USD", timezone: "UTC" }) })).json();
      const ref = ctx.db.doc(`households/${hid}/scheduledJobs/weekly_meal_planning`);
      await ref.update({ enabled: true, nextRunAt: Timestamp.fromDate(new Date(Date.now() - 60_000)) });
      const dispatched: string[] = [];
      const dispatch = async (_h: string, _o: string, _t: string, key: string) => { dispatched.push(key); return { status: "dispatched" }; };

      // Inside the grace period the server leaves the job for the phone.
      expect((await runDueJobs(ctx, { dispatchAgent: dispatch })).find((r) => r.job.startsWith("weekly"))!.status).toBe("waiting_for_device");
      // The phone claims it (once).
      const claim = await (await fetch(`${gw.url}/v1/households/${hid}/jobs/weekly_meal_planning/device-claim`, { method: "POST", headers: H })).json();
      expect(claim.claimed).toBe(true);
      expect(claim.message).toContain("meals");
      const again = await (await fetch(`${gw.url}/v1/households/${hid}/jobs/weekly_meal_planning/device-claim`, { method: "POST", headers: H })).json();
      expect(again.claimed).toBe(false);
      expect(dispatched).toEqual([]);

      // Next slot: the phone never shows up → after the grace period the server Hermes runs it.
      await ref.update({ nextRunAt: Timestamp.fromDate(new Date(Date.now() - 7 * 3600_000)) });
      const r = await runDueJobs(ctx, { dispatchAgent: dispatch });
      expect(r.find((x) => x.job.startsWith("weekly"))!.status).toBe("dispatched");
      expect(dispatched).toHaveLength(1);
    } finally { await gw.close(); }
  });
});
