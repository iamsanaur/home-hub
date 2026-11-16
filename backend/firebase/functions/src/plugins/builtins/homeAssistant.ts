import { Capability, definePlugin, DeviceState, PluginContext, ReportedDevice } from "../sdk";

/**
 * Home Assistant bridge (Phase 2). Talks to the household's own Home Assistant over its REST API
 * (https only, the URL the household entered; long-lived access token kept in Secret Manager).
 * Home Assistant in turn reaches Matter, Zigbee, Z-Wave, Wi-Fi and LAN devices, so this one plugin
 * covers most of the smart-home catalogue.
 *
 * Device ids are Home Assistant entity ids. Supported: light, switch, fan, climate, lock,
 * binary_sensor (door/window/motion) and sensor (temperature/humidity). Every write is followed by a
 * read-back, so HomeHub only reports a change once Home Assistant shows it.
 *
 * Verified against the Home Assistant REST API: GET /api/, GET /api/states, GET /api/states/<entity>,
 * POST /api/services/<domain>/<service>, POST /api/template.
 */

interface HaState { entity_id: string; state: string; attributes: Record<string, unknown> }

const DOMAINS = ["light", "switch", "fan", "climate", "lock", "binary_sensor", "sensor"];
const CONTACT_CLASSES = new Set(["door", "window", "opening", "garage_door"]);
const MOTION_CLASSES = new Set(["motion", "occupancy", "presence"]);
const MAX_DEVICES = 300;

async function ha(ctx: PluginContext, path: string, init?: RequestInit): Promise<unknown> {
  const base = String(ctx.config.baseUrl ?? "").replace(/\/+$/, "");
  const token = await ctx.secret("accessToken");
  if (!base || !token) throw new Error("Home Assistant URL or access token is missing");
  const res = await ctx.fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 401) throw new Error("Home Assistant rejected the access token");
  if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : undefined);
const round1 = (v: number) => Math.round(v * 10) / 10;
const toC = (v: number, unit: unknown) => (unit === "°F" ? round1((v - 32) * 5 / 9) : round1(v));
const HVAC_TO_MODE: Record<string, DeviceState["thermostatMode"]> = { cool: "COOL", heat: "HEAT", heat_cool: "AUTO", auto: "AUTO", off: "OFF", dry: "ECO", fan_only: "ECO" };
const MODE_TO_HVAC: Record<string, string> = { COOL: "cool", HEAT: "heat", AUTO: "auto", OFF: "off", ECO: "dry" };

/** Maps one Home Assistant entity to a HomeHub device, or null when it isn't something HomeHub controls or reads. */
export function mapEntity(s: HaState, area?: string): ReportedDevice | null {
  const [domain] = s.entity_id.split(".");
  if (!DOMAINS.includes(domain)) return null;
  const a = s.attributes ?? {};
  const name = String(a.friendly_name ?? s.entity_id).slice(0, 80);
  const reachable = s.state !== "unavailable";
  const on = s.state === "on";
  const base = { externalId: s.entity_id, name, room: area || undefined, reachable };
  switch (domain) {
    case "light": {
      const caps: Capability[] = ["power"];
      const modes = (a.supported_color_modes as string[] | undefined) ?? [];
      const dimmable = modes.some((m) => m !== "onoff") || a.brightness !== undefined;
      if (dimmable) caps.push("brightness");
      const b = num(a.brightness);
      return { ...base, type: "light", capabilities: caps, state: { power: on ? "ON" : "OFF", ...(dimmable && b !== undefined ? { brightness: Math.round((b / 255) * 100) } : {}) } };
    }
    case "switch": return { ...base, type: "plug", capabilities: ["power"], state: { power: on ? "ON" : "OFF" } };
    case "fan": return { ...base, type: "fan", capabilities: ["power"], state: { power: on ? "ON" : "OFF" } };
    case "climate": {
      const t = num(a.temperature), cur = num(a.current_temperature);
      return { ...base, type: "thermostat", capabilities: ["power", "thermostat", ...(cur !== undefined ? ["temperature" as const] : [])], state: {
        power: s.state === "off" ? "OFF" : "ON", thermostatMode: HVAC_TO_MODE[s.state] ?? "AUTO",
        ...(t !== undefined ? { targetTemperature: toC(t, a.temperature_unit) } : {}), ...(cur !== undefined ? { temperature: toC(cur, a.temperature_unit) } : {}),
      } };
    }
    case "lock": return { ...base, type: "lock", capabilities: ["lock"], state: { lock: s.state === "locked" ? "LOCKED" : s.state === "jammed" ? "JAMMED" : "UNLOCKED" } };
    case "binary_sensor": {
      const cls = String(a.device_class ?? "");
      if (CONTACT_CLASSES.has(cls)) return { ...base, type: "contact_sensor", capabilities: ["contact"], state: { contact: on ? "DETECTED" : "NOT_DETECTED" } };
      if (MOTION_CLASSES.has(cls)) return { ...base, type: "motion_sensor", capabilities: ["motion"], state: { motion: on ? "DETECTED" : "NOT_DETECTED" } };
      return null;
    }
    case "sensor": {
      const cls = String(a.device_class ?? ""), v = num(s.state);
      if (v === undefined) return { ...base, type: "climate_sensor", capabilities: [], state: {}, reachable: false };
      if (cls === "temperature") return { ...base, type: "climate_sensor", capabilities: ["temperature"], state: { temperature: toC(v, a.unit_of_measurement) } };
      if (cls === "humidity") return { ...base, type: "climate_sensor", capabilities: ["humidity"], state: { humidity: Math.round(v) } };
      return null;
    }
  }
  return null;
}

/** One template call returns every entity's area, so rooms match Home Assistant without per-entity requests. */
async function areas(ctx: PluginContext): Promise<Record<string, string>> {
  try {
    const out = await ha(ctx, "/api/template", { method: "POST", body: JSON.stringify({ template: "{% for s in states %}{{ s.entity_id }}\t{{ area_name(s.entity_id) or '' }}\n{% endfor %}" }) });
    return Object.fromEntries(String(out ?? "").split("\n").map((l) => l.split("\t")).filter((p) => p.length === 2 && p[1]).map(([e, r]) => [e, r.trim()]));
  } catch { return {}; }
}

async function sync(ctx: PluginContext): Promise<ReportedDevice[]> {
  const [states, rooms] = await Promise.all([ha(ctx, "/api/states") as Promise<HaState[]>, areas(ctx)]);
  const devices = (Array.isArray(states) ? states : []).map((s) => mapEntity(s, rooms[s.entity_id])).filter((d): d is ReportedDevice => !!d && (d.capabilities?.length ?? 0) > 0).slice(0, MAX_DEVICES);
  for (const d of devices) await ctx.reportDevice(d);
  await ctx.store.set("lastSync", { at: ctx.now().toISOString(), count: devices.length });
  return devices;
}

async function readBack(ctx: PluginContext, entityId: string) {
  const s = await ha(ctx, `/api/states/${encodeURIComponent(entityId)}`) as HaState;
  const rooms = await ctx.store.get<Record<string, string>>("areas");
  const d = mapEntity(s, rooms?.[entityId]);
  if (!d) throw new Error(`${entityId} isn't a supported device`);
  await ctx.reportDevice({ externalId: d.externalId, state: d.state, reachable: d.reachable });
  return { deviceId: entityId, state: d.state };
}

async function call(ctx: PluginContext, domain: string, service: string, entityId: string, data: Record<string, unknown> = {}) {
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entityId)) throw new Error("Invalid entity id");
  await ha(ctx, `/api/services/${domain}/${service}`, { method: "POST", body: JSON.stringify({ entity_id: entityId, ...data }) });
  return readBack(ctx, entityId);
}

const dev = { type: "object", properties: { deviceId: { type: "string", minLength: 3, maxLength: 120 } }, required: ["deviceId"], additionalProperties: false };

export const homeAssistant = definePlugin({
  manifest: {
    manifestVersion: 1, id: "homehub.homeassistant", name: "Home Assistant", publisher: "HomeHub", tier: "first_party",
    supportLevel: "bridge", version: "1.0.0", category: "smart_home", icon: "house",
    description: "Use the lights, plugs, ACs, locks and sensors you already have in Home Assistant — including Matter, Zigbee and Z-Wave devices. Rooms come from your Home Assistant areas.",
    regions: ["*"], languages: ["en"], platforms: ["server"], minApiVersion: 1,
    auth: { method: "api_key", scopes: [] }, dataCategories: ["device names", "device state", "room names"],
    tools: [
      { name: "list_devices", description: "List devices from Home Assistant and their state", input: { type: "object", properties: {}, additionalProperties: false }, access: "read", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "sync_devices", description: "Refresh devices, rooms and state from Home Assistant", input: { type: "object", properties: {}, additionalProperties: false }, access: "read", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "get_state", description: "Read one device's current state", input: dev, access: "read", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "set_power", description: "Turn a light, plug, fan or AC on or off", input: { type: "object", properties: { deviceId: { type: "string" }, power: { enum: ["ON", "OFF"] } }, required: ["deviceId", "power"], additionalProperties: false }, access: "write", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "set_brightness", description: "Set light brightness 0–100", input: { type: "object", properties: { deviceId: { type: "string" }, brightness: { type: "integer", minimum: 0, maximum: 100 } }, required: ["deviceId", "brightness"], additionalProperties: false }, access: "write", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "set_thermostat", description: "Set AC/thermostat target (16–30 °C) and mode", input: { type: "object", properties: { deviceId: { type: "string" }, targetTemperature: { type: "number", minimum: 16, maximum: 30 }, thermostatMode: { enum: ["HEAT", "COOL", "AUTO", "OFF", "ECO"] } }, required: ["deviceId"], additionalProperties: false }, access: "write", risk: "medium", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "lock", description: "Lock a door", input: dev, access: "write", risk: "medium", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "unlock", description: "Unlock a door (physical safety: approval required)", input: dev, access: "write", risk: "critical", idempotent: true, confirmation: "approval", physicalSafety: true },
    ],
    events: ["device.state_changed"],
    lifecycle: { setup: true, healthCheck: true, disconnect: true, refreshCredentials: false, deleteData: true },
    network: [], userNetworkFields: ["baseUrl"],
    privacy: { retention: "Device names, rooms and latest state are kept while connected; disconnect deletes the stored token.", support: "HomeHub support" },
    config: [
      { key: "baseUrl", label: "Home Assistant address", type: "url", required: true, secret: false, help: "Your https address, e.g. your Nabu Casa remote URL (https://xxxx.ui.nabu.casa) or your own domain." },
      { key: "accessToken", label: "Long-lived access token", type: "string", required: true, secret: true, help: "In Home Assistant: your profile → Security → Long-lived access tokens → Create token." },
    ],
  },
  handlers: {
    async setup(ctx) {
      await ctx.store.set("areas", await areas(ctx));
      await sync(ctx);
    },
    async healthCheck(ctx) {
      try {
        const r = await ha(ctx, "/api/") as { message?: string } | null;
        const last = await ctx.store.get<{ count: number }>("lastSync");
        return { ok: true, message: `${r?.message ?? "Connected"}${last ? ` · ${last.count} devices` : ""}` };
      } catch (e) { return { ok: false, message: (e as Error).message }; }
    },
    async disconnect() { /* the token is deleted by HomeHub; the household can also revoke it in Home Assistant */ },
    async deleteData(ctx) { await ctx.store.set("areas", null); await ctx.store.set("lastSync", null); },
    tools: {
      list_devices: async (ctx) => ({ devices: (await sync(ctx)).map((d) => ({ deviceId: d.externalId, name: d.name, room: d.room ?? null, state: d.state })) }),
      sync_devices: async (ctx) => {
        await ctx.store.set("areas", await areas(ctx));
        return { synced: (await sync(ctx)).length };
      },
      get_state: (ctx, i) => readBack(ctx, String(i.deviceId)),
      set_power: (ctx, i) => {
        const id = String(i.deviceId), domain = id.split(".")[0];
        if (!["light", "switch", "fan", "climate"].includes(domain)) throw new Error("This device can't be switched on or off");
        return call(ctx, domain, i.power === "ON" ? "turn_on" : "turn_off", id);
      },
      set_brightness: (ctx, i) => {
        const id = String(i.deviceId), pct = Number(i.brightness);
        if (!id.startsWith("light.")) throw new Error("Only lights have brightness");
        return pct === 0 ? call(ctx, "light", "turn_off", id) : call(ctx, "light", "turn_on", id, { brightness_pct: pct });
      },
      set_thermostat: async (ctx, i) => {
        const id = String(i.deviceId);
        if (!id.startsWith("climate.")) throw new Error("Not a thermostat");
        if (i.thermostatMode) await ha(ctx, "/api/services/climate/set_hvac_mode", { method: "POST", body: JSON.stringify({ entity_id: id, hvac_mode: MODE_TO_HVAC[String(i.thermostatMode)] }) });
        if (i.targetTemperature !== undefined) await ha(ctx, "/api/services/climate/set_temperature", { method: "POST", body: JSON.stringify({ entity_id: id, temperature: Number(i.targetTemperature) }) });
        return readBack(ctx, id);
      },
      lock: (ctx, i) => { const id = String(i.deviceId); if (!id.startsWith("lock.")) throw new Error("Not a lock"); return call(ctx, "lock", "lock", id); },
      unlock: (ctx, i) => { const id = String(i.deviceId); if (!id.startsWith("lock.")) throw new Error("Not a lock"); return call(ctx, "lock", "unlock", id); },
    },
  },
});

