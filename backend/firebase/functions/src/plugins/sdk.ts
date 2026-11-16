import type { PluginManifest } from "./manifest";

/**
 * HomeHub Plugin SDK. A plugin is a manifest plus handlers. Handlers receive a
 * PluginContext with narrow capabilities only — no database, no host access, no
 * unrestricted network. The runtime validates inputs/outputs against the manifest.
 */
export interface PluginContext {
  readonly householdId: string;
  readonly integrationId: string;
  /** Non-secret configuration chosen at setup. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Resolve a declared secret config field (from Secret Manager via its reference). */
  secret(key: string): Promise<string | null>;
  /** fetch restricted to the manifest's network allowlist, with timeout and size limits. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Plugin-private key/value storage scoped to this integration. */
  store: { get<T = unknown>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> };
  /** Report device state (smart-home plugins) — the runtime maps it onto HomeHub devices. */
  reportDevice(device: ReportedDevice): Promise<void>;
  log(message: string, data?: Record<string, unknown>): void;
  now(): Date;
}

export interface ReportedDevice {
  externalId: string;
  name?: string;
  type?: DeviceType;
  room?: string;
  capabilities?: Capability[];
  state: Partial<DeviceState>;
  reachable?: boolean;
  batteryLevel?: number | null;
}

export type DeviceType = "light" | "plug" | "switch" | "thermostat" | "lock" | "contact_sensor" | "motion_sensor" | "climate_sensor" | "fan" | "ac" | "other";
export type Capability = "power" | "brightness" | "color" | "thermostat" | "lock" | "contact" | "motion" | "temperature" | "humidity";
export interface DeviceState {
  power: "ON" | "OFF";
  brightness: number; // 0–100
  color: { hue: number; saturation: number; brightness: number };
  targetTemperature: number; // °C
  thermostatMode: "HEAT" | "COOL" | "AUTO" | "OFF" | "ECO";
  temperature: number; // °C (sensor)
  humidity: number; // %
  lock: "LOCKED" | "UNLOCKED" | "JAMMED";
  contact: "DETECTED" | "NOT_DETECTED";
  motion: "DETECTED" | "NOT_DETECTED";
}

export interface PluginHandlers {
  setup?(ctx: PluginContext): Promise<void>;
  healthCheck?(ctx: PluginContext): Promise<{ ok: boolean; message?: string }>;
  disconnect?(ctx: PluginContext): Promise<void>;
  refreshCredentials?(ctx: PluginContext): Promise<void>;
  deleteData?(ctx: PluginContext): Promise<void>;
  tools: Record<string, (ctx: PluginContext, input: Record<string, unknown>) => Promise<unknown>>;
  /** Inbound events (signed webhooks, bridge pushes). Payload is untrusted data. */
  onEvent?(ctx: PluginContext, topic: string, payload: unknown): Promise<{ events: Array<{ type: string; data: Record<string, unknown> }> }>;
}

export interface HomeHubPlugin {
  manifest: PluginManifest;
  handlers: PluginHandlers;
}

export function definePlugin(p: HomeHubPlugin): HomeHubPlugin {
  const missing = p.manifest.tools.map((t) => t.name).filter((n) => !p.handlers.tools[n]);
  if (missing.length) throw new Error(`Plugin ${p.manifest.id} is missing handlers for: ${missing.join(", ")}`);
  return p;
}
