import { describe, expect, it } from "vitest";
import { HermesClient, HermesUnavailableError, parseSse } from "../../src/agent/hermesClient";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { chunks.forEach((s) => c.enqueue(enc.encode(s))); c.close(); } });
}

describe("Hermes adapter (verified wire format)", () => {
  it("parses Hermes run SSE frames split across chunks and stops at terminal events", async () => {
    const frames = [
      ': keepalive\n\n',
      'data: {"event": "tool.started", "run_id": "run_1", "timestamp": 1, "tool": "mcp_homehub_list_tasks", "preview": ""}\n\n',
      'data: {"event": "message.delta", "run_id": "run_1", "timestamp": 2, "del',
      'ta": "Hello"}\n\n',
      'data: {"event": "run.completed", "run_id": "run_1", "timestamp": 3, "output": "Hello", "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}}\n\n',
      'data: {"event": "message.delta", "run_id": "run_1", "delta": "ignored"}\n\n',
    ];
    const events = [];
    for await (const e of parseSse(stream(frames))) events.push(e);
    expect(events.map((e) => e.event)).toEqual(["tool.started", "message.delta", "run.completed"]);
    expect((events[2] as { usage: { input_tokens: number } }).usage.input_tokens).toBe(10);
  });

  it("sends documented fields, bearer auth and Idempotency-Key", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ run_id: "run_9", status: "started" }), { status: 202, headers: { "Idempotency-Replayed": "true" } });
    }) as unknown as typeof fetch;
    const c = new HermesClient({ baseUrl: "http://hermes:8642", apiKey: "k" }, fake);
    const r = await c.createRun({ input: "hi", instructions: "sys", sessionId: "s1", model: "m", provider: "p", idempotencyKey: "idem-1" });
    expect(r).toEqual({ runId: "run_9", status: "started", replayed: true });
    expect(captured!.url).toBe("http://hermes:8642/v1/runs");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    expect(JSON.parse(captured!.init.body as string)).toEqual({ input: "hi", instructions: "sys", session_id: "s1", model: "m", provider: "p" });
  });

  it("maps network errors and 5xx to HermesUnavailableError", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(new HermesClient({ baseUrl: "http://x", apiKey: "k" }, down).createRun({ input: "a" })).rejects.toBeInstanceOf(HermesUnavailableError);
    const busy = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    await expect(new HermesClient({ baseUrl: "http://x", apiKey: "k" }, busy).createRun({ input: "a" })).rejects.toBeInstanceOf(HermesUnavailableError);
    expect(await new HermesClient({ baseUrl: "http://x", apiKey: "k" }, down).health()).toBe(false);
  });
});
