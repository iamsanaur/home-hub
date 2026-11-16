import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { Actor, AppError, Ctx, forbidden, getMembership, invalid, newId, notFound, paths, sha256, ts } from "../services/base";
import { recordAuditEvent, Channel } from "../services/auditEvents";
import type { Capability, DeviceState, ReportedDevice } from "../plugins/sdk";

/**
 * HomeHub devices. Documents are written only by the server (from plugins/bridges), so a
 * device's reported state can't be forged by a client. Actions go through the owning
 * integration's typed tools under the device safety policy, and success is reported only
 * after the device state is re-read and matches.
 */
export type DeviceAction =
  | { type: "power"; value: "ON" | "OFF" }
  | { type: "brightness"; value: number }
  | { type: "thermostat"; targetTemperature?: number; mode?: DeviceState["thermostatMode"] }
  | { type: "lock" }
  | { type: "unlock" };

/** Device event hook (automations, Alexa change reports) — set by the gateway to avoid import cycles. */
export const deviceHooks: { onStateChanged?: (ctx: Ctx, hid: string, deviceId: string, changed: Partial<DeviceState>, origin: EventOrigin) => Promise<void> } = {};
export interface EventOrigin { channel: Channel; automationChain?: string[] }

const PHYSICAL_SAFETY_TYPES = new Set(["lock", "garage", "alarm", "oven", "heater", "cooktop", "water_valve"]);

export async function upsertDeviceFromPlugin(ctx: Ctx, hid: string, iid: string, pluginId: string, d: ReportedDevice, origin: EventOrigin = { channel: "system" }) {
  const id = sha256(`${iid}:${d.externalId}`).slice(0, 24);
  const ref = ctx.db.doc(`${paths.col(hid, "devices")}/${id}`);
  const snap = await ref.get();
  const prev = snap.data();
  const now = ts(ctx.now());
  let roomId: string | null = prev?.roomId ?? null;
  if (!roomId && d.room) roomId = await ensureRoom(ctx, hid, d.room);
  const state = { ...(prev?.state ?? {}), ...d.state };
  const changed: Partial<DeviceState> = {};
  for (const [k, v] of Object.entries(d.state)) if (JSON.stringify(prev?.state?.[k]) !== JSON.stringify(v)) (changed as Record<string, unknown>)[k] = v;
  await ref.set({
    householdId: hid, integrationId: iid, pluginId, externalId: d.externalId,
    name: prev?.name ?? d.name ?? d.externalId, type: d.type ?? prev?.type ?? "other", roomId,
    capabilities: d.capabilities ?? prev?.capabilities ?? [], state, stateUpdatedAt: now,
    reachable: d.reachable ?? true, lastSeenAt: now, batteryLevel: d.batteryLevel ?? prev?.batteryLevel ?? null,
    safety: PHYSICAL_SAFETY_TYPES.has(d.type ?? prev?.type ?? "") ? "physical_safety" : "standard",
    alexa: prev?.alexa ?? { exposed: false, allowedActions: [] },
    simulated: pluginId === "homehub.demo-devices",
    createdAt: prev?.createdAt ?? now, updatedAt: now,
  }, { merge: true });
  if (prev && Object.keys(changed).length && deviceHooks.onStateChanged) await deviceHooks.onStateChanged(ctx, hid, id, changed, origin);
  return id;
}

async function ensureRoom(ctx: Ctx, hid: string, name: string): Promise<string> {
  const id = sha256(name.trim().toLowerCase()).slice(0, 16);
  const ref = ctx.db.doc(`${paths.col(hid, "deviceRooms")}/${id}`);
  if (!(await ref.get()).exists) await ref.set({ householdId: hid, name: name.trim(), alexaExposed: true, createdAt: ts(ctx.now()) });
  return id;
}

export async function listDevices(ctx: Ctx, hid: string, actor: Actor) {
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  const [devices, rooms] = await Promise.all([ctx.db.collection(paths.col(hid, "devices")).get(), ctx.db.collection(paths.col(hid, "deviceRooms")).get()]);
  return {
    rooms: rooms.docs.map((r) => ({ id: r.id, name: r.data().name, alexaExposed: r.data().alexaExposed !== false })),
    devices: devices.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
}

function toolFor(action: DeviceAction): { tool: string; input: Record<string, unknown>; expect: Partial<DeviceState> } {
  switch (action.type) {
    case "power": return { tool: "set_power", input: { power: action.value }, expect: { power: action.value } };
    case "brightness":
      if (!Number.isInteger(action.value) || action.value < 0 || action.value > 100) throw invalid("Brightness must be 0–100");
      return { tool: "set_brightness", input: { brightness: action.value }, expect: { brightness: action.value } };
    case "thermostat": {
      const input: Record<string, unknown> = {};
      const expect: Partial<DeviceState> = {};
      if (action.targetTemperature !== undefined) { input.targetTemperature = action.targetTemperature; expect.targetTemperature = action.targetTemperature; }
      if (action.mode) { input.thermostatMode = action.mode; expect.thermostatMode = action.mode; }
      if (!Object.keys(input).length) throw invalid("Nothing to change");
      return { tool: "set_thermostat", input, expect };
    }
    case "lock": return { tool: "lock", input: {}, expect: { lock: "LOCKED" } };
    case "unlock": return { tool: "unlock", input: {}, expect: { lock: "UNLOCKED" } };
  }
}

const CAPABILITY_FOR: Record<DeviceAction["type"], Capability> = { power: "power", brightness: "brightness", thermostat: "thermostat", lock: "lock", unlock: "lock" };

export interface DeviceActionResult {
  status: "verified" | "unverified" | "approval_required" | "confirmation_required" | "failed";
  state?: Partial<DeviceState>;
  approvalId?: string;
  message?: string;
}

/**
 * Execute a device action through its integration and verify the resulting state.
 * Never reports success unless the device state read back matches what was asked.
 */
export async function executeDeviceAction(
  ctx: Ctx, hid: string, actor: Actor, deviceId: string, action: DeviceAction,
  opts: { channel: Channel; confirmed?: boolean; origin?: EventOrigin; idempotencyKey?: string },
): Promise<DeviceActionResult> {
  const ref = ctx.db.doc(`${paths.col(hid, "devices")}/${deviceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Device");
  const dev = snap.data()!;
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  if (m.role === "child" || m.role === "staff") {
    // Children and staff may switch ordinary devices but never physical-safety ones.
    if (dev.safety === "physical_safety" || action.type === "lock" || action.type === "unlock") throw forbidden("Ask an adult to use this device");
  }
  if (!(dev.capabilities ?? []).includes(CAPABILITY_FOR[action.type])) throw invalid(`${dev.name} doesn't support ${action.type}`);
  if (!dev.integrationId || String(dev.integrationId).startsWith("bridge:")) throw new AppError(501, "not_supported_yet", "Controlling bridge devices arrives with the Home Assistant bridge (Phase 2)");
  const { tool, input, expect } = toolFor(action);
  // Lazy import to keep the module graph acyclic at load time.
  const { executePluginTool } = await import("../plugins/runtime");
  const r = await executePluginTool(ctx, hid, actor, dev.integrationId, tool, { deviceId: dev.externalId, ...input },
    { channel: opts.channel, confirmed: opts.confirmed, idempotencyKey: opts.idempotencyKey, origin: opts.origin }).catch((e: AppError) => {
    if (e.code === "plugin_failed") return { ok: false as const, status: "failed" as const, message: e.message };
    throw e;
  });
  if (!r.ok) {
    if (r.status === "approval_required") return { status: "approval_required", approvalId: r.approvalId, message: "Waiting for a person to approve this in HomeHub." };
    if (r.status === "confirmation_required") return { status: "confirmation_required", message: r.message };
    await ref.update({ reachable: false, updatedAt: ts(ctx.now()) });
    return { status: "failed", message: r.message };
  }
  // Verify by reading the device back through the plugin (not trusting the write response).
  const verify = await executePluginTool(ctx, hid, actor, dev.integrationId, "get_state", { deviceId: dev.externalId }, { channel: opts.channel, origin: opts.origin }).catch(() => null);
  const state = (verify && verify.ok ? (verify.data as { state: Partial<DeviceState> }).state : null) ?? null;
  const matches = !!state && Object.entries(expect).every(([k, v]) => (state as Record<string, unknown>)[k] === v);
  await recordAuditEvent(ctx, hid, {
    actorUid: actor.uid, actorKind: actor.kind === "user" ? "user" : actor.kind === "agent" ? "agent" : "automation", channel: opts.channel,
    pluginId: dev.pluginId, integrationId: dev.integrationId, tool, target: { type: "device", id: deviceId, name: dev.name },
    requestedAction: `device.${action.type}`, result: matches ? "succeeded" : "failed", details: { verified: matches },
  });
  return matches ? { status: "verified", state: state! } : { status: "unverified", state: state ?? undefined, message: "The device didn't confirm the change." };
}

export async function setDeviceExposure(ctx: Ctx, actor: Actor, hid: string, deviceId: string, input: { alexaExposed?: boolean; name?: string; roomId?: string | null }) {
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || !["owner", "admin"].includes(m.role)) throw forbidden("Only managers can change device settings");
  const ref = ctx.db.doc(`${paths.col(hid, "devices")}/${deviceId}`);
  if (!(await ref.get()).exists) throw notFound("Device");
  const patch: Record<string, unknown> = { updatedAt: ts(ctx.now()) };
  if (input.alexaExposed !== undefined) patch["alexa.exposed"] = input.alexaExposed;
  if (input.name !== undefined) { if (!input.name.trim() || input.name.length > 60) throw invalid("Name must be 1–60 characters"); patch.name = input.name.trim(); }
  if (input.roomId !== undefined) patch.roomId = input.roomId;
  await ref.update(patch);
  await recordAuditEvent(ctx, hid, { actorUid: actor.uid, actorKind: "user", channel: "app", target: { type: "device", id: deviceId }, requestedAction: "device.settings_updated", result: "succeeded", details: { fields: Object.keys(input) } });
}

export async function setRoomExposure(ctx: Ctx, actor: Actor, hid: string, roomId: string, alexaExposed: boolean) {
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || !["owner", "admin"].includes(m.role)) throw forbidden("Only managers can change room settings");
  const ref = ctx.db.doc(`${paths.col(hid, "deviceRooms")}/${roomId}`);
  if (!(await ref.get()).exists) throw notFound("Room");
  await ref.update({ alexaExposed });
}

// ---------------- local bridges (pairing; device control arrives in Phase 2) ----------------

export async function createBridgePairing(ctx: Ctx, actor: Actor, hid: string, name: string) {
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || !["owner", "admin"].includes(m.role)) throw forbidden("Only managers can pair a bridge");
  const code = randomBytes(6).toString("hex").toUpperCase(); // 12 chars, shown as a QR/one-time code
  const bid = newId();
  await ctx.db.doc(`${paths.col(hid, "deviceBridges")}/${bid}`).set({
    householdId: hid, name: name.trim().slice(0, 60) || "Home bridge", status: "pairing", createdBy: actor.uid, createdAt: ts(ctx.now()),
    pairingExpiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 10 * 60_000)), lastSeenAt: null,
  });
  await ctx.db.doc(`bridgePairings/${sha256(code)}`).set({ householdId: hid, bridgeId: bid, expiresAt: Timestamp.fromDate(new Date(ctx.now().getTime() + 10 * 60_000)) });
  return { bridgeId: bid, code, expiresInSeconds: 600 };
}

/** Bridge redeems the one-time code (no user session) and receives a credential stored only as a hash. */
export async function pairBridge(ctx: Ctx, code: string) {
  if (!/^[A-F0-9]{12}$/.test(code)) throw invalid("Malformed pairing code");
  const ref = ctx.db.doc(`bridgePairings/${sha256(code)}`);
  return ctx.db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw notFound("Pairing code");
    const { householdId, bridgeId, expiresAt } = s.data()!;
    if (expiresAt.toDate() < ctx.now()) throw new AppError(410, "pairing_expired", "This pairing code has expired");
    const credential = `hhb_${randomBytes(32).toString("base64url")}`;
    tx.delete(ref);
    tx.set(ctx.db.doc(`bridgeCredentials/${sha256(credential)}`), { householdId, bridgeId, createdAt: ts(ctx.now()), revoked: false });
    tx.update(ctx.db.doc(`${paths.col(householdId, "deviceBridges")}/${bridgeId}`), { status: "paired", pairedAt: ts(ctx.now()) });
    return { householdId, bridgeId, credential };
  });
}

export async function authenticateBridge(ctx: Ctx, credential: string | undefined) {
  if (!credential || !credential.startsWith("hhb_")) throw new AppError(401, "unauthenticated", "Bridge credential required");
  const s = await ctx.db.doc(`bridgeCredentials/${sha256(credential)}`).get();
  if (!s.exists || s.data()!.revoked) throw new AppError(401, "unauthenticated", "Unknown or revoked bridge");
  return s.data() as { householdId: string; bridgeId: string };
}

/** Bridge state push: devices are recorded read-only until the Phase 2 bridge command channel exists. */
export async function pushBridgeState(ctx: Ctx, credential: string | undefined, devices: ReportedDevice[]) {
  const b = await authenticateBridge(ctx, credential);
  if (!Array.isArray(devices) || devices.length > 500) throw invalid("devices must be an array (max 500)");
  for (const d of devices) {
    if (typeof d?.externalId !== "string" || d.externalId.length > 128) throw invalid("Each device needs an externalId");
    await upsertDeviceFromPlugin(ctx, b.householdId, `bridge:${b.bridgeId}`, "homehub.bridge", d, { channel: "bridge" });
  }
  await ctx.db.doc(`${paths.col(b.householdId, "deviceBridges")}/${b.bridgeId}`).update({ lastSeenAt: ts(ctx.now()), status: "online", deviceCount: devices.length });
  return { accepted: devices.length };
}

export async function revokeBridge(ctx: Ctx, actor: Actor, hid: string, bid: string) {
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || !["owner", "admin"].includes(m.role)) throw forbidden("Only managers can remove a bridge");
  const creds = await ctx.db.collection("bridgeCredentials").where("bridgeId", "==", bid).get();
  const batch = ctx.db.batch();
  creds.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  batch.update(ctx.db.doc(`${paths.col(hid, "deviceBridges")}/${bid}`), { status: "revoked", revokedAt: ts(ctx.now()) });
  await batch.commit();
}
