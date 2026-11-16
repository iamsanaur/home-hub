import { beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, testCtx } from "./helpers";
import { Actor } from "../../src/services/base";
import { acceptInvitation, createHousehold, invite } from "../../src/services/households";
import { connectIntegration, syncBridgeIntegrations, testIntegration } from "../../src/plugins/runtime";
import { executeDeviceAction, listDevices } from "../../src/devices/devices";
import { mapEntity } from "../../src/plugins/builtins/homeAssistant";

const ctx = testCtx();
const owner: Actor = { uid: "ha_owner", kind: "user" };
const child: Actor = { uid: "ha_child", kind: "user" };
let hid: string;

/** A fake Home Assistant REST API with mutable state, reached only through the runtime's fetch. */
function fakeHomeAssistant(token = "ha-token-123") {
  const states: Record<string, { entity_id: string; state: string; attributes: Record<string, unknown> }> = {
    "light.living_lamp": { entity_id: "light.living_lamp", state: "off", attributes: { friendly_name: "Living lamp", supported_color_modes: ["brightness"], brightness: null } },
    "switch.kettle": { entity_id: "switch.kettle", state: "off", attributes: { friendly_name: "Kettle" } },
    "climate.bedroom_ac": { entity_id: "climate.bedroom_ac", state: "cool", attributes: { friendly_name: "Bedroom AC", temperature: 24, current_temperature: 29 } },
    "lock.front_door": { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front door" } },
    "binary_sensor.balcony_door": { entity_id: "binary_sensor.balcony_door", state: "off", attributes: { friendly_name: "Balcony door", device_class: "door" } },
    "sensor.hall_temp": { entity_id: "sensor.hall_temp", state: "82.4", attributes: { friendly_name: "Hall temperature", device_class: "temperature", unit_of_measurement: "°F" } },
    "sensor.power_usage": { entity_id: "sensor.power_usage", state: "120", attributes: { friendly_name: "Power", device_class: "power" } }, // unsupported → skipped
    "media_player.tv": { entity_id: "media_player.tv", state: "on", attributes: { friendly_name: "TV" } }, // unsupported domain
  };
  const areas: Record<string, string> = { "light.living_lamp": "Living Room", "lock.front_door": "Entrance", "climate.bedroom_ac": "Bedroom" };
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const json = (b: unknown, status = 200) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status });
    if (url.origin !== "https://ha.example.com") return json({ message: "wrong host" }, 599);
    if (auth !== `Bearer ${token}`) return json({ message: "401: Unauthorized" }, 401);
    const path = url.pathname;
    if (path === "/api/") return json({ message: "API running." });
    if (path === "/api/states") return json(Object.values(states));
    if (path.startsWith("/api/states/")) return json(states[decodeURIComponent(path.slice(12))] ?? { message: "Entity not found." }, states[decodeURIComponent(path.slice(12))] ? 200 : 404);
    if (path === "/api/template") return json(Object.keys(states).map((e) => `${e}\t${areas[e] ?? ""}`).join("\n"));
    const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(path);
    if (svc && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      const s = states[body.entity_id];
      calls.push(`${svc[1]}.${svc[2]}:${body.entity_id}`);
      if (!s) return json([], 400);
      const [, , service] = svc;
      if (service === "turn_on") { s.state = s.entity_id.startsWith("climate.") ? "cool" : "on"; if (body.brightness_pct !== undefined) s.attributes.brightness = Math.round(body.brightness_pct * 2.55); }
      if (service === "turn_off") s.state = "off";
      if (service === "lock") s.state = "locked";
      if (service === "unlock") s.state = "unlocked";
      if (service === "set_temperature") s.attributes.temperature = body.temperature;
      if (service === "set_hvac_mode") s.state = body.hvac_mode;
      return json([s]);
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, states, calls };
}

beforeEach(async () => {
  await clearFirestore();
  hid = (await createHousehold(ctx, { uid: owner.uid, displayName: "O", email: "ha_owner@example.com" }, { name: "Sharma Home", currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" })).householdId;
  const inv = await invite(ctx, owner, hid, { role: "child", email: "ha_child@example.com" });
  await acceptInvitation(ctx, { uid: child.uid, email: "ha_child@example.com", emailVerified: true, displayName: "C" }, inv.token);
});

const connect = (fetchImpl: typeof fetch, baseUrl = "https://ha.example.com", token = "ha-token-123") =>
  connectIntegration(ctx, owner, hid, { pluginId: "homehub.homeassistant", consent: true, config: { baseUrl }, secrets: { accessToken: token } }, { fetchImpl });

describe("Home Assistant bridge", () => {
  it("imports supported entities with rooms, converts units, and skips the rest", async () => {
    const ha = fakeHomeAssistant();
    const r = await connect(ha.fetchImpl);
    expect(r.status).toBe("connected");
    const { devices } = await listDevices(ctx, hid, owner) as { devices: Array<Record<string, any>>; rooms: Array<Record<string, any>> };
    const by = (id: string) => devices.find((d) => d.externalId === id);
    expect(devices.map((d) => d.externalId).sort()).toEqual(["binary_sensor.balcony_door", "climate.bedroom_ac", "light.living_lamp", "lock.front_door", "sensor.hall_temp", "switch.kettle"]);
    expect(by("light.living_lamp")).toMatchObject({ type: "light", capabilities: ["power", "brightness"] });
    expect(by("sensor.hall_temp")!.state.temperature).toBe(28); // 82.4 °F
    expect(by("lock.front_door")).toMatchObject({ safety: "physical_safety" });
    const rooms = (await listDevices(ctx, hid, owner) as any).rooms.map((x: any) => x.name).sort();
    expect(rooms).toEqual(expect.arrayContaining(["Bedroom", "Entrance", "Living Room"]));
  });

  it("controls devices through Home Assistant and reports only read-back state", async () => {
    const ha = fakeHomeAssistant();
    await connect(ha.fetchImpl);
    const { devices } = await listDevices(ctx, hid, owner) as { devices: Array<Record<string, any>> };
    const lamp = devices.find((d) => d.externalId === "light.living_lamp")!;
    const on = await executeDeviceAction(ctx, hid, owner, lamp.id, { type: "brightness", value: 40 }, { channel: "app", deps: { fetchImpl: ha.fetchImpl } });
    expect(on.status).toBe("verified");
    expect(ha.states["light.living_lamp"]).toMatchObject({ state: "on" });
    expect(ha.calls).toContain("light.turn_on:light.living_lamp");

    const ac = devices.find((d) => d.externalId === "climate.bedroom_ac")!;
    expect((await executeDeviceAction(ctx, hid, owner, ac.id, { type: "thermostat", targetTemperature: 22 }, { channel: "app", deps: { fetchImpl: ha.fetchImpl } })).status).toBe("verified");
    expect(ha.states["climate.bedroom_ac"].attributes.temperature).toBe(22);

    // Unlocking is physical-safety: it waits for an approval, and Home Assistant is never called.
    const door = devices.find((d) => d.externalId === "lock.front_door")!;
    const unlock = await executeDeviceAction(ctx, hid, owner, door.id, { type: "unlock" }, { channel: "app", deps: { fetchImpl: ha.fetchImpl } });
    expect(unlock.status).toBe("approval_required");
    expect(ha.states["lock.front_door"].state).toBe("locked");
    // Children can't touch the lock at all.
    await expect(executeDeviceAction(ctx, hid, child, door.id, { type: "lock" }, { channel: "app", deps: { fetchImpl: ha.fetchImpl } })).rejects.toThrow();
  });

  it("background sync picks up changes made in Home Assistant", async () => {
    const ha = fakeHomeAssistant();
    await connect(ha.fetchImpl);
    ha.states["binary_sensor.balcony_door"].state = "on"; // someone opened the door
    const r = await syncBridgeIntegrations(ctx, { fetchImpl: ha.fetchImpl });
    expect(r).toEqual({ synced: 1, failed: 0 });
    const { devices } = await listDevices(ctx, hid, owner) as { devices: Array<Record<string, any>> };
    expect(devices.find((d) => d.externalId === "binary_sensor.balcony_door")!.state.contact).toBe("DETECTED");
  });

  it("rejects non-https addresses and reports a bad token honestly", async () => {
    const ha = fakeHomeAssistant();
    const insecure = await connect(ha.fetchImpl, "http://192.168.1.10:8123").catch((e) => e);
    expect(insecure instanceof Error || insecure.status !== "connected").toBe(true);
    const bad = await connect(ha.fetchImpl, "https://ha.example.com", "wrong-token");
    expect(bad.status).not.toBe("connected");
    const t = await testIntegration(ctx, owner, hid, bad.integrationId, { fetchImpl: ha.fetchImpl });
    expect(JSON.stringify(t)).toMatch(/rejected the access token/);
  });

  it("maps entities defensively", () => {
    expect(mapEntity({ entity_id: "light.x", state: "unavailable", attributes: {} })?.reachable).toBe(false);
    expect(mapEntity({ entity_id: "binary_sensor.smoke", state: "off", attributes: { device_class: "smoke" } })).toBeNull();
    expect(mapEntity({ entity_id: "lock.gate", state: "jammed", attributes: {} })?.state.lock).toBe("JAMMED");
    expect(mapEntity({ entity_id: "sensor.rh", state: "55.6", attributes: { device_class: "humidity" } })?.state.humidity).toBe(56);
  });
});
