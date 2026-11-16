import { definePlugin, HomeHubPlugin } from "../sdk";

/**
 * "Bring your own model account" (addendum §4.G). Each provider is a plugin whose only
 * job is to hold the member's credential (in Secret Manager) and report the models it can
 * use. The model proxy uses the connected account instead of the platform key.
 *
 * Connection methods (verified against provider docs, Nov 2026):
 *  - OpenRouter: OAuth PKCE → user-controlled API key billed to the user's own credits.
 *  - Others: API key pasted by the user (no documented third-party OAuth for end users).
 * Base URLs are each provider's OpenAI-compatible endpoint; they are config defaults and can
 * be overridden per account if a provider changes them.
 */
interface ProviderDef { id: string; name: string; baseUrl: string; host: string; method: "oauth_pkce" | "api_key"; description: string; docs: string }

export const PROVIDERS: ProviderDef[] = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", host: "https://openrouter.ai", method: "oauth_pkce",
    description: "Sign in with your OpenRouter account. One account reaches models from Anthropic, OpenAI, Google, Meta and more; usage is billed to your OpenRouter credits.",
    docs: "https://openrouter.ai/docs/guides/overview/auth/oauth" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", host: "https://api.openai.com", method: "api_key", description: "Use your OpenAI API key.", docs: "https://platform.openai.com/docs" },
  { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", host: "https://generativelanguage.googleapis.com", method: "api_key", description: "Use a Gemini API key from Google AI Studio.", docs: "https://ai.google.dev/gemini-api/docs" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", host: "https://api.groq.com", method: "api_key", description: "Use your Groq API key.", docs: "https://console.groq.com/docs" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", host: "https://api.mistral.ai", method: "api_key", description: "Use your Mistral API key.", docs: "https://docs.mistral.ai" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", host: "https://api.deepseek.com", method: "api_key", description: "Use your DeepSeek API key.", docs: "https://api-docs.deepseek.com" },
  { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", host: "https://api.together.xyz", method: "api_key", description: "Use your Together AI API key.", docs: "https://docs.together.ai" },
];

function providerPlugin(p: ProviderDef): HomeHubPlugin {
  return definePlugin({
    manifest: {
      manifestVersion: 1, id: `ai.${p.id}`, name: p.name, publisher: p.name, tier: "verified_partner", supportLevel: "official_api",
      version: "1.0.0", category: "ai_provider", icon: "sparkles", description: p.description, docsUrl: p.docs,
      regions: ["*"], languages: ["en"], platforms: ["server"], minApiVersion: 1,
      auth: { method: p.method, scopes: [] },
      dataCategories: ["messages you send to the assistant", "compact household context for each request"],
      tools: [{ name: "list_models", description: "Models this account can use", input: { type: "object", properties: {}, additionalProperties: false }, access: "read", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false }],
      events: [],
      lifecycle: { setup: false, healthCheck: true, disconnect: true, refreshCredentials: false, deleteData: false },
      network: [p.host], userNetworkFields: [],
      privacy: { retention: `Requests are processed by ${p.name} under your account and its terms. HomeHub stores only token counts.`, support: p.docs },
      config: [
        { key: "baseUrl", label: "API base URL", type: "url", required: false, secret: false, help: `Default ${p.baseUrl}` },
        { key: "apiKey", label: p.method === "oauth_pkce" ? "API key (set by sign-in)" : "API key", type: "string", required: true, secret: true },
        { key: "modelSimple", label: "Model for quick requests", type: "string", required: false, secret: false },
        { key: "modelComplex", label: "Model for planning", type: "string", required: false, secret: false },
      ],
    },
    handlers: {
      async healthCheck(ctx) {
        const key = await ctx.secret("apiKey");
        if (!key) return { ok: false, message: "Not signed in" };
        const res = await ctx.fetch(`${String(ctx.config.baseUrl || p.baseUrl)}/models`, { headers: { Authorization: `Bearer ${key}` } });
        return res.ok ? { ok: true } : { ok: false, message: res.status === 401 ? "The key was rejected — reconnect the account." : `Provider returned ${res.status}` };
      },
      async disconnect() { /* key is deleted from Secret Manager by the runtime; user can also revoke it at the provider */ },
      tools: {
        list_models: async (ctx) => {
          const key = await ctx.secret("apiKey");
          const res = await ctx.fetch(`${String(ctx.config.baseUrl || p.baseUrl)}/models`, { headers: { Authorization: `Bearer ${key}` } });
          if (!res.ok) throw new Error(`Provider returned ${res.status}`);
          const json = (await res.json()) as { data?: Array<{ id: string; name?: string; context_length?: number }> };
          return { models: (json.data ?? []).slice(0, 300).map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length ?? null })) };
        },
      },
    },
  });
}

export const aiProviderPlugins = PROVIDERS.map(providerPlugin);
export function providerFor(pluginId: string) { return PROVIDERS.find((p) => `ai.${p.id}` === pluginId); }
