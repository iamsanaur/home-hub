/**
 * HomeHub → Hermes Agent adapter.
 *
 * Verified against Hermes Agent v0.21.2 (commit 5eb99eb2), API server docs
 * (website/docs/user-guide/features/api-server.md) and implementation
 * (gateway/platforms/api_server_runs.py):
 *
 *   POST /v1/runs                  {input, instructions?, session_id?, model?, provider?}
 *                                  header Idempotency-Key (optional) → {run_id, status}
 *   GET  /v1/runs/{id}             → {object:"hermes.run", run_id, status, output?, usage?}
 *   GET  /v1/runs/{id}/events      SSE; each frame `data: {"event": <name>, "run_id", "timestamp", ...}`
 *        events: message.delta{delta} · tool.started{tool,preview} · tool.completed{tool,duration,error}
 *                reasoning.available{text} · run.completed{output,usage} · run.failed{error} · run.cancelled
 *   POST /v1/runs/{id}/stop
 *   GET  /health
 *   Auth: `Authorization: Bearer <API_SERVER_KEY>`
 *
 * The Hermes API key lives only in server-side secrets; it never reaches clients.
 */
import { secretEnv } from "../core/env";
export interface HermesConfig {
  baseUrl: string; // e.g. http://127.0.0.1:8642
  apiKey: string;
  timeoutMs?: number;
}

export interface HermesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
}

export type HermesEvent =
  | { event: "message.delta"; run_id: string; delta: string }
  | { event: "tool.started"; run_id: string; tool: string; preview?: string }
  | { event: "tool.completed"; run_id: string; tool: string; duration?: number; error?: boolean }
  | { event: "reasoning.available"; run_id: string; text: string }
  | { event: "run.completed"; run_id: string; output?: string; usage?: HermesUsage }
  | { event: "run.failed"; run_id: string; error?: string }
  | { event: "run.cancelled"; run_id: string }
  | { event: string; run_id: string; [k: string]: unknown };

export class HermesUnavailableError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

export interface CreateRunRequest {
  input: string;
  instructions?: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  idempotencyKey?: string;
}

export class HermesClient {
  constructor(private readonly cfg: HermesConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  static fromEnv(): HermesClient | null {
    const baseUrl = process.env.HERMES_API_URL;
    const apiKey = secretEnv("HERMES_API_KEY");
    if (!baseUrl || !apiKey) return null;
    return new HermesClient({ baseUrl: baseUrl.replace(/\/$/, ""), apiKey, timeoutMs: Number(process.env.HERMES_TIMEOUT_MS ?? 15000) });
  }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json", ...extra };
  }

  private async request(path: string, init: RequestInit, timeoutMs = this.cfg.timeoutMs ?? 15000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, { ...init, signal: ctrl.signal });
      return res;
    } catch (err) {
      throw new HermesUnavailableError(`Hermes is unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.request("/health", { method: "GET" }, 3000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async createRun(req: CreateRunRequest): Promise<{ runId: string; status: string; replayed: boolean }> {
    const body: Record<string, unknown> = { input: req.input };
    if (req.instructions) body.instructions = req.instructions;
    if (req.sessionId) body.session_id = req.sessionId;
    if (req.model) body.model = req.model;
    if (req.provider) body.provider = req.provider;
    const headers = this.headers(req.idempotencyKey ? { "Idempotency-Key": req.idempotencyKey } : {});
    const res = await this.request("/v1/runs", { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status >= 500 || res.status === 429) throw new HermesUnavailableError(`Hermes returned ${res.status}`, res.status);
    if (!res.ok) throw new Error(`Hermes rejected the run (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { run_id: string; status: string };
    return { runId: json.run_id, status: json.status, replayed: res.headers.get("Idempotency-Replayed") === "true" };
  }

  async getRun(runId: string): Promise<{ status: string; output?: string; usage?: HermesUsage; error?: string }> {
    const res = await this.request(`/v1/runs/${encodeURIComponent(runId)}`, { method: "GET", headers: this.headers() });
    if (!res.ok) throw new HermesUnavailableError(`Hermes run status failed (${res.status})`, res.status);
    return (await res.json()) as { status: string; output?: string; usage?: HermesUsage };
  }

  async stopRun(runId: string): Promise<void> {
    const res = await this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`Hermes stop failed (${res.status})`);
  }

  /** Stream run events. Resolves when the stream closes or a terminal event arrives. */
  async *events(runId: string, signal?: AbortSignal): AsyncGenerator<HermesEvent> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
        method: "GET", headers: { ...this.headers(), Accept: "text/event-stream" }, signal,
      });
    } catch (err) {
      throw new HermesUnavailableError(`Hermes event stream failed: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) throw new HermesUnavailableError(`Hermes event stream returned ${res.status}`, res.status);
    yield* parseSse(res.body);
  }
}

/** Minimal SSE parser: handles `data:` frames (multi-line), ignores comments/keepalives. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<HermesEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          const ev = JSON.parse(data) as HermesEvent;
          yield ev;
          if (ev.event === "run.completed" || ev.event === "run.failed" || ev.event === "run.cancelled") return;
        } catch {
          // ignore malformed frame
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
