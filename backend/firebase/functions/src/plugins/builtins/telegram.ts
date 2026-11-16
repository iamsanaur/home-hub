import { definePlugin, PluginContext } from "../sdk";

/**
 * Telegram bot channel. Outbound only: HomeHub can post a message to ONE chat (a family group or a person) through a
 * bot the household created with @BotFather. Sending a message outside HomeHub always needs approval, so the assistant
 * proposes the text and a person approves it. Verified against the Telegram Bot API: getMe, sendMessage.
 * The bot token lives in Secret Manager and is never put in an error message or log.
 */
const MAX_TEXT = 4000; // Telegram allows 4096 characters per message.

async function api(ctx: PluginContext, method: string, body?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const token = await ctx.secret("botToken");
  if (!token) throw new Error("Telegram bot token is missing");
  const res = await ctx.fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  if (res.status === 401 || res.status === 404) throw new Error("Telegram rejected the bot token");
  return { ok: !!json.ok, result: json.result, description: json.description };
}

export const telegram = definePlugin({
  manifest: {
    manifestVersion: 1, id: "homehub.telegram", name: "Telegram bot", publisher: "HomeHub", tier: "first_party", supportLevel: "official_api",
    version: "1.0.0", category: "channels", icon: "paperplane",
    description: "Post HomeHub updates (reminders, grocery lists, approvals) to a Telegram chat through your own bot. Every message needs approval.",
    docsUrl: "https://core.telegram.org/bots/api",
    regions: ["*"], languages: ["en"], platforms: ["server"], minApiVersion: 1,
    auth: { method: "api_key", scopes: [] }, dataCategories: ["message text you approve"],
    tools: [{
      name: "send_message", description: "Send a text message to the configured Telegram chat",
      input: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MAX_TEXT } }, required: ["text"], additionalProperties: false },
      access: "write", risk: "high", idempotent: false, confirmation: "approval", physicalSafety: false,
    }],
    events: [],
    lifecycle: { setup: false, healthCheck: true, disconnect: false, refreshCredentials: false, deleteData: false },
    network: ["https://api.telegram.org"], userNetworkFields: [],
    privacy: { policyUrl: "https://telegram.org/privacy", retention: "HomeHub keeps delivery metadata (status, time) for 30 days; message text is not stored.", support: "HomeHub support" },
    config: [
      { key: "botToken", label: "Bot token", type: "string", required: true, secret: true, help: "From @BotFather after /newbot." },
      { key: "chatId", label: "Chat ID", type: "string", required: true, secret: false, help: "The group or person to message. Add the bot to the group first." },
    ],
  },
  handlers: {
    async healthCheck(ctx) {
      try {
        const r = await api(ctx, "getMe");
        return r.ok ? { ok: true } : { ok: false, message: r.description ?? "Telegram did not accept the request" };
      } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Could not reach Telegram" }; }
    },
    tools: {
      send_message: async (ctx, input) => {
        const chatId = String(ctx.config.chatId ?? "").trim();
        if (!/^-?\d+$|^@[A-Za-z0-9_]{5,}$/.test(chatId)) throw new Error("Chat ID must be a number (or @channelname)");
        const text = String(input.text ?? "").slice(0, MAX_TEXT);
        if (!text.trim()) throw new Error("Message is empty");
        const r = await api(ctx, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
        if (!r.ok) throw new Error(`Telegram: ${r.description ?? "message not sent"}`);
        return { delivered: true };
      },
    },
  },
});
