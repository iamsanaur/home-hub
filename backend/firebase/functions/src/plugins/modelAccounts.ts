import { createHash, randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { Actor, AppError, Ctx, forbidden, getMembership, invalid, paths, sha256, ts } from "../services/base";
import { connectIntegration, RuntimeDeps } from "./runtime";
import { providerFor } from "./builtins/aiProviders";
import { defaultSecretStore } from "./secrets";
import type { ModelProxyConfig } from "../agent/modelProxy";

/**
 * Bring-your-own model accounts.
 *
 * OpenRouter sign-in (OAuth PKCE, per https://openrouter.ai/docs/guides/overview/auth/oauth):
 *   1. app → POST /v1/households/:hid/model-accounts/openrouter/start → { authUrl }
 *   2. app opens authUrl in the system browser (Custom Tabs / ASWebAuthenticationSession)
 *   3. OpenRouter → GET {gateway}/oauth/providers/openrouter/callback?code&state
 *   4. server: POST https://openrouter.ai/api/v1/auth/keys {code, code_verifier, code_challenge_method:"S256"} → {key}
 *   5. key stored in Secret Manager; browser redirected to homehub://model-accounts?status=connected
 * The verifier never leaves the server; the key never reaches the phone.
 */
const OPENROUTER_ORIGIN = () => process.env.OPENROUTER_ORIGIN ?? "https://openrouter.ai";
export const publicGatewayUrl = () => (process.env.PUBLIC_GATEWAY_URL ?? "http://localhost:5001/demo-homehub/asia-south1/api").replace(/\/$/, "");

const b64url = (b: Buffer) => b.toString("base64url");

export async function startProviderOAuth(ctx: Ctx, actor: Actor, hid: string, provider: string, scope: "personal" | "household") {
  if (provider !== "openrouter") throw invalid("Sign-in is only available for OpenRouter; other providers use an API key");
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || m.status !== "active" || !["owner", "admin", "adult"].includes(m.role)) throw forbidden("Only adults can connect a model account");
  if (scope === "household" && !["owner", "admin"].includes(m.role)) throw forbidden("Only managers can connect a household model account");
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  await ctx.db.doc(`oauthStates/${sha256(state)}`).set({
    householdId: hid, uid: actor.uid, provider, scope, verifier, createdAt: ts(ctx.now()),
    expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 10 * 60_000)), // OpenRouter codes expire after 10 minutes
  });
  const callback = `${publicGatewayUrl()}/oauth/providers/openrouter/callback`;
  const url = new URL(`${OPENROUTER_ORIGIN()}/auth`);
  url.searchParams.set("callback_url", callback);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("key_label", "HomeHub");
  return { authUrl: url.toString(), expiresInSeconds: 600 };
}

export async function completeProviderOAuth(ctx: Ctx, code: string | undefined, state: string | undefined, deps: RuntimeDeps = {}) {
  if (!code || !state) throw invalid("Missing code or state");
  const ref = ctx.db.doc(`oauthStates/${sha256(state)}`);
  const s = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref); // single use
    return snap.data()!;
  });
  if (!s) throw new AppError(400, "invalid_state", "This sign-in link is invalid or was already used");
  if (s.expiresAt.toDate() < ctx.now()) throw new AppError(410, "expired", "The sign-in took too long — try again");
  const res = await (deps.fetchImpl ?? fetch)(`${OPENROUTER_ORIGIN()}/api/v1/auth/keys`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: s.verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) throw new AppError(502, "oauth_exchange_failed", res.status === 403 ? "OpenRouter rejected the sign-in code" : `OpenRouter returned ${res.status}`);
  const { key } = (await res.json()) as { key?: string };
  if (!key) throw new AppError(502, "oauth_exchange_failed", "OpenRouter didn't return a key");
  const actor: Actor = { uid: s.uid, kind: "user" };
  const r = await connectIntegration(ctx, actor, s.householdId, { pluginId: "ai.openrouter", secrets: { apiKey: key }, scope: s.scope, consent: true }, deps);
  // First account becomes the default for its scope.
  const integ = ctx.db.doc(`${paths.col(s.householdId, "integrations")}/${r.integrationId}`);
  const existing = await ctx.db.collection(paths.col(s.householdId, "integrations")).where("category", "==", "ai_provider").where("scope", "==", s.scope).where("isDefault", "==", true).get();
  const sameOwner = existing.docs.filter((d) => s.scope === "household" || d.data().ownerUid === s.uid);
  if (sameOwner.length === 0) await integ.update({ isDefault: true });
  return { householdId: s.householdId, integrationId: r.integrationId, status: r.status };
}

export interface ResolvedModel {
  cfg: ModelProxyConfig;
  label: string;
  source: "personal" | "household" | "platform";
  integrationId: string | null;
}

/** Which model account serves this user's request. Never silently switches provider. */
export async function resolveModelAccount(ctx: Ctx, hid: string, uid: string, platform: ModelProxyConfig | null): Promise<ResolvedModel | null> {
  const col = ctx.db.collection(paths.col(hid, "integrations"));
  const personal = await col.where("category", "==", "ai_provider").where("scope", "==", "personal").where("ownerUid", "==", uid).where("isDefault", "==", true).where("status", "==", "connected").limit(1).get();
  const household = personal.empty ? await col.where("category", "==", "ai_provider").where("scope", "==", "household").where("isDefault", "==", true).where("status", "==", "connected").limit(1).get() : null;
  const doc = !personal.empty ? personal.docs[0] : household && !household.empty ? household.docs[0] : null;
  if (!doc) return platform ? { cfg: platform, label: "HomeHub default model", source: "platform", integrationId: null } : null;
  const d = doc.data();
  const p = providerFor(d.pluginId);
  if (!p) return null;
  const refs = (await ctx.db.doc(`${paths.col(hid, "integrationSecretsRefs")}/${doc.id}`).get()).data()?.refs ?? {};
  const apiKey = refs.apiKey ? await defaultSecretStore(ctx).get(refs.apiKey) : null;
  if (!apiKey) return null;
  const simple = (d.config?.modelSimple as string) || defaultModel(p.id, "simple");
  const complex = (d.config?.modelComplex as string) || (d.config?.modelSimple as string) || defaultModel(p.id, "complex");
  return {
    cfg: {
      baseUrl: String(d.config?.baseUrl || p.baseUrl).replace(/\/$/, ""), apiKey, modelSimple: simple, modelComplex: complex,
      maxCallsPerWorkflow: platform?.maxCallsPerWorkflow ?? 16, maxTokensPerWorkflow: platform?.maxTokensPerWorkflow ?? 120000,
    },
    label: `${p.name} (${!personal.empty ? "your account" : "household account"})`,
    source: !personal.empty ? "personal" : "household",
    integrationId: doc.id,
  };
}

/** Conservative defaults when the user hasn't picked models; they can change them in Settings. */
function defaultModel(provider: string, tier: "simple" | "complex"): string {
  const d: Record<string, [string, string]> = {
    openrouter: ["openrouter/auto", "openrouter/auto"],
    openai: ["gpt-4o-mini", "gpt-4o"],
    gemini: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
    groq: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
    mistral: ["mistral-small-latest", "mistral-large-latest"],
    deepseek: ["deepseek-chat", "deepseek-chat"],
    together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  };
  return (d[provider] ?? ["", ""])[tier === "simple" ? 0 : 1];
}

export function oauthResultPage(ok: boolean, message: string): string {
  const target = `homehub://model-accounts?status=${ok ? "connected" : "failed"}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HomeHub</title>
<style>body{font-family:-apple-system,system-ui,Roboto,sans-serif;background:#F6F7F2;color:#18231D;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
main{max-width:420px;text-align:center}a{display:inline-block;margin-top:16px;padding:14px 22px;border-radius:12px;background:#176B45;color:#fff;text-decoration:none;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#101713;color:#F1F5EF}a{background:#83C69A;color:#0C2416}}</style>
<meta http-equiv="refresh" content="0;url=${target}"></head><body><main><h1>${ok ? "Account connected" : "Couldn't connect"}</h1><p>${message.replace(/[<>&]/g, "")}</p><a href="${target}">Return to HomeHub</a></main></body></html>`;
}
