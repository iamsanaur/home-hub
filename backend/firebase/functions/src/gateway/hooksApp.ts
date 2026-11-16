import express, { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { AppError, Ctx, invalid } from "../services/base";
import { receiveWebhook, RuntimeDeps } from "../plugins/runtime";
import { processEvent } from "../automations/automations";
import { authenticateBridge, pairBridge, pushBridgeState } from "../devices/devices";
import { rawBodyOf } from "../alexa/app";

/**
 * Public machine endpoints (separate Cloud Function, no Firebase ID token):
 *   POST /webhooks/:hid/:iid   signed inbound webhook → automation events
 *   POST /bridges/pair         one-time code → bridge credential
 *   POST /bridges/state        bridge credential → read-only device state
 * Each route authenticates with its own credential and is rate-bounded by payload limits.
 */
export function createHooksApp(ctx: Ctx, deps: RuntimeDeps = {}) {
  const app = express();
  app.disable("x-powered-by");
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

  app.post("/webhooks/:hid/:iid", express.raw({ type: "*/*", limit: "64kb" }), wrap(async (req, res) => {
    const hid = String(req.params.hid), iid = String(req.params.iid);
    const events = await receiveWebhook(ctx, hid, iid, { timestamp: req.header("x-homehub-timestamp"), signature: req.header("x-homehub-signature") }, rawBodyOf(req).toString("utf8"), deps);
    let runs = 0;
    for (const e of events) {
      runs += (await processEvent(ctx, hid, { type: "webhook", integrationId: iid, eventType: e.type, data: e.data, origin: { channel: "webhook" } })).length;
    }
    res.status(202).json({ accepted: events.length, automationsRun: runs });
  }));

  app.post("/bridges/pair", express.json({ limit: "4kb" }), wrap(async (req, res) => {
    const r = z.object({ code: z.string().regex(/^[0-9A-Fa-f]{12}$/) }).safeParse(req.body);
    if (!r.success) throw invalid("Invalid pairing code");
    res.status(201).json(await pairBridge(ctx, r.data.code.toUpperCase()));
  }));

  app.post("/bridges/state", express.json({ limit: "256kb" }), wrap(async (req, res) => {
    const header = req.header("authorization") ?? "";
    const credential = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    await authenticateBridge(ctx, credential); // fail fast before parsing a large payload
    const r = z.object({ devices: z.array(z.record(z.string(), z.unknown())).max(200) }).safeParse(req.body);
    if (!r.success) throw invalid("devices must be an array (max 200)");
    res.json(await pushBridgeState(ctx, credential, r.data.devices as never));
  }));

  app.use((_req: Request, res: Response) => res.status(404).json({ error: { code: "not_found" } }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) { res.status(err.status).json({ error: { code: err.code, message: err.message } }); return; }
    console.error("hooks error", err);
    res.status(500).json({ error: { code: "internal" } });
  });
  return app;
}
