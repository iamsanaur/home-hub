import { randomUUID } from "node:crypto";
import { AppError, Ctx, paths, ts } from "../services/base";
import { recordAuditEvent } from "../services/auditEvents";
import { executeDeviceAction, DeviceAction } from "../devices/devices";
import { AlexaPrincipal, resolveAlexaToken } from "./oauth";
import { defaultSecretStore } from "../plugins/secrets";
import { secretEnv } from "../core/env";

/**
 * Alexa Smart Home Skill API (payloadVersion 3) directive handler. Reached through the
 * Lambda forwarder (Smart Home skills must use an AWS Lambda endpoint), which signs each
 * forwarded directive with HMAC. Only devices (and rooms) the household exposed to Alexa are
 * discoverable, every action is executed through the device service (policy + verification),
 * and responses report the state read back from the device, never the requested state.
 */
type Json = Record<string, unknown>;
interface Directive { header: { namespace: string; name: string; payloadVersion: string; messageId: string; correlationToken?: string }; endpoint?: { endpointId: string; scope?: { type: string; token: string }; cookie?: Json }; payload: Json }

const STALE_MS = 60 * 60_000;

function header(namespace: string, name: string, correlationToken?: string) {
  return { namespace, name, payloadVersion: "3", messageId: randomUUID(), ...(correlationToken ? { correlationToken } : {}) };
}

export function errorResponse(d: Directive | undefined, type: string, message: string, extra: Json = {}) {
  return { event: { header: header("Alexa", "ErrorResponse", d?.header.correlationToken), ...(d?.endpoint ? { endpoint: { endpointId: d.endpoint.endpointId } } : {}), payload: { type, message, ...extra } } };
}

const DISPLAY: Record<string, string> = { light: "LIGHT", plug: "SMARTPLUG", switch: "SWITCH", thermostat: "THERMOSTAT", ac: "THERMOSTAT", lock: "SMARTLOCK", contact_sensor: "CONTACT_SENSOR", motion_sensor: "MOTION_SENSOR", climate_sensor: "TEMPERATURE_SENSOR", fan: "FAN" };

function iface(name: string, props?: string[], extra: Json = {}) {
  return { type: "AlexaInterface", interface: name, version: "3", ...(props ? { properties: { supported: props.map((p) => ({ name: p })), proactivelyReported: true, retrievable: true } } : {}), ...extra };
}

function capabilitiesFor(caps: string[]) {
  const out: Json[] = [iface("Alexa"), iface("Alexa.EndpointHealth", ["connectivity"])];
  if (caps.includes("power")) out.push(iface("Alexa.PowerController", ["powerState"]));
  if (caps.includes("brightness")) out.push(iface("Alexa.BrightnessController", ["brightness"]));
  if (caps.includes("thermostat")) out.push(iface("Alexa.ThermostatController", ["targetSetpoint", "thermostatMode"], { configuration: { supportedModes: ["HEAT", "COOL", "AUTO", "ECO", "OFF"], supportsScheduling: false } }));
  if (caps.includes("lock")) out.push(iface("Alexa.LockController", ["lockState"]));
  if (caps.includes("contact")) out.push(iface("Alexa.ContactSensor", ["detectionState"]));
  if (caps.includes("motion")) out.push(iface("Alexa.MotionSensor", ["detectionState"]));
  if (caps.includes("temperature")) out.push(iface("Alexa.TemperatureSensor", ["temperature"]));
  // Humidity is not exposed: HomeHub doesn't map it to a supported Alexa interface yet.
  return out;
}

/** Alexa context properties from VERIFIED device state. */
export function propertiesFor(dev: FirebaseFirestore.DocumentData, now: Date) {
  const sampled = (dev.stateUpdatedAt?.toDate?.() as Date | undefined) ?? now;
  const p = (namespace: string, name: string, value: unknown) => ({ namespace, name, value, timeOfSample: sampled.toISOString(), uncertaintyInMilliseconds: Math.max(0, now.getTime() - sampled.getTime()) });
  const s = dev.state ?? {};
  const caps: string[] = dev.capabilities ?? [];
  const reachable = dev.reachable !== false && now.getTime() - ((dev.lastSeenAt?.toDate?.() as Date | undefined)?.getTime() ?? 0) < STALE_MS;
  const out = [p("Alexa.EndpointHealth", "connectivity", { value: reachable ? "OK" : "UNREACHABLE" })];
  if (caps.includes("power") && s.power) out.push(p("Alexa.PowerController", "powerState", s.power));
  if (caps.includes("brightness") && typeof s.brightness === "number") out.push(p("Alexa.BrightnessController", "brightness", s.brightness));
  if (caps.includes("thermostat")) {
    if (typeof s.targetTemperature === "number") out.push(p("Alexa.ThermostatController", "targetSetpoint", { value: s.targetTemperature, scale: "CELSIUS" }));
    if (s.thermostatMode) out.push(p("Alexa.ThermostatController", "thermostatMode", s.thermostatMode));
  }
  if (caps.includes("lock") && s.lock) out.push(p("Alexa.LockController", "lockState", s.lock));
  if (caps.includes("contact") && s.contact) out.push(p("Alexa.ContactSensor", "detectionState", s.contact));
  if (caps.includes("motion") && s.motion) out.push(p("Alexa.MotionSensor", "detectionState", s.motion));
  if (caps.includes("temperature") && typeof s.temperature === "number") out.push(p("Alexa.TemperatureSensor", "temperature", { value: s.temperature, scale: "CELSIUS" }));
  return { properties: out, reachable };
}

async function exposedDevices(ctx: Ctx, hid: string) {
  const [devices, rooms] = await Promise.all([ctx.db.collection(paths.col(hid, "devices")).where("alexa.exposed", "==", true).get(), ctx.db.collection(paths.col(hid, "deviceRooms")).get()]);
  const hiddenRooms = new Set(rooms.docs.filter((r) => r.data().alexaExposed === false).map((r) => r.id));
  return devices.docs.filter((d) => !hiddenRooms.has(d.data().roomId));
}

async function endpointDevice(ctx: Ctx, principal: AlexaPrincipal, endpointId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(endpointId)) return null;
  const snap = await ctx.db.doc(`${paths.col(principal.householdId, "devices")}/${endpointId}`).get();
  if (!snap.exists) return null; // devices of other households live under other paths → never found
  const d = snap.data()!;
  if (d.alexa?.exposed !== true) return null;
  if (d.roomId && (await ctx.db.doc(`${paths.col(principal.householdId, "deviceRooms")}/${d.roomId}`).get()).data()?.alexaExposed === false) return null;
  return { id: snap.id, data: d };
}

const toCelsius = (v: number, scale: string) => (scale === "FAHRENHEIT" ? Math.round(((v - 32) * 5) / 9 * 2) / 2 : scale === "KELVIN" ? Math.round((v - 273.15) * 2) / 2 : v);

export interface SmartHomeDeps { fetchImpl?: typeof fetch }

export async function handleDirective(ctx: Ctx, body: { directive?: Directive }, deps: SmartHomeDeps = {}): Promise<Json> {
  const d = body?.directive;
  if (!d?.header || d.header.payloadVersion !== "3") return errorResponse(d, "INVALID_DIRECTIVE", "Unsupported payload version");
  const { namespace, name } = d.header;
  const token = namespace === "Alexa.Discovery" ? (d.payload?.scope as Json | undefined)?.token as string | undefined
    : namespace === "Alexa.Authorization" ? (d.payload?.grantee as Json | undefined)?.token as string | undefined
    : d.endpoint?.scope?.token;
  let principal: AlexaPrincipal;
  try { principal = await resolveAlexaToken(ctx, token); }
  catch (e) {
    const code = e instanceof AppError ? e.code : "INVALID_AUTHORIZATION_CREDENTIAL";
    return namespace === "Alexa.Authorization"
      ? { event: { header: header("Alexa.Authorization", "ErrorResponse"), payload: { type: "ACCEPT_GRANT_FAILED", message: "Account link is not valid" } } }
      : errorResponse(d, ["EXPIRED_AUTHORIZATION_CREDENTIAL", "INSUFFICIENT_PERMISSIONS"].includes(code) ? code : "INVALID_AUTHORIZATION_CREDENTIAL", "Re-link HomeHub in the Alexa app.");
  }
  const hid = principal.householdId;
  const audit = (action: string, result: "succeeded" | "failed" | "denied", target: { type: string; id?: string; name?: string } = { type: "channel", id: "alexa" }, details: Json = {}) =>
    recordAuditEvent(ctx, hid, { actorUid: principal.uid, actorKind: "user", channel: "alexa", target, requestedAction: `alexa.${action}`, result, details });

  if (namespace === "Alexa.Discovery" && name === "Discover") {
    const devices = await exposedDevices(ctx, hid);
    await audit("discover", "succeeded", { type: "channel", id: "alexa" }, { endpoints: devices.length });
    return {
      event: {
        header: header("Alexa.Discovery", "Discover.Response"),
        payload: {
          endpoints: devices.map((x) => {
            const v = x.data();
            return {
              endpointId: x.id, manufacturerName: v.simulated ? "HomeHub (simulated)" : "HomeHub",
              friendlyName: String(v.name).slice(0, 128), description: `${v.simulated ? "Simulated device" : "Device"} via HomeHub`.slice(0, 128),
              displayCategories: [DISPLAY[v.type] ?? "OTHER"], capabilities: capabilitiesFor(v.capabilities ?? []),
            };
          }),
        },
      },
    };
  }

  if (namespace === "Alexa.Authorization" && name === "AcceptGrant") {
    const grant = d.payload.grant as { type?: string; code?: string } | undefined;
    const ok = await acceptGrant(ctx, principal, grant?.code, deps);
    await audit("accept_grant", ok ? "succeeded" : "failed");
    return ok
      ? { event: { header: header("Alexa.Authorization", "AcceptGrant.Response"), payload: {} } }
      : { event: { header: header("Alexa.Authorization", "ErrorResponse"), payload: { type: "ACCEPT_GRANT_FAILED", message: "HomeHub couldn't complete the grant" } } };
  }

  const endpointId = d.endpoint?.endpointId ?? "";
  const dev = await endpointDevice(ctx, principal, endpointId);
  if (!dev) return errorResponse(d, "NO_SUCH_ENDPOINT", "This device isn't available to Alexa");
  const target = { type: "device", id: dev.id, name: dev.data.name as string };

  if (namespace === "Alexa" && name === "ReportState") {
    const { properties, reachable } = propertiesFor(dev.data, ctx.now());
    if (!reachable) return errorResponse(d, "ENDPOINT_UNREACHABLE", "The device isn't responding");
    return { event: { header: header("Alexa", "StateReport", d.header.correlationToken), endpoint: { scope: d.endpoint?.scope, endpointId }, payload: {} }, context: { properties } };
  }

  // Map the directive onto a HomeHub device action.
  let action: DeviceAction | null = null;
  const s = dev.data.state ?? {};
  switch (`${namespace}.${name}`) {
    case "Alexa.PowerController.TurnOn": action = { type: "power", value: "ON" }; break;
    case "Alexa.PowerController.TurnOff": action = { type: "power", value: "OFF" }; break;
    case "Alexa.BrightnessController.SetBrightness": action = { type: "brightness", value: Math.round(Number(d.payload.brightness)) }; break;
    case "Alexa.BrightnessController.AdjustBrightness":
      action = { type: "brightness", value: Math.max(0, Math.min(100, Math.round(Number(s.brightness ?? 0) + Number(d.payload.brightnessDelta)))) }; break;
    case "Alexa.ThermostatController.SetTargetTemperature": {
      const sp = d.payload.targetSetpoint as { value: number; scale: string };
      action = { type: "thermostat", targetTemperature: toCelsius(Number(sp?.value), sp?.scale) }; break;
    }
    case "Alexa.ThermostatController.AdjustTargetTemperature": {
      const sp = d.payload.targetSetpointDelta as { value: number; scale: string };
      const delta = sp?.scale === "FAHRENHEIT" ? Number(sp.value) * 5 / 9 : Number(sp?.value);
      action = { type: "thermostat", targetTemperature: Math.round((Number(s.targetTemperature ?? 24) + delta) * 2) / 2 }; break;
    }
    case "Alexa.ThermostatController.SetThermostatMode": action = { type: "thermostat", mode: (d.payload.thermostatMode as { value: string })?.value as never }; break;
    case "Alexa.LockController.Lock": action = { type: "lock" }; break;
    case "Alexa.LockController.Unlock":
      // Physical-safety policy: unlocking never happens from a voice command.
      await audit("unlock", "denied", target, { reason: "voice unlock disabled" });
      return errorResponse(d, "NOT_SUPPORTED_IN_CURRENT_MODE", "For safety, unlock doors in the HomeHub app.", { currentDeviceMode: "OTHER" });
    default:
      return errorResponse(d, "INVALID_DIRECTIVE", `${namespace}.${name} isn't supported`);
  }
  if (action.type === "brightness" && !Number.isFinite(action.value)) return errorResponse(d, "INVALID_VALUE", "Brightness must be a number");
  if (action.type === "thermostat" && action.targetTemperature !== undefined && (!Number.isFinite(action.targetTemperature) || action.targetTemperature < 16 || action.targetTemperature > 30)) {
    return errorResponse(d, "TEMPERATURE_VALUE_OUT_OF_RANGE", "Set a temperature between 16 and 30 °C", { validRange: { minimumValue: { value: 16, scale: "CELSIUS" }, maximumValue: { value: 30, scale: "CELSIUS" } } });
  }

  let result;
  try {
    result = await executeDeviceAction(ctx, hid, { uid: principal.uid, kind: "user" }, dev.id, action, { channel: "alexa", origin: { channel: "alexa" }, idempotencyKey: d.header.messageId.slice(0, 120) });
  } catch (e) {
    const ae = e instanceof AppError ? e : null;
    if (ae?.status === 403) return errorResponse(d, "INSUFFICIENT_PERMISSIONS", ae.message);
    if (ae?.code === "integration_inactive" || ae?.code === "paused" || ae?.code === "plugin_disabled") return errorResponse(d, "ENDPOINT_UNREACHABLE", ae.message);
    return errorResponse(d, "INTERNAL_ERROR", "HomeHub couldn't complete that");
  }
  if (result.status === "approval_required" || result.status === "confirmation_required") {
    return errorResponse(d, "NOT_SUPPORTED_IN_CURRENT_MODE", "This needs approval in the HomeHub app.", { currentDeviceMode: "OTHER" });
  }
  if (result.status !== "verified") return errorResponse(d, "ENDPOINT_UNREACHABLE", "The device didn't confirm the change");
  const fresh = (await ctx.db.doc(`${paths.col(hid, "devices")}/${dev.id}`).get()).data()!;
  return {
    event: { header: header("Alexa", "Response", d.header.correlationToken), endpoint: { scope: d.endpoint?.scope, endpointId }, payload: {} },
    context: { properties: propertiesFor(fresh, ctx.now()).properties },
  };
}

// ---------------- Event Gateway (AcceptGrant + ChangeReport) ----------------

const LWA_TOKEN_URL = () => process.env.LWA_TOKEN_URL ?? "https://api.amazon.com/auth/o2/token";
const EVENT_GATEWAY_URL = () => process.env.ALEXA_EVENT_GATEWAY_URL ?? "https://api.amazonalexa.com/v3/events";

/** Exchange the AcceptGrant code with Login with Amazon for Event Gateway tokens (secret-stored). */
async function acceptGrant(ctx: Ctx, principal: AlexaPrincipal, code: string | undefined, deps: SmartHomeDeps): Promise<boolean> {
  const id = process.env.LWA_CLIENT_ID, secret = secretEnv("LWA_CLIENT_SECRET");
  if (!code || !id || !secret) return false;
  const res = await (deps.fetchImpl ?? fetch)(LWA_TOKEN_URL(), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: id, client_secret: secret }).toString(),
  });
  if (!res.ok) return false;
  const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!t.access_token || !t.refresh_token) return false;
  const store = defaultSecretStore(ctx);
  const ref = await store.put(`alexa-eg-${principal.linkId}`, JSON.stringify({ access: t.access_token, refresh: t.refresh_token, expiresAt: ctx.now().getTime() + (t.expires_in ?? 3600) * 1000 }));
  await ctx.db.doc(`alexaLinks/${principal.linkId}`).update({ eventGateway: { secretRef: ref, grantedAt: ts(ctx.now()) } });
  return true;
}

async function eventGatewayToken(ctx: Ctx, linkId: string, ref: string, deps: SmartHomeDeps): Promise<string | null> {
  const store = defaultSecretStore(ctx);
  const raw = await store.get(ref);
  if (!raw) return null;
  const t = JSON.parse(raw) as { access: string; refresh: string; expiresAt: number };
  if (t.expiresAt - 60_000 > ctx.now().getTime()) return t.access;
  const res = await (deps.fetchImpl ?? fetch)(LWA_TOKEN_URL(), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: process.env.LWA_CLIENT_ID ?? "", client_secret: secretEnv("LWA_CLIENT_SECRET") ?? "" }).toString(),
  });
  if (!res.ok) return null;
  const n = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  const newRef = await store.put(`alexa-eg-${linkId}`, JSON.stringify({ access: n.access_token, refresh: n.refresh_token ?? t.refresh, expiresAt: ctx.now().getTime() + (n.expires_in ?? 3600) * 1000 }));
  await ctx.db.doc(`alexaLinks/${linkId}`).update({ "eventGateway.secretRef": newRef });
  await store.delete(ref);
  return n.access_token;
}

/** Proactive ChangeReport to every linked member who can see this device. Best-effort; never blocks HomeHub. */
export async function sendChangeReport(ctx: Ctx, hid: string, deviceId: string, changed: Record<string, unknown>, cause: "PHYSICAL_INTERACTION" | "APP_INTERACTION" | "RULE_TRIGGER" | "VOICE_INTERACTION", deps: SmartHomeDeps = {}) {
  const dev = (await ctx.db.doc(`${paths.col(hid, "devices")}/${deviceId}`).get()).data();
  if (!dev?.alexa?.exposed) return { sent: 0, skipped: "not exposed" };
  const links = await ctx.db.collection("alexaLinks").where("householdId", "==", hid).where("status", "==", "linked").get();
  const { properties } = propertiesFor(dev, ctx.now());
  const changedNames = new Set(Object.keys(changed).map((k) => ({ power: "powerState", brightness: "brightness", targetTemperature: "targetSetpoint", thermostatMode: "thermostatMode", lock: "lockState", contact: "detectionState", motion: "detectionState", temperature: "temperature" } as Record<string, string>)[k]).filter(Boolean));
  const changedProps = properties.filter((p) => changedNames.has(p.name));
  if (!changedProps.length) return { sent: 0, skipped: "no Alexa-visible property changed" };
  let sent = 0;
  for (const l of links.docs) {
    const ref = l.data().eventGateway?.secretRef;
    if (!ref) continue;
    const token = await eventGatewayToken(ctx, l.id, ref, deps).catch(() => null);
    if (!token) continue;
    const res = await (deps.fetchImpl ?? fetch)(EVENT_GATEWAY_URL(), {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        event: { header: header("Alexa", "ChangeReport"), endpoint: { scope: { type: "BearerToken", token }, endpointId: deviceId }, payload: { change: { cause: { type: cause }, properties: changedProps } } },
        context: { properties: properties.filter((p) => !changedNames.has(p.name)) },
      }),
    }).catch(() => null);
    if (res?.ok) sent++;
  }
  return { sent };
}
