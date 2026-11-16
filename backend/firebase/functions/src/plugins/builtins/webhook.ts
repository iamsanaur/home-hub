import { createHmac } from "node:crypto";
import { definePlugin } from "../sdk";

/**
 * Custom signed webhook connector (addendum §4.H). Outbound: POSTs a JSON event to the
 * user's https endpoint, signed with HMAC-SHA256 over `${timestamp}.${body}`. Sending data
 * outside HomeHub always needs approval. Inbound: the Gateway verifies the signature and
 * replay window before the payload reaches onEvent; the payload is treated as data.
 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export const webhook = definePlugin({
  manifest: {
    manifestVersion: 1, id: "homehub.webhook", name: "Signed webhook", publisher: "HomeHub", tier: "first_party", supportLevel: "custom",
    version: "1.0.0", category: "developer", icon: "link",
    description: "Send HomeHub events to your own https endpoint and receive signed events that can trigger automations.",
    regions: ["*"], languages: ["en"], platforms: ["server"], minApiVersion: 1,
    auth: { method: "webhook_signature", scopes: [] }, dataCategories: ["event payloads you choose to send"],
    tools: [{
      name: "send_event", description: "POST a signed JSON event to your endpoint",
      input: { type: "object", properties: { type: { type: "string", maxLength: 64 }, data: { type: "object" } }, required: ["type"], additionalProperties: false },
      access: "write", risk: "high", idempotent: false, confirmation: "approval", physicalSafety: false,
    }],
    events: ["webhook.received"],
    lifecycle: { setup: false, healthCheck: true, disconnect: false, refreshCredentials: false, deleteData: false },
    network: [], userNetworkFields: ["outboundUrl"],
    privacy: { retention: "HomeHub keeps delivery metadata (status, time) for 30 days; payloads are not stored.", support: "HomeHub support" },
    config: [
      { key: "outboundUrl", label: "Your endpoint (https)", type: "url", required: false, secret: false },
      { key: "signingSecret", label: "Signing secret", type: "string", required: true, secret: true, help: "Shared secret used to sign and verify webhooks." },
    ],
  },
  handlers: {
    async healthCheck(ctx) {
      return (await ctx.secret("signingSecret")) ? { ok: true } : { ok: false, message: "Signing secret missing" };
    },
    tools: {
      send_event: async (ctx, input) => {
        const url = String(ctx.config.outboundUrl ?? "");
        if (!url) throw new Error("No outbound endpoint configured");
        const secret = (await ctx.secret("signingSecret")) ?? "";
        const body = JSON.stringify({ type: input.type, data: input.data ?? {}, householdId: ctx.householdId, sentAt: ctx.now().toISOString() });
        const t = Math.floor(ctx.now().getTime() / 1000);
        const res = await ctx.fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-HomeHub-Timestamp": String(t), "X-HomeHub-Signature": signWebhook(secret, t, body) }, body });
        return { delivered: res.ok, status: res.status };
      },
    },
    async onEvent(_ctx, topic, payload) {
      const p = (payload ?? {}) as Record<string, unknown>;
      return { events: [{ type: `webhook.${String(p.type ?? topic).replace(/[^a-z0-9_.]/gi, "_").slice(0, 60)}`, data: (typeof p.data === "object" && p.data ? p.data : {}) as Record<string, unknown> }] };
    },
  },
});
