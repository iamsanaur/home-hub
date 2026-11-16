import { describe, expect, it } from "vitest";
import { postWithRetry } from "../../src/agent/modelProxy";

const reply = (status: number, headers: Record<string, string> = {}) => new Response(status === 200 ? "data: {}\n\n" : "{}", { status, headers });
const run = (statuses: Array<[number, Record<string, string>?]>, extra: Record<string, unknown> = {}) => {
  const seen: Array<{ model: unknown }> = [], waits: number[] = [];
  let i = 0;
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    seen.push({ model: JSON.parse(String(init?.body)).model });
    const [s, h] = statuses[Math.min(i++, statuses.length - 1)];
    return reply(s, h);
  }) as typeof fetch;
  const call = postWithRetry({ baseUrl: "https://p.example/v1", apiKey: "k", fetchImpl, sleep: async (ms) => { waits.push(ms); }, ...extra }, { model: "main", messages: [] }, new AbortController().signal);
  return { call, seen, waits };
};

describe("model proxy retries", () => {
  it("returns immediately on success", async () => {
    const t = run([[200]]);
    const r = await t.call;
    expect(r.response.status).toBe(200); expect(t.seen).toHaveLength(1); expect(t.waits).toHaveLength(0);
  });
  it("retries a 429 and recovers, honoring Retry-After (capped)", async () => {
    const t = run([[429, { "retry-after": "2" }], [429, { "retry-after": "60" }], [200]]);
    const r = await t.call;
    expect(r.response.status).toBe(200); expect(r.attempts).toBe(3);
    expect(t.waits[0]).toBeGreaterThanOrEqual(2000); expect(t.waits[0]).toBeLessThan(2300);
    expect(t.waits[1]).toBeLessThanOrEqual(4250); // 60 s capped at 4 s (+ jitter)
  });
  it("gives up after three attempts when there is no fallback", async () => {
    const t = run([[429]]);
    const r = await t.call;
    expect(r.response.status).toBe(429); expect(t.seen).toHaveLength(3);
  });
  it("falls back to the other model once, and never retries client errors", async () => {
    const t = run([[429], [429], [429], [200]], { fallbackModel: "backup" });
    const r = await t.call;
    expect(r.response.status).toBe(200); expect(r.model).toBe("backup");
    expect(t.seen.map((s) => s.model)).toEqual(["main", "main", "main", "backup"]);
    const bad = run([[400]]);
    expect((await bad.call).response.status).toBe(400); expect(bad.seen).toHaveLength(1);
  });
});
