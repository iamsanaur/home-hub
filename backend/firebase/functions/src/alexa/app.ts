import express, { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError, Ctx } from "../services/base";
import { alexaOAuthConfigFromEnv, handleAuthorizePost, handleToken, signInPage, validateAuthorize } from "./oauth";
import { errorResponse, handleDirective, SmartHomeDeps } from "./smartHome";
import { AlexaVerificationError, verifyAlexaRequest, VerifyOptions } from "./signature";
import { handleCustomSkill } from "./customSkill";
import { secretEnv } from "../core/env";

/**
 * Public Alexa endpoints (separate Cloud Function, no Firebase ID token):
 *   GET/POST /oauth/authorize   account-linking sign-in + consent (server-rendered)
 *   POST     /oauth/token       code + refresh grants (client auth)
 *   POST     /smart-home        Smart Home directives, from the Lambda forwarder (HMAC)
 *   POST     /skill             custom skill requests, straight from Alexa (Amazon signature)
 */
export interface AlexaAppDeps {
  ctx: Ctx;
  forwarderSecret?: () => string | undefined;
  skillId?: () => string | undefined;
  smartHome?: SmartHomeDeps;
  verify?: Partial<VerifyOptions>;
  fetchImpl?: typeof fetch;
}

const FORWARDER_WINDOW_S = 300;

export function rawBodyOf(req: Request): Buffer {
  const r = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(r)) return r;
  if (Buffer.isBuffer(req.body)) return req.body;
  return Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
}

export function signForwarded(secret: string, timestamp: number, body: Buffer | string) {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

export function createAlexaApp(deps: AlexaAppDeps) {
  const { ctx } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
  const noStore = (res: Response) => res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'" });

  // ----- account linking -----
  app.get("/oauth/authorize", wrap(async (req, res) => {
    noStore(res);
    const cfg = alexaOAuthConfigFromEnv();
    if (!cfg) { res.status(503).type("html").send(signInPage({}, "Alexa linking isn't configured on this HomeHub server yet.")); return; }
    const params = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    // An invalid client/redirect is never redirected to (open-redirect protection).
    try { validateAuthorize(cfg, params); }
    catch (e) { res.status(400).type("html").send(signInPage({}, e instanceof AppError ? e.message : "Invalid request")); return; }
    res.type("html").send(signInPage(params));
  }));
  app.post("/oauth/authorize", express.urlencoded({ extended: false, limit: "8kb" }), wrap(async (req, res) => {
    noStore(res);
    const cfg = alexaOAuthConfigFromEnv();
    if (!cfg) { res.status(503).type("html").send(signInPage({}, "Alexa linking isn't configured.")); return; }
    const r = await handleAuthorizePost(ctx, cfg, req.body ?? {}, deps.fetchImpl);
    if (r.kind === "redirect") res.redirect(302, r.location);
    else res.status(r.status).type("html").send(r.html);
  }));
  app.post("/oauth/token", express.urlencoded({ extended: false, limit: "8kb" }), express.json({ limit: "8kb" }), wrap(async (req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    const cfg = alexaOAuthConfigFromEnv();
    if (!cfg) { res.status(503).json({ error: "temporarily_unavailable" }); return; }
    try {
      res.json(await handleToken(ctx, cfg, req.header("authorization"), req.body ?? {}));
    } catch (e) {
      if (e instanceof AppError) { res.status(e.status).json({ error: e.code, error_description: e.message }); return; }
      throw e;
    }
  }));

  // ----- Smart Home (via Lambda forwarder) -----
  app.post("/smart-home", express.raw({ type: "*/*", limit: "256kb" }), wrap(async (req, res) => {
    const secret = deps.forwarderSecret?.() ?? secretEnv("ALEXA_FORWARDER_SECRET");
    const raw = rawBodyOf(req);
    const t = Number(req.header("x-homehub-forwarder-timestamp"));
    const sig = Buffer.from(String(req.header("x-homehub-forwarder-signature") ?? ""));
    if (!secret || !Number.isInteger(t) || Math.abs(ctx.now().getTime() / 1000 - t) > FORWARDER_WINDOW_S) { res.status(401).json({ error: "unauthorized" }); return; }
    const expected = Buffer.from(signForwarded(secret, t, raw));
    if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) { res.status(401).json({ error: "unauthorized" }); return; }
    let body: { directive?: never };
    try { body = JSON.parse(raw.toString("utf8")); } catch { res.json(errorResponse(undefined, "INVALID_DIRECTIVE", "Malformed directive")); return; }
    res.json(await handleDirective(ctx, body, deps.smartHome));
  }));

  // ----- custom skill (HTTPS endpoint, Amazon-signed) -----
  app.post("/skill", express.raw({ type: "*/*", limit: "256kb" }), wrap(async (req, res) => {
    const skillId = deps.skillId?.() ?? process.env.ALEXA_SKILL_ID;
    if (!skillId) { res.status(503).json({ error: "not_configured" }); return; }
    let body: Record<string, unknown>;
    try {
      body = await verifyAlexaRequest(req.headers, rawBodyOf(req), { skillId, ...deps.verify, now: deps.verify?.now ?? ctx.now() });
    } catch (e) {
      if (e instanceof AlexaVerificationError) { res.status(400).json({ error: "verification_failed" }); return; }
      throw e;
    }
    res.json(await handleCustomSkill(ctx, body));
  }));

  app.use((_req: Request, res: Response) => res.status(404).json({ error: "not_found" }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) { res.status(err.status).json({ error: err.code, message: err.message }); return; }
    console.error("alexa error", err);
    res.status(500).json({ error: "internal" });
  });
  return app;
}
