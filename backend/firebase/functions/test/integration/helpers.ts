import http from "node:http";
import { AddressInfo } from "node:net";
import express from "express";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Ctx } from "../../src/services/base";
import { handleMcpRequest } from "../../src/mcp/server";

export const PROJECT = "demo-homehub";

export function testCtx(now?: () => Date): Ctx {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run integration tests through `npm run emulators:test`");
  if (getApps().length === 0) initializeApp({ projectId: PROJECT });
  const db = getFirestore();
  try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already set */ }
  return { db, now: now ?? (() => new Date()) };
}

export async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}

/** Creates a user in the Auth emulator and returns a real Firebase ID token. */
export async function createUser(email: string, displayName = email.split("@")[0]): Promise<{ uid: string; idToken: string }> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", displayName, returnSecureToken: true }),
  });
  const json = (await res.json()) as { localId: string; idToken: string };
  // Mark email verified (emulator admin endpoint) so invitation email checks can pass.
  await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ localId: json.localId, emailVerified: true, displayName }),
  });
  const signIn = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", returnSecureToken: true }),
  });
  const s = (await signIn.json()) as { localId: string; idToken: string };
  return { uid: s.localId, idToken: s.idToken };
}

export async function listen(app: express.Express | http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app as http.RequestListener);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export const MCP_KEY = "test-mcp-service-key-0123456789abcdef";

export async function startMcp(ctx: Ctx) {
  process.env.HOMEHUB_MCP_SERVICE_KEY = MCP_KEY;
  const app = express();
  app.use(express.json());
  app.all("/mcp", (req, res) => { void handleMcpRequest(ctx, req, res); });
  return listen(app);
}

export async function mcpClient(url: string, key = MCP_KEY): Promise<Client> {
  const client = new Client({ name: "homehub-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  // The MCP SDK rejects schema-invalid arguments itself (JSON-RPC -32602) before our handler runs.
  if (res.isError && text.startsWith("MCP error")) return { ok: false, error: { code: "invalid_argument", message: text } };
  return JSON.parse(text) as { ok: boolean; data?: any; status?: string; approvalId?: string; error?: { code: string; message: string } };
}

/**
 * TEST DOUBLE for the Hermes Agent API server. It implements only the endpoints
 * and wire format HomeHub uses (verified against Hermes v0.21.2) and replaces the
 * LLM with a scripted "plan" that calls the real HomeHub MCP server over HTTP,
 * exactly as Hermes would after reading the grant from its instructions.
 * It is never used outside automated tests.
 */
export function fakeHermes(opts: {
  mcpUrl: string;
  script: (call: (tool: string, args: Record<string, unknown>) => Promise<any>, input: string) => Promise<string>;
  apiKey?: string;
  down?: boolean;
}) {
  const runs = new Map<string, { events: any[]; done: boolean; status: string; output?: string; usage?: any; listeners: Array<() => void> }>();
  const received: any[] = [];
  const app = express();
  app.use(express.json());
  const auth = (req: express.Request, res: express.Response) => {
    if (opts.down) { res.status(503).end(); return false; }
    if (req.header("authorization") !== `Bearer ${opts.apiKey ?? "hermes-test-key"}`) { res.status(401).end(); return false; }
    return true;
  };
  app.get("/health", (_req, res) => (opts.down ? res.status(503).end() : res.json({ status: "ok" })));
  app.post("/v1/runs", (req, res) => {
    if (!auth(req, res)) return;
    received.push({ body: req.body, idempotencyKey: req.header("idempotency-key") });
    const runId = `run_${received.length}`;
    const run = { events: [] as any[], done: false, status: "running", listeners: [] as Array<() => void> } as any;
    runs.set(runId, run);
    const push = (e: any) => { run.events.push({ run_id: runId, timestamp: Date.now() / 1000, ...e }); run.listeners.forEach((l: () => void) => l()); };
    const grant = String(req.body.instructions ?? "").split("\n").find((l: string) => l.startsWith("hhg_"));
    void (async () => {
      const client = await mcpClient(opts.mcpUrl);
      const call = async (tool: string, args: Record<string, unknown>) => {
        push({ event: "tool.started", tool: `mcp_homehub_${tool}`, preview: "" });
        const r = await callTool(client, tool, { grant, ...args });
        push({ event: "tool.completed", tool: `mcp_homehub_${tool}`, duration: 0.01, error: !r.ok && r.status !== "approval_required" });
        return r;
      };
      try {
        const output = await opts.script(call, req.body.input);
        for (const word of output.split(" ")) push({ event: "message.delta", delta: `${word} ` });
        run.status = "completed"; run.output = output; run.usage = { input_tokens: 1200, output_tokens: 180, total_tokens: 1380 };
        push({ event: "run.completed", output, usage: run.usage });
      } catch (err) {
        run.status = "failed";
        push({ event: "run.failed", error: (err as Error).message });
      } finally {
        run.done = true;
        await client.close();
        run.listeners.forEach((l: () => void) => l());
      }
    })();
    res.status(202).json({ run_id: runId, status: "started" });
  });
  app.get("/v1/runs/:id", (req, res) => {
    if (!auth(req, res)) return;
    const r = runs.get(req.params.id);
    if (!r) { res.status(404).end(); return; }
    res.json({ object: "hermes.run", run_id: req.params.id, status: r.status, output: r.output, usage: r.usage });
  });
  app.get("/v1/runs/:id/events", (req, res) => {
    if (!auth(req, res)) return;
    const r = runs.get(req.params.id);
    if (!r) { res.status(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let sent = 0;
    const flush = () => {
      while (sent < r.events.length) res.write(`data: ${JSON.stringify(r.events[sent++])}\n\n`);
      if (r.done) res.end();
    };
    r.listeners.push(flush);
    flush();
  });
  app.post("/v1/runs/:id/stop", (req, res) => {
    if (!auth(req, res)) return;
    res.json({ ok: true });
  });
  return { app, received };
}
