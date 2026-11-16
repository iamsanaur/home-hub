import { z } from "zod";

/**
 * HomeHub plugin manifest v1 (addendum §3). Every integration — first-party, partner,
 * community or custom — declares exactly what it does, what it touches and how risky
 * each action is. The runtime enforces the manifest; nothing outside it is callable.
 */
export const PLUGIN_API_VERSION = 1;

export const PluginCategory = z.enum([
  "smart_home", "voice", "channels", "productivity", "finance", "shopping", "home_services", "information", "ai_provider", "developer",
]);

/** Addendum §3 "discovery and compatibility" levels. */
export const SupportLevel = z.enum(["native", "official_api", "bridge", "community", "custom", "unsupported"]);
export const PublisherTier = z.enum(["first_party", "verified_partner", "community", "custom"]);
export const AuthMethod = z.enum(["oauth2", "oauth_pkce", "api_key", "device_pairing", "local_bridge", "webhook_signature", "none"]);
export const Risk = z.enum(["low", "medium", "high", "critical"]);
export const Confirmation = z.enum(["none", "confirm", "approval"]);

const JsonSchema = z.record(z.string(), z.unknown());

export const ToolDecl = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  description: z.string().min(1).max(300),
  input: JsonSchema,
  output: JsonSchema.optional(),
  access: z.enum(["read", "write"]),
  risk: Risk,
  idempotent: z.boolean().default(false),
  confirmation: Confirmation.default("none"),
  /** Locks, alarms, garage doors, ovens, heaters, cooktops, water valves… (addendum §3 safety). */
  physicalSafety: z.boolean().default(false),
});

export const ConfigField = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  label: z.string().max(80),
  type: z.enum(["string", "url", "number", "boolean", "select"]),
  required: z.boolean().default(false),
  secret: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  help: z.string().max(200).optional(),
});

export const PluginManifest = z.object({
  manifestVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, "reverse-DNS style id, e.g. homehub.demo-devices"),
  name: z.string().min(1).max(60),
  publisher: z.string().min(1).max(80),
  tier: PublisherTier,
  supportLevel: SupportLevel,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1).max(500),
  category: PluginCategory,
  icon: z.string().max(60),
  docsUrl: z.string().url().optional(),
  regions: z.array(z.string().regex(/^([A-Z]{2}|\*)$/)).min(1),
  languages: z.array(z.string().max(10)).min(1),
  platforms: z.array(z.enum(["android", "ios", "server"])).min(1),
  minApiVersion: z.number().int().min(1),
  auth: z.object({ method: AuthMethod, scopes: z.array(z.string().max(200)).default([]) }),
  dataCategories: z.array(z.string().max(60)),
  tools: z.array(ToolDecl).max(100),
  events: z.array(z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/)).default([]),
  lifecycle: z.object({
    setup: z.boolean(), healthCheck: z.boolean(), disconnect: z.boolean(),
    refreshCredentials: z.boolean(), deleteData: z.boolean(),
  }),
  network: z.array(z.string().max(200)).default([]),
  /** Config keys whose (https) URL the user chose — e.g. a custom webhook target. */
  userNetworkFields: z.array(z.string()).default([]),
  privacy: z.object({ policyUrl: z.string().url().optional(), retention: z.string().max(300), support: z.string().max(200) }),
  config: z.array(ConfigField).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifest>;
export type ToolDecl = z.infer<typeof ToolDecl>;

export interface ManifestIssue { path: string; message: string; severity: "error" | "warning" }

/**
 * Structural (zod) + semantic validation. Semantic rules encode the safety policy:
 * physical-safety and critical tools require approval; writes can't be "none"-confirmed
 * at high risk; network destinations must be https host allowlists; secrets must be
 * declared secret; a plugin can't need a newer API than this server speaks.
 */
export function validateManifest(input: unknown): { ok: boolean; manifest?: PluginManifest; issues: ManifestIssue[] } {
  const parsed = PluginManifest.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, severity: "error" as const })) };
  }
  const m = parsed.data;
  const issues: ManifestIssue[] = [];
  const names = new Set<string>();
  m.tools.forEach((t, i) => {
    if (names.has(t.name)) issues.push({ path: `tools.${i}.name`, message: `Duplicate tool ${t.name}`, severity: "error" });
    names.add(t.name);
    if ((t.physicalSafety || t.risk === "critical") && t.confirmation !== "approval") {
      issues.push({ path: `tools.${i}.confirmation`, message: "Critical or physical-safety tools must require approval", severity: "error" });
    }
    if (t.access === "write" && t.risk === "high" && t.confirmation === "none") {
      issues.push({ path: `tools.${i}.confirmation`, message: "High-risk writes need confirmation or approval", severity: "error" });
    }
    if (t.access === "read" && t.confirmation === "approval") {
      issues.push({ path: `tools.${i}.confirmation`, message: "Read tools should not require approval", severity: "warning" });
    }
    if (t.input.type !== "object") issues.push({ path: `tools.${i}.input`, message: "Tool input schema must be a JSON object schema", severity: "error" });
  });
  m.network.forEach((n, i) => {
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(n) && !/^https:\/\/\*\.[a-z0-9.-]+$/i.test(n)) {
      issues.push({ path: `network.${i}`, message: "Network destinations must be https URLs or https://*.domain wildcards", severity: "error" });
    }
  });
  m.config.forEach((c, i) => {
    if (/(secret|token|password|api_?key)/i.test(c.key) && !c.secret) {
      issues.push({ path: `config.${i}`, message: `Field ${c.key} looks sensitive; mark it secret`, severity: "error" });
    }
  });
  m.userNetworkFields.forEach((k) => {
    const f = m.config.find((c) => c.key === k);
    if (!f || f.type !== "url") issues.push({ path: "userNetworkFields", message: `${k} must be a declared url config field`, severity: "error" });
  });
  if (m.minApiVersion > PLUGIN_API_VERSION) issues.push({ path: "minApiVersion", message: `Requires HomeHub API v${m.minApiVersion}`, severity: "error" });
  if (["oauth2", "oauth_pkce"].includes(m.auth.method) && !m.lifecycle.disconnect) {
    issues.push({ path: "lifecycle.disconnect", message: "OAuth plugins must implement disconnect (token revocation)", severity: "error" });
  }
  return { ok: !issues.some((x) => x.severity === "error"), manifest: m, issues };
}

/** Is `url` inside the plugin's declared network allowlist? */
export function networkAllowed(manifest: PluginManifest, url: string, config: Record<string, unknown> = {}): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const userHosts = manifest.userNetworkFields.map((k) => { try { return new URL(String(config[k] ?? "")); } catch { return null; } })
    .filter((x): x is URL => !!x && x.protocol === "https:");
  if (userHosts.some((h) => h.host === u.host)) return true;
  return manifest.network.some((entry) => {
    const e = new URL(entry.replace("*.", "wildcard."));
    if (entry.includes("://*.")) return u.hostname.endsWith(e.hostname.replace(/^wildcard/, ""));
    return u.hostname === e.hostname && (e.port === "" || u.port === e.port) && u.pathname.startsWith(e.pathname === "/" ? "/" : e.pathname);
  });
}
