import { definePlugin, DeviceState, PluginContext, ReportedDevice } from "../sdk";

/**
 * SANDBOX plugin: simulated household devices so the Gateway, device policy, automations
 * and Alexa can be exercised end to end without hardware. Clearly labelled as simulated
 * everywhere it appears. Real hardware arrives through Home Assistant / Matter (Phase 2).
 */
const SEED: ReportedDevice[] = [
  { externalId: "living-lamp", name: "Living room lamp", type: "light", room: "Living room", capabilities: ["power", "brightness"], state: { power: "OFF", brightness: 60 } },
  { externalId: "kitchen-plug", name: "Kettle plug", type: "plug", room: "Kitchen", capabilities: ["power"], state: { power: "OFF" } },
  { externalId: "bedroom-ac", name: "Bedroom AC", type: "thermostat", room: "Bedroom", capabilities: ["power", "thermostat", "temperature"], state: { power: "OFF", targetTemperature: 24, thermostatMode: "COOL", temperature: 29 } },
  { externalId: "front-door", name: "Front door lock", type: "lock", room: "Entrance", capabilities: ["lock"], state: { lock: "LOCKED" } },
  { externalId: "balcony-door", name: "Balcony door sensor", type: "contact_sensor", room: "Living room", capabilities: ["contact"], state: { contact: "NOT_DETECTED" }, batteryLevel: 82 },
  { externalId: "hall-climate", name: "Hall climate sensor", type: "climate_sensor", room: "Hall", capabilities: ["temperature", "humidity"], state: { temperature: 27.5, humidity: 61 }, batteryLevel: 64 },
];

const id = { type: "object", properties: { deviceId: { type: "string", minLength: 1, maxLength: 64 } }, required: ["deviceId"], additionalProperties: false };

async function load(ctx: PluginContext): Promise<Record<string, ReportedDevice>> {
  return (await ctx.store.get<Record<string, ReportedDevice>>("devices")) ?? Object.fromEntries(SEED.map((d) => [d.externalId, structuredClone(d)]));
}
async function update(ctx: PluginContext, deviceId: string, patch: Partial<DeviceState>) {
  const all = await load(ctx);
  const d = all[deviceId];
  if (!d) throw new Error(`Unknown device ${deviceId}`);
  if (ctx.config.simulateOffline === deviceId) throw new Error("Device is not responding");
  d.state = { ...d.state, ...patch };
  await ctx.store.set("devices", all);
  await ctx.reportDevice({ externalId: deviceId, state: d.state, reachable: true });
  return { deviceId, state: d.state };
}

export const demoDevices = definePlugin({
  manifest: {
    manifestVersion: 1, id: "homehub.demo-devices", name: "Demo devices (simulated)", publisher: "HomeHub", tier: "first_party",
    supportLevel: "native", version: "1.0.0", category: "smart_home", icon: "lightbulb",
    description: "Six simulated devices — lights, a plug, an AC, a door lock and sensors — for trying automations and Alexa without hardware. Nothing physical is controlled.",
    regions: ["*"], languages: ["en"], platforms: ["server"], minApiVersion: 1,
    auth: { method: "none", scopes: [] }, dataCategories: ["device state"],
    tools: [
      { name: "list_devices", description: "List simulated devices and their state", input: { type: "object", properties: {}, additionalProperties: false }, access: "read", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "get_state", description: "Read one device's current state", input: id, access: "read", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "set_power", description: "Turn a device on or off", input: { type: "object", properties: { deviceId: { type: "string" }, power: { enum: ["ON", "OFF"] } }, required: ["deviceId", "power"], additionalProperties: false }, access: "write", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "set_brightness", description: "Set light brightness 0–100", input: { type: "object", properties: { deviceId: { type: "string" }, brightness: { type: "integer", minimum: 0, maximum: 100 } }, required: ["deviceId", "brightness"], additionalProperties: false }, access: "write", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "set_thermostat", description: "Set AC/thermostat target (16–30 °C) and mode", input: { type: "object", properties: { deviceId: { type: "string" }, targetTemperature: { type: "number", minimum: 16, maximum: 30 }, thermostatMode: { enum: ["HEAT", "COOL", "AUTO", "OFF", "ECO"] } }, required: ["deviceId"], additionalProperties: false }, access: "write", risk: "medium", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "lock", description: "Lock a door", input: id, access: "write", risk: "medium", idempotent: true, confirmation: "none", physicalSafety: false },
      { name: "unlock", description: "Unlock a door (physical safety: approval required)", input: id, access: "write", risk: "critical", idempotent: true, confirmation: "approval", physicalSafety: true },
    ],
    events: ["device.state_changed"],
    lifecycle: { setup: true, healthCheck: true, disconnect: true, refreshCredentials: false, deleteData: true },
    network: [], userNetworkFields: [],
    privacy: { retention: "Simulated device state is kept until you disconnect the plugin.", support: "HomeHub support" },
    config: [{ key: "simulateOffline", label: "Simulate an offline device (device id)", type: "string", required: false, secret: false }],
  },
  handlers: {
    async setup(ctx) {
      const all = await load(ctx);
      await ctx.store.set("devices", all);
      for (const d of Object.values(all)) await ctx.reportDevice({ ...d, reachable: ctx.config.simulateOffline !== d.externalId });
    },
    async healthCheck() { return { ok: true, message: "Simulator running" }; },
    async disconnect() { /* nothing external to revoke */ },
    async deleteData(ctx) { await ctx.store.set("devices", null); },
    tools: {
      list_devices: async (ctx) => ({ devices: Object.values(await load(ctx)).map((d) => ({ deviceId: d.externalId, name: d.name, state: d.state })) }),
      get_state: async (ctx, i) => {
        const d = (await load(ctx))[String(i.deviceId)];
        if (!d) throw new Error("Unknown device");
        if (ctx.config.simulateOffline === d.externalId) throw new Error("Device is not responding");
        return { deviceId: d.externalId, state: d.state };
      },
      set_power: (ctx, i) => update(ctx, String(i.deviceId), { power: i.power as "ON" | "OFF" }),
      set_brightness: (ctx, i) => update(ctx, String(i.deviceId), { brightness: Number(i.brightness), power: Number(i.brightness) > 0 ? "ON" : "OFF" }),
      set_thermostat: (ctx, i) => update(ctx, String(i.deviceId), {
        ...(i.targetTemperature !== undefined ? { targetTemperature: Number(i.targetTemperature) } : {}),
        ...(i.thermostatMode ? { thermostatMode: i.thermostatMode as DeviceState["thermostatMode"], power: i.thermostatMode === "OFF" ? "OFF" as const : "ON" as const } : {}),
      }),
      lock: (ctx, i) => update(ctx, String(i.deviceId), { lock: "LOCKED" }),
      unlock: (ctx, i) => update(ctx, String(i.deviceId), { lock: "UNLOCKED" }),
    },
  },
});
