import { randomBytes, timingSafeEqual } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { AppError, Ctx, getMembership, newId, paths, sha256, ts } from "../services/base";
import { recordAuditEvent } from "../services/auditEvents";
import { secretEnv } from "../core/env";

/**
 * OAuth 2.0 authorization server for Alexa account linking (Authorization Code grant).
 * Amazon's account-linking configuration points at:
 *   Authorization URI  {gateway}/oauth/alexa/authorize
 *   Access Token URI   {gateway}/oauth/alexa/token
 * Tokens are opaque random strings stored only as SHA-256 hashes. Access tokens last 1 h;
 * refresh tokens rotate on every use, and re-use of a spent refresh token revokes the link.
 */
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 180 * 86400;

export interface AlexaOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUris: string[]; // exact URIs from the Alexa developer console
  webApiKey: string; // Firebase Web API key for email/password sign-in (emulator: any)
  authEmulatorHost?: string;
}

export function alexaOAuthConfigFromEnv(): AlexaOAuthConfig | null {
  const clientId = process.env.ALEXA_OAUTH_CLIENT_ID, clientSecret = secretEnv("ALEXA_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return {
    clientId, clientSecret,
    redirectUris: (process.env.ALEXA_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    webApiKey: process.env.FIREBASE_WEB_API_KEY ?? "emulator", authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  };
}

function eq(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export interface AuthorizeParams { response_type?: string; client_id?: string; redirect_uri?: string; state?: string; scope?: string }

export function validateAuthorize(cfg: AlexaOAuthConfig, p: AuthorizeParams) {
  if (p.response_type !== "code") throw new AppError(400, "unsupported_response_type", "Only the authorization code flow is supported");
  if (!p.client_id || !eq(p.client_id, cfg.clientId)) throw new AppError(400, "invalid_client", "Unknown client");
  if (!p.redirect_uri || !cfg.redirectUris.includes(p.redirect_uri)) throw new AppError(400, "invalid_redirect_uri", "Redirect URI is not registered for this skill");
  if (!p.state || p.state.length > 1024) throw new AppError(400, "invalid_request", "state is required");
}

// ---------------- pages ----------------

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · HomeHub</title>
<style>:root{--canvas:#F6F7F2;--surface:#fff;--ink:#18231D;--ink2:#536158;--brand:#176B45;--on:#fff;--border:#DCE3DA;--danger:#B33B36}
@media (prefers-color-scheme:dark){:root{--canvas:#101713;--surface:#18221C;--ink:#F1F5EF;--ink2:#C0CCC2;--brand:#83C69A;--on:#0C2416;--border:#344238;--danger:#F08B83}}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.5 -apple-system,system-ui,Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:40px 20px}h1{font-size:26px;line-height:1.2;margin:0 0 6px}p{color:var(--ink2);margin:0 0 20px}
label{display:block;font-weight:600;font-size:14px;margin:16px 0 6px}input[type=email],input[type=password]{width:100%;min-height:48px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--ink);font-size:16px}
button{width:100%;min-height:48px;margin-top:24px;border:0;border-radius:12px;background:var(--brand);color:var(--on);font-size:16px;font-weight:600;cursor:pointer}
.card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:16px;margin:16px 0}.err{color:var(--danger);font-weight:600}
ul{padding-left:20px;margin:8px 0}li{margin:4px 0}.opt{display:flex;gap:10px;align-items:center;min-height:44px}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function signInPage(params: AuthorizeParams, error?: string): string {
  const hidden = (["client_id", "redirect_uri", "state", "scope", "response_type"] as const).map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] ?? "")}">`).join("");
  return page("Link HomeHub with Alexa", `<p>Sign in with your HomeHub account. You'll choose a household and see what Alexa can do before anything is linked.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="authorize" autocomplete="on">${hidden}<input type="hidden" name="step" value="signin">
<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password">
<button type="submit">Continue</button></form>`);
}

function consentPage(session: string, households: Array<{ id: string; name: string }>): string {
  const opts = households.map((h, i) => `<label class="opt"><input type="radio" name="householdId" value="${esc(h.id)}" ${i === 0 ? "checked" : ""} required> ${esc(h.name)}</label>`).join("");
  return page("Allow Alexa to use HomeHub?", `<div class="card"><strong>Alexa will be able to</strong><ul>
<li>See and control only the devices and rooms you mark as visible to Alexa</li>
<li>Read your shopping list, today's chores, tonight's dinner and your briefing</li>
<li>Add items to your shopping list after you confirm</li></ul>
<strong>Alexa will not</strong><ul><li>Unlock doors, disarm alarms, buy or pay for anything</li><li>Read out money, health or private details unless you turn that on</li></ul>
<p style="margin:8px 0 0">HomeHub doesn't store voice recordings. Disconnect any time in HomeHub → Settings → Gateway → Alexa.</p></div>
<form method="post" action="authorize"><input type="hidden" name="step" value="consent"><input type="hidden" name="session" value="${esc(session)}">
<fieldset style="border:0;padding:0"><legend style="font-weight:600">Household</legend>${opts}</fieldset>
<button type="submit">Allow and link</button></form>`);
}

// ---------------- flow ----------------

async function firebaseSignIn(cfg: AlexaOAuthConfig, email: string, password: string, fetchImpl: typeof fetch): Promise<string | null> {
  const base = cfg.authEmulatorHost ? `http://${cfg.authEmulatorHost}/identitytoolkit.googleapis.com` : "https://identitytoolkit.googleapis.com";
  const res = await fetchImpl(`${base}/v1/accounts:signInWithPassword?key=${encodeURIComponent(cfg.webApiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { localId?: string }).localId ?? null;
}

export type AuthorizeStepResult = { kind: "html"; status: number; html: string } | { kind: "redirect"; location: string };

export async function handleAuthorizePost(ctx: Ctx, cfg: AlexaOAuthConfig, body: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<AuthorizeStepResult> {
  if (body.step === "signin") {
    validateAuthorize(cfg, body);
    const uid = await firebaseSignIn(cfg, String(body.email ?? "").trim(), String(body.password ?? ""), fetchImpl);
    if (!uid) return { kind: "html", status: 401, html: signInPage(body, "Email or password is incorrect.") };
    const memberships = await ctx.db.collectionGroup("members").where("uid", "==", uid).where("status", "==", "active").get();
    const eligible = memberships.docs.filter((m) => ["owner", "admin", "adult"].includes(m.data().role));
    if (!eligible.length) return { kind: "html", status: 403, html: signInPage(body, "Only adults in a household can link Alexa.") };
    const households = await Promise.all(eligible.map(async (m) => {
      const hid = m.ref.parent.parent!.id;
      return { id: hid, name: (await ctx.db.doc(paths.household(hid)).get()).data()?.name ?? "Household" };
    }));
    const session = randomBytes(24).toString("base64url");
    await ctx.db.doc(`alexaAuthSessions/${sha256(session)}`).set({
      uid, households: households.map((h) => h.id), clientId: body.client_id, redirectUri: body.redirect_uri, state: body.state, scope: body.scope ?? "",
      expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 5 * 60_000)),
    });
    return { kind: "html", status: 200, html: consentPage(session, households) };
  }
  if (body.step === "consent") {
    const ref = ctx.db.doc(`alexaAuthSessions/${sha256(String(body.session ?? ""))}`);
    const s = await ctx.db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) return null; tx.delete(ref); return snap.data()!; });
    if (!s || s.expiresAt.toDate() < ctx.now()) return { kind: "html", status: 400, html: page("Link expired", "<p>Start linking again from the Alexa app.</p>") };
    if (!s.households.includes(body.householdId)) return { kind: "html", status: 403, html: page("Not allowed", "<p>You can't link that household.</p>") };
    const code = randomBytes(24).toString("base64url");
    await ctx.db.doc(`alexaAuthCodes/${sha256(code)}`).set({
      uid: s.uid, householdId: body.householdId, clientId: s.clientId, redirectUri: s.redirectUri, scope: s.scope,
      expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 5 * 60_000)),
    });
    const u = new URL(s.redirectUri);
    u.searchParams.set("code", code);
    u.searchParams.set("state", s.state);
    return { kind: "redirect", location: u.toString() };
  }
  return { kind: "html", status: 400, html: page("Something went wrong", "<p>Start linking again from the Alexa app.</p>") };
}

function clientAuth(cfg: AlexaOAuthConfig, authHeader: string | undefined, body: Record<string, string>): boolean {
  let id = body.client_id, secret = body.client_secret;
  if (authHeader?.startsWith("Basic ")) {
    const [u, p] = Buffer.from(authHeader.slice(6), "base64").toString("utf8").split(":");
    id = decodeURIComponent(u ?? ""); secret = decodeURIComponent(p ?? "");
  }
  return !!id && !!secret && eq(id, cfg.clientId) && eq(secret, cfg.clientSecret);
}

async function issueTokens(ctx: Ctx, linkId: string) {
  const access = `hha_${randomBytes(32).toString("base64url")}`;
  const refresh = `hhr_${randomBytes(32).toString("base64url")}`;
  const now = ctx.now().getTime();
  const batch = ctx.db.batch();
  batch.set(ctx.db.doc(`alexaTokens/${sha256(access)}`), { linkId, type: "access", revoked: false, expiresAt: Timestamp.fromMillis(now + ACCESS_TTL_S * 1000) });
  batch.set(ctx.db.doc(`alexaTokens/${sha256(refresh)}`), { linkId, type: "refresh", revoked: false, used: false, expiresAt: Timestamp.fromMillis(now + REFRESH_TTL_S * 1000) });
  await batch.commit();
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh };
}

/** RFC 6749 token endpoint. Errors use OAuth error codes in the JSON body. */
export async function handleToken(ctx: Ctx, cfg: AlexaOAuthConfig, authHeader: string | undefined, body: Record<string, string>) {
  if (!clientAuth(cfg, authHeader, body)) throw new AppError(401, "invalid_client", "Client authentication failed");
  if (body.grant_type === "authorization_code") {
    const ref = ctx.db.doc(`alexaAuthCodes/${sha256(String(body.code ?? ""))}`);
    const c = await ctx.db.runTransaction(async (tx) => { const s = await tx.get(ref); if (!s.exists) return null; tx.delete(ref); return s.data()!; });
    if (!c || c.expiresAt.toDate() < ctx.now()) throw new AppError(400, "invalid_grant", "Authorization code is invalid or expired");
    if (body.redirect_uri && body.redirect_uri !== c.redirectUri) throw new AppError(400, "invalid_grant", "redirect_uri mismatch");
    // One active link per member+household: re-linking replaces the old one.
    const old = await ctx.db.collection("alexaLinks").where("uid", "==", c.uid).where("householdId", "==", c.householdId).where("status", "==", "linked").get();
    for (const o of old.docs) await revokeLink(ctx, o.id, "relinked");
    const linkId = newId();
    await ctx.db.doc(`alexaLinks/${linkId}`).set({ uid: c.uid, householdId: c.householdId, status: "linked", scope: c.scope, createdAt: ts(ctx.now()), lastUsedAt: null, eventGateway: null });
    await ctx.db.doc(`${paths.col(c.householdId, "channels")}/alexa`).set({ householdId: c.householdId, status: "connected", lastActivityAt: ts(ctx.now()) }, { merge: true });
    await recordAuditEvent(ctx, c.householdId, { actorUid: c.uid, actorKind: "user", channel: "alexa", target: { type: "channel", id: "alexa" }, requestedAction: "alexa.linked", result: "succeeded" });
    return issueTokens(ctx, linkId);
  }
  if (body.grant_type === "refresh_token") {
    const ref = ctx.db.doc(`alexaTokens/${sha256(String(body.refresh_token ?? ""))}`);
    const t = await ctx.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const d = s.data()!;
      if (!d.used) tx.update(ref, { used: true });
      return d;
    });
    if (!t || t.type !== "refresh" || t.revoked || t.expiresAt.toDate() < ctx.now()) throw new AppError(400, "invalid_grant", "Refresh token is invalid");
    if (t.used) { await revokeLink(ctx, t.linkId, "refresh_token_reuse"); throw new AppError(400, "invalid_grant", "Refresh token was already used"); }
    const link = (await ctx.db.doc(`alexaLinks/${t.linkId}`).get()).data();
    if (!link || link.status !== "linked") throw new AppError(400, "invalid_grant", "Link was disconnected");
    return issueTokens(ctx, t.linkId);
  }
  throw new AppError(400, "unsupported_grant_type", "Unsupported grant_type");
}

export async function revokeLink(ctx: Ctx, linkId: string, reason: string) {
  const link = await ctx.db.doc(`alexaLinks/${linkId}`).get();
  if (!link.exists) return;
  const tokens = await ctx.db.collection("alexaTokens").where("linkId", "==", linkId).where("revoked", "==", false).get();
  const batch = ctx.db.batch();
  tokens.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  batch.update(link.ref, { status: "revoked", revokedAt: ts(ctx.now()), revokedReason: reason });
  await batch.commit();
  const hid = link.data()!.householdId;
  const remaining = await ctx.db.collection("alexaLinks").where("householdId", "==", hid).where("status", "==", "linked").get();
  if (remaining.empty) await ctx.db.doc(`${paths.col(hid, "channels")}/alexa`).set({ status: "disconnected" }, { merge: true });
  await recordAuditEvent(ctx, hid, { actorUid: link.data()!.uid, actorKind: "system", channel: "alexa", target: { type: "channel", id: "alexa" }, requestedAction: "alexa.unlinked", result: "succeeded", details: { reason } });
}

/** The member presses "Disconnect Alexa" in HomeHub. */
export async function disconnectAlexa(ctx: Ctx, uid: string, hid: string) {
  const links = await ctx.db.collection("alexaLinks").where("householdId", "==", hid).where("uid", "==", uid).where("status", "==", "linked").get();
  for (const l of links.docs) await revokeLink(ctx, l.id, "user_disconnected");
  return { revoked: links.size };
}

export interface AlexaPrincipal { linkId: string; uid: string; householdId: string; role: string }

/** Validates a bearer token from an Alexa request and re-checks membership every time. */
export async function resolveAlexaToken(ctx: Ctx, token: string | undefined): Promise<AlexaPrincipal> {
  if (!token || !token.startsWith("hha_")) throw new AppError(401, "INVALID_AUTHORIZATION_CREDENTIAL", "Missing or malformed token");
  const t = (await ctx.db.doc(`alexaTokens/${sha256(token)}`).get()).data();
  if (!t || t.type !== "access" || t.revoked) throw new AppError(401, "INVALID_AUTHORIZATION_CREDENTIAL", "Unknown or revoked token");
  if (t.expiresAt.toDate() <= ctx.now()) throw new AppError(401, "EXPIRED_AUTHORIZATION_CREDENTIAL", "Token expired");
  const link = (await ctx.db.doc(`alexaLinks/${t.linkId}`).get()).data();
  if (!link || link.status !== "linked") throw new AppError(401, "INVALID_AUTHORIZATION_CREDENTIAL", "Link was disconnected");
  const m = await getMembership(ctx, link.householdId, link.uid);
  if (!m || m.status !== "active" || !["owner", "admin", "adult"].includes(m.role)) throw new AppError(403, "INSUFFICIENT_PERMISSIONS", "This HomeHub member can no longer use Alexa");
  await ctx.db.doc(`alexaLinks/${t.linkId}`).update({ lastUsedAt: ts(ctx.now()) });
  return { linkId: t.linkId, uid: link.uid, householdId: link.householdId, role: m.role };
}
