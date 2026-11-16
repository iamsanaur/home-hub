import { HomeHubPlugin } from "./sdk";
import { validateManifest } from "./manifest";
import { demoDevices } from "./builtins/demoDevices";
import { webhook } from "./builtins/webhook";
import { homeAssistant } from "./builtins/homeAssistant";
import { aiProviderPlugins } from "./builtins/aiProviders";
import { telegram } from "./builtins/telegram";
import { googleCalendar } from "./builtins/googleCalendar";

/** Plugins with real, tested implementations. Only these can be connected. */
export const BUILTIN_PLUGINS: HomeHubPlugin[] = [demoDevices, homeAssistant, webhook, telegram, googleCalendar, ...aiProviderPlugins];
export const PLUGIN_INDEX = new Map(BUILTIN_PLUGINS.map((p) => [p.manifest.id, p]));

// Fail fast if a built-in manifest ever violates the safety rules.
for (const p of BUILTIN_PLUGINS) {
  const v = validateManifest(p.manifest);
  if (!v.ok) throw new Error(`Built-in plugin ${p.manifest.id} has an invalid manifest: ${JSON.stringify(v.issues)}`);
}

export type Availability = "available" | "needs_platform_credentials" | "planned" | "unsupported";

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  tier: string;
  supportLevel: string;
  availability: Availability;
  description: string;
  note?: string;
  featured?: boolean;
  authMethod?: string;
  tools?: Array<{ name: string; description: string; access: string; risk: string; confirmation: string; physicalSafety: boolean }>;
  dataCategories?: string[];
  privacy?: { retention: string; support: string; policyUrl?: string };
  config?: Array<{ key: string; label: string; type: string; required: boolean; secret: boolean; help?: string }>;
  version?: string;
}

/** Addendum §4 targets without an implementation yet — listed honestly as planned. */
const PLANNED: Array<[string, string, string, string, string?]> = [
  // id, name, category, supportLevel, note
  ["matter", "Matter (direct)", "smart_home", "bridge", "Matter devices already work through Home Assistant; a direct Matter controller is planned."],
  ["google-home", "Google Home", "smart_home", "official_api", "Where Google Home APIs are available."],
  ["smartthings", "Samsung SmartThings", "smart_home", "official_api"],
  ["apple-home", "Apple Home (via bridge)", "smart_home", "bridge", "Through a HomeKit-compatible bridge; Android cannot use Apple-only APIs."],
  ["philips-hue", "Philips Hue", "smart_home", "official_api"], ["ikea-dirigera", "IKEA DIRIGERA", "smart_home", "bridge"],
  ["aqara", "Aqara", "smart_home", "official_api"], ["tuya", "Tuya / Smart Life", "smart_home", "official_api"], ["shelly", "Shelly", "smart_home", "bridge"],
  ["switchbot", "SwitchBot", "smart_home", "official_api"], ["tplink", "TP-Link Kasa / Tapo", "smart_home", "official_api", "Where official interfaces permit."],
  ["sonos", "Sonos", "smart_home", "official_api"], ["roborock", "Roborock", "smart_home", "official_api", "Only where documented APIs exist."],
  ["whatsapp", "WhatsApp Business", "channels", "official_api", "Approved use cases only."],
  ["slack", "Slack", "channels", "official_api"], ["discord", "Discord", "channels", "official_api"], ["teams", "Microsoft Teams", "channels", "official_api"],
  ["gmail", "Gmail", "productivity", "official_api", "Read-only bill/receipt extraction with explicit scopes."],
  ["outlook", "Microsoft Outlook", "productivity", "official_api"], ["outlook-calendar", "Outlook Calendar", "productivity", "official_api"], ["google-drive", "Google Drive", "productivity", "official_api"],
  ["notion", "Notion", "productivity", "official_api"], ["todoist", "Todoist", "productivity", "official_api"],
  ["account-aggregator", "Bank data (Account Aggregator)", "finance", "official_api", "Only via licensed FIU/FIP partners with consent. Read-only."],
  ["bigbasket", "BigBasket", "shopping", "official_api", "Only through partner interfaces; checkout always needs approval."],
  ["blinkit", "Blinkit", "shopping", "official_api", "Only through partner interfaces."], ["swiggy", "Swiggy / Instamart", "shopping", "official_api", "Only through partner interfaces."],
  ["amazon-in", "Amazon India", "shopping", "official_api", "Only through official/partner interfaces."],
  ["weather", "Weather & air quality", "information", "official_api"],
  ["anthropic", "Anthropic (direct)", "ai_provider", "official_api", "Claude models are available today through OpenRouter; a native Anthropic adapter is planned."],
  ["ollama", "Local models (Ollama)", "ai_provider", "bridge", "Via the local bridge in Phase 2."],
];

function fromPlugin(p: HomeHubPlugin): CatalogEntry {
  const m = p.manifest;
  return {
    id: m.id, name: m.name, category: m.category, tier: m.tier, supportLevel: m.supportLevel, availability: "available",
    description: m.description, authMethod: m.auth.method, version: m.version, featured: m.id === "homehub.demo-devices" || m.id === "ai.openrouter",
    tools: m.tools.map((t) => ({ name: t.name, description: t.description, access: t.access, risk: t.risk, confirmation: t.confirmation, physicalSafety: t.physicalSafety })),
    dataCategories: m.dataCategories, privacy: m.privacy,
    config: m.config.map((c) => ({ key: c.key, label: c.label, type: c.type, required: c.required, secret: c.secret, help: c.help })),
  };
}

export function catalog(): CatalogEntry[] {
  const alexa: CatalogEntry = {
    id: "amazon.alexa", name: "Amazon Alexa", category: "voice", tier: "verified_partner", supportLevel: "official_api",
    availability: process.env.ALEXA_SKILL_ID && process.env.ALEXA_OAUTH_CLIENT_ID ? "available" : "needs_platform_credentials",
    description: "Control exposed devices and ask HomeHub about lists, chores, dinner and your briefing. Link from the Alexa app.",
    note: process.env.ALEXA_SKILL_ID ? undefined : "The skill code is ready; it needs HomeHub's Amazon developer skill to be configured before it can be linked.",
    featured: true, authMethod: "oauth2",
  };
  return [
    ...BUILTIN_PLUGINS.map(fromPlugin), alexa,
    ...PLANNED.map(([id, name, category, supportLevel, note]) => ({ id: `planned.${id}`, name, category, tier: "verified_partner", supportLevel, availability: "planned" as const, description: note ?? "Planned integration.", note })),
  ];
}
