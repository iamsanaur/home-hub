import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, createUser, listen, testCtx } from "./helpers";
import { Actor } from "../../src/services/base";
import { acceptInvitation, createHousehold, invite, setAutonomy } from "../../src/services/households";
import { decideApproval } from "../../src/services/approvals";
import { createShoppingList } from "../../src/services/food";
import { connectIntegration, executePluginTool, setIntegrationPaused } from "../../src/plugins/runtime";
import { completeProviderOAuth, resolveModelAccount, startProviderOAuth } from "../../src/plugins/modelAccounts";
import { createBridgePairing, executeDeviceAction, listDevices, revokeBridge, setDeviceExposure, setRoomExposure, upsertDeviceFromPlugin } from "../../src/devices/devices";
import { saveAutomation, testAutomation } from "../../src/automations/automations";
import { createChannelPairing, redeemChannelPairing, setSkillEnabled } from "../../src/channels/gateway";
import { signWebhook } from "../../src/plugins/builtins/webhook";
import { createHooksApp } from "../../src/gateway/hooksApp";
import { createAlexaApp, signForwarded } from "../../src/alexa/app";
import { handleDirective } from "../../src/alexa/smartHome";
import { handleCustomSkill } from "../../src/alexa/customSkill";
import { installEventHooks } from "../../src/wiring";

const ctx = testCtx();
const owner: Actor = { uid: "p1_owner", kind: "user" };
const adult: Actor = { uid: "p1_adult", kind: "user" };
const child: Actor = { uid: "p1_child", kind: "user" };
const staff: Actor = { uid: "p1_staff", kind: "user" };
let hid: string;
let hid2: string;

async function join(hh: string, inviter: Actor, as: Actor, role: "adult" | "child" | "staff" | "admin") {
  const email = `${as.uid}@example.com`;
  const inv = await invite(ctx, inviter, hh, { role, email });
  await acceptInvitation(ctx, { uid: as.uid, email, emailVerified: true, displayName: as.uid }, inv.token);
}

async function connectDemo() {
  const r = await connectIntegration(ctx, owner, hid, { pluginId: "homehub.demo-devices", consent: true });
  const devices = (await listDevices(ctx, hid, owner)).devices as Array<Record<string, any>>;
  const by = (ext: string) => devices.find((d) => d.externalId === ext)!;
  return { iid: r.integrationId, status: r.status, devices, by };
}

const gatewayFetch = (routes: Record<string, unknown>) => (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const k = Object.keys(routes).find((p) => u.startsWith(p));
  if (!k) return new Response("not mocked", { status: 599 });
  const v = routes[k];
  const body = typeof v === "function" ? (v as (u: string, i?: RequestInit) => unknown)(u, init) : v;
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as unknown as typeof fetch;

beforeAll(() => installEventHooks());

beforeEach(async () => {
  await clearFirestore();
  hid = (await createHousehold(ctx, { uid: owner.uid, displayName: "Owner", email: "o@example.com" }, { name: "Rao Home", currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" })).householdId;
  await join(hid, owner, adult, "adult");
  await join(hid, owner, child, "child");
  await join(hid, owner, staff, "staff");
  hid2 = (await createHousehold(ctx, { uid: "p1_other", displayName: "Other", email: "x@example.com" }, { name: "Other Home", currency: "USD", timezone: "UTC" })).householdId;
});

describe("plugin runtime + device policy", () => {
  it("connects only with consent, by managers, and reports simulated devices", async () => {
    await expect(connectIntegration(ctx, owner, hid, { pluginId: "homehub.demo-devices", consent: false })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(connectIntegration(ctx, adult, hid, { pluginId: "homehub.demo-devices", consent: true })).rejects.toMatchObject({ code: "forbidden" });
    const { status, devices } = await connectDemo();
    expect(status).toBe("connected");
    expect(devices).toHaveLength(6);
    expect(devices.every((d) => d.simulated === true)).toBe(true);
    expect(devices.find((d) => d.type === "lock")!.safety).toBe("physical_safety");
  });

  it("reports success only after the state is read back and matches", async () => {
    const { by } = await connectDemo();
    const r = await executeDeviceAction(ctx, hid, adult, by("living-lamp").id, { type: "power", value: "ON" }, { channel: "app" });
    expect(r).toMatchObject({ status: "verified", state: { power: "ON" } });
    expect((await ctx.db.doc(`households/${hid}/devices/${by("living-lamp").id}`).get()).data()!.state.power).toBe("ON");
  });

  it("unlocking needs a person's approval and children can't touch locks", async () => {
    const { by } = await connectDemo();
    const door = by("front-door").id;
    await expect(executeDeviceAction(ctx, hid, child, door, { type: "lock" }, { channel: "app" })).rejects.toMatchObject({ code: "forbidden" });
    const r = await executeDeviceAction(ctx, hid, adult, door, { type: "unlock" }, { channel: "app" });
    expect(r.status).toBe("approval_required");
    expect((await ctx.db.doc(`households/${hid}/devices/${door}`).get()).data()!.state.lock).toBe("LOCKED");
    const decided = await decideApproval(ctx, hid, owner, r.approvalId!, "approve");
    expect(decided.status).toBe("executed");
    expect((await ctx.db.doc(`households/${hid}/devices/${door}`).get()).data()!.state.lock).toBe("UNLOCKED");
  });

  it("kill switch, pause and emergency pause stop tool calls", async () => {
    const { iid, by } = await connectDemo();
    const lamp = by("living-lamp").externalId;
    await ctx.db.doc("pluginCatalog/homehub.demo-devices").set({ killSwitch: true });
    await expect(executePluginTool(ctx, hid, owner, iid, "set_power", { deviceId: lamp, power: "ON" }, { channel: "app" })).rejects.toMatchObject({ code: "plugin_disabled" });
    await ctx.db.doc("pluginCatalog/homehub.demo-devices").delete();
    await setIntegrationPaused(ctx, owner, hid, iid, true);
    await expect(executePluginTool(ctx, hid, owner, iid, "set_power", { deviceId: lamp, power: "ON" }, { channel: "app" })).rejects.toMatchObject({ code: "integration_inactive" });
    await setIntegrationPaused(ctx, owner, hid, iid, false);
    await setAutonomy(ctx, adult, hid, { paused: true });
    await expect(executePluginTool(ctx, hid, { uid: owner.uid, kind: "system" }, iid, "set_power", { deviceId: lamp, power: "ON" }, { channel: "automation" })).rejects.toMatchObject({ code: "paused" });
    // A person in the app can still use their home during an agent pause.
    expect((await executePluginTool(ctx, hid, owner, iid, "set_power", { deviceId: lamp, power: "ON" }, { channel: "app" })).ok).toBe(true);
  });

  it("validates tool input against the manifest schema", async () => {
    const { iid } = await connectDemo();
    await expect(executePluginTool(ctx, hid, owner, iid, "set_brightness", { deviceId: "living-lamp", brightness: 140 }, { channel: "app" })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(executePluginTool(ctx, hid, owner, iid, "set_power", { deviceId: "living-lamp", power: "ON", extra: 1 }, { channel: "app" })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("automations", () => {
  it("device events trigger automations, with a run log and audit", async () => {
    const { by } = await connectDemo();
    const sensor = by("balcony-door");
    const { id } = await saveAutomation(ctx, owner, hid, {
      name: "Balcony opened", trigger: { type: "device_state", deviceId: sensor.id, property: "contact" },
      conditions: [{ field: "event.value", op: "eq", value: "DETECTED" }], actions: [{ type: "create_task", title: "Check the balcony door" }],
    });
    await upsertDeviceFromPlugin(ctx, hid, sensor.integrationId, "homehub.demo-devices", { externalId: "balcony-door", state: { contact: "DETECTED" }, reachable: true });
    const tasks = await ctx.db.collection(`households/${hid}/tasks`).where("title", "==", "Check the balcony door").get();
    expect(tasks.size).toBe(1);
    const runs = await ctx.db.collection(`households/${hid}/automationRuns`).where("automationId", "==", id).get();
    expect(runs.docs[0].data().status).toBe("succeeded");
  });

  it("an automation can't re-trigger itself through the device it controls", async () => {
    const { by } = await connectDemo();
    const lamp = by("living-lamp");
    const { id } = await saveAutomation(ctx, owner, hid, {
      name: "Echo", trigger: { type: "device_state", deviceId: lamp.id, property: "power" },
      actions: [{ type: "device_action", deviceId: lamp.id, action: "power_off" }], cooldownMinutes: 0,
    });
    await executeDeviceAction(ctx, hid, owner, lamp.id, { type: "power", value: "ON" }, { channel: "app", origin: { channel: "app" } });
    const runs = (await ctx.db.collection(`households/${hid}/automationRuns`).where("automationId", "==", id).get()).docs.map((d) => d.data());
    // Exactly one run: the power_off it caused was recognised as its own echo and not re-run.
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect((await ctx.db.doc(`households/${hid}/devices/${lamp.id}`).get()).data()!.state.power).toBe("OFF");
  });

  it("preview runs nothing; cooldown and managers-only are enforced", async () => {
    await expect(saveAutomation(ctx, adult, hid, { name: "x", trigger: { type: "manual" }, actions: [{ type: "create_task", title: "x" }] })).rejects.toMatchObject({ code: "forbidden" });
    const { id } = await saveAutomation(ctx, owner, hid, { name: "Tidy", trigger: { type: "manual" }, actions: [{ type: "create_task", title: "Tidy up" }], cooldownMinutes: 60 });
    const preview = await testAutomation(ctx, owner, hid, id, false);
    expect(preview.status).toBe("previewed");
    expect((await ctx.db.collection(`households/${hid}/tasks`).get()).size).toBe(0);
    expect((await testAutomation(ctx, owner, hid, id, true)).status).toBe("succeeded");
    expect(await testAutomation(ctx, owner, hid, id, true)).toMatchObject({ status: "skipped", reason: "cooldown" });
    expect((await ctx.db.collection(`households/${hid}/tasks`).get()).size).toBe(1);
  });
});

describe("signed webhooks, bridges and channel pairing", () => {
  let hooks: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => { hooks = await listen(createHooksApp(ctx)); });
  afterAll(async () => { await hooks.close(); });

  it("accepts a signed event once and feeds automations; rejects replay, stale and bad signatures", async () => {
    const { integrationId: iid } = await connectIntegration(ctx, owner, hid, { pluginId: "homehub.webhook", consent: true, secrets: { signingSecret: "whsec_test_123" } });
    await saveAutomation(ctx, owner, hid, { name: "Parcel", trigger: { type: "webhook", integrationId: iid, eventType: "webhook.parcel" }, actions: [{ type: "create_task", title: "Collect parcel" }] });
    const body = JSON.stringify({ type: "parcel", data: { carrier: "x" } });
    const t = Math.floor(Date.now() / 1000);
    const post = (sig: string, ts = t, b = body) => fetch(`${hooks.url}/webhooks/${hid}/${iid}`, { method: "POST", headers: { "Content-Type": "application/json", "X-HomeHub-Timestamp": String(ts), "X-HomeHub-Signature": sig }, body: b });
    const ok = await post(signWebhook("whsec_test_123", t, body));
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ accepted: 1, automationsRun: 1 });
    expect((await post(signWebhook("whsec_test_123", t, body))).status).toBe(409);
    expect((await post(signWebhook("wrong", t, body))).status).toBe(401);
    const old = t - 600;
    expect((await post(signWebhook("whsec_test_123", old, body), old)).status).toBe(401);
    expect((await fetch(`${hooks.url}/webhooks/${hid2}/${iid}`, { method: "POST", body, headers: { "X-HomeHub-Timestamp": String(t), "X-HomeHub-Signature": signWebhook("whsec_test_123", t, body) } })).status).toBe(404);
    expect((await ctx.db.collection(`households/${hid}/tasks`).where("title", "==", "Collect parcel").get()).size).toBe(1);
  });

  it("pairs a bridge with a one-time code; bridge devices are read-only; revocation works", async () => {
    const { code, bridgeId } = await createBridgePairing(ctx, owner, hid, "Hall Pi");
    const pair = await fetch(`${hooks.url}/bridges/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    expect(pair.status).toBe(201);
    const { credential } = await pair.json();
    expect((await fetch(`${hooks.url}/bridges/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) })).status).toBe(404);
    const push = (cred: string) => fetch(`${hooks.url}/bridges/state`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred}` }, body: JSON.stringify({ devices: [{ externalId: "zb-1", name: "Porch light", type: "light", capabilities: ["power"], state: { power: "OFF" }, reachable: true }] }) });
    expect((await push(credential)).status).toBe(200);
    const dev = ((await listDevices(ctx, hid, owner)).devices as any[]).find((d) => d.name === "Porch light");
    await expect(executeDeviceAction(ctx, hid, owner, dev.id, { type: "power", value: "ON" }, { channel: "app" })).rejects.toMatchObject({ code: "not_supported_yet" });
    await revokeBridge(ctx, owner, hid, bridgeId);
    expect((await push(credential)).status).toBe(401);
  });

  it("channel pairing codes are single-use; staff can't link; unimplemented channels say so", async () => {
    await expect(createChannelPairing(ctx, staff, hid, "webhook")).rejects.toMatchObject({ code: "forbidden" });
    await expect(createChannelPairing(ctx, adult, hid, "telegram")).rejects.toMatchObject({ code: "not_supported_yet" });
    const { code } = await createChannelPairing(ctx, adult, hid, "webhook");
    expect(await redeemChannelPairing(ctx, hid, "webhook", code, "sender-1")).toEqual({ uid: adult.uid });
    await expect(redeemChannelPairing(ctx, hid, "webhook", code, "sender-2")).rejects.toMatchObject({ code: "pairing_used" });
  });

  it("household-manager can't be disabled; other skills can", async () => {
    await expect(setSkillEnabled(ctx, owner, hid, "household-manager", false)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(setSkillEnabled(ctx, adult, hid, "finance-manager", false)).rejects.toMatchObject({ code: "forbidden" });
    await setSkillEnabled(ctx, owner, hid, "finance-manager", false);
    expect((await ctx.db.doc(`households/${hid}/skills/finance-manager`).get()).data()!.enabled).toBe(false);
  });
});

describe("bring-your-own model accounts", () => {
  it("OpenRouter PKCE: server keeps the verifier, exchanges the code once, stores the key server-side", async () => {
    await expect(startProviderOAuth(ctx, child, hid, "openrouter", "personal")).rejects.toMatchObject({ code: "forbidden" });
    await expect(startProviderOAuth(ctx, adult, hid, "openrouter", "household")).rejects.toMatchObject({ code: "forbidden" });
    const { authUrl } = await startProviderOAuth(ctx, adult, hid, "openrouter", "personal");
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe("https://openrouter.ai/auth");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const state = u.searchParams.get("state")!;
    let sentVerifier = "";
    const fetchImpl = gatewayFetch({
      "https://openrouter.ai/api/v1/auth/keys": (_u: string, init?: RequestInit) => { sentVerifier = JSON.parse(String(init!.body)).code_verifier; return { key: "sk-or-v1-test" }; },
      "https://openrouter.ai/api/v1/models": { data: [{ id: "anthropic/claude-sonnet-5.5" }] },
    });
    const r = await completeProviderOAuth(ctx, "code-123", state, { fetchImpl });
    expect(r.status).toBe("connected");
    expect(createHash("sha256").update(sentVerifier).digest("base64url")).toBe(u.searchParams.get("code_challenge"));
    await expect(completeProviderOAuth(ctx, "code-123", state, { fetchImpl })).rejects.toMatchObject({ code: "invalid_state" });
    const integ = (await ctx.db.doc(`households/${hid}/integrations/${r.integrationId}`).get()).data()!;
    expect(JSON.stringify(integ)).not.toContain("sk-or-v1-test");
    const resolved = await resolveModelAccount(ctx, hid, adult.uid, null);
    expect(resolved).toMatchObject({ source: "personal", label: "OpenRouter (your account)" });
    expect(resolved!.cfg.apiKey).toBe("sk-or-v1-test");
    // Another member doesn't get this person's account.
    expect(await resolveModelAccount(ctx, hid, owner.uid, null)).toBeNull();
  });

  it("household API-key account serves members without their own; platform model is last", async () => {
    const fetchImpl = gatewayFetch({ "https://api.openai.com/v1/models": { data: [] } });
    const { integrationId } = await connectIntegration(ctx, owner, hid, { pluginId: "ai.openai", scope: "household", consent: true, secrets: { apiKey: "sk-test-hh" } }, { fetchImpl });
    await ctx.db.doc(`households/${hid}/integrations/${integrationId}`).update({ isDefault: true });
    expect(await resolveModelAccount(ctx, hid, adult.uid, null)).toMatchObject({ source: "household", cfg: { baseUrl: "https://api.openai.com/v1", modelSimple: "gpt-4o-mini" } });
    const platform = { baseUrl: "https://x", apiKey: "p", modelSimple: "s", modelComplex: "c", maxCallsPerWorkflow: 5, maxTokensPerWorkflow: 1000 };
    expect((await resolveModelAccount(ctx, hid2, "p1_other", platform))!.source).toBe("platform");
  });
});

describe("Alexa", () => {
  const CLIENT = { id: "alexa-client", secret: "alexa-secret-0123456789", redirect: "https://pitangui.amazon.com/api/skill/link/TESTVENDOR" };
  let app: Awaited<ReturnType<typeof listen>>;
  const lwaCalls: string[] = [];
  const amazon = gatewayFetch({
    "https://api.amazon.com/auth/o2/token": (_u: string, init?: RequestInit) => { lwaCalls.push(String(init!.body)); return { access_token: "Atza|eg", refresh_token: "Atzr|eg", expires_in: 3600 }; },
    "https://api.amazonalexa.com/v3/events": (_u: string, init?: RequestInit) => { lwaCalls.push(`event:${String(init!.body)}`); return {}; },
  });

  beforeAll(async () => {
    Object.assign(process.env, { ALEXA_OAUTH_CLIENT_ID: CLIENT.id, ALEXA_OAUTH_CLIENT_SECRET: CLIENT.secret, ALEXA_REDIRECT_URIS: CLIENT.redirect, ALEXA_FORWARDER_SECRET: "fwd-secret", LWA_CLIENT_ID: "lwa", LWA_CLIENT_SECRET: "lwa-secret" });
    installEventHooks({ smartHome: { fetchImpl: amazon } });
    app = await listen(createAlexaApp({ ctx, smartHome: { fetchImpl: amazon } }));
  });
  afterAll(async () => { installEventHooks(); await app.close(); });

  async function linkUser(): Promise<{ uid: string; tokens: { access_token: string; refresh_token: string } }> {
    const email = `alexa${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const u = await createUser(email);
    const inv = await invite(ctx, owner, hid, { role: "adult", email });
    await acceptInvitation(ctx, { uid: u.uid, email, emailVerified: true, displayName: "A" }, inv.token);
    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const q = { response_type: "code", client_id: CLIENT.id, redirect_uri: CLIENT.redirect, state: "st-1", scope: "homehub" };
    const bad = await fetch(`${app.url}/oauth/authorize?${form({ ...q, redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
    expect(bad.status).toBe(400);
    expect((await fetch(`${app.url}/oauth/authorize?${form(q)}`)).status).toBe(200);
    const post = (o: Record<string, string>) => fetch(`${app.url}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form(o) });
    expect((await post({ ...q, step: "signin", email, password: "wrong-password" })).status).toBe(401);
    const consent = await post({ ...q, step: "signin", email, password: "correct-horse-battery" });
    expect(consent.status).toBe(200);
    const session = /name="session" value="([^"]+)"/.exec(await consent.text())![1];
    const redirect = await post({ step: "consent", session, householdId: hid });
    expect(redirect.status).toBe(302);
    const loc = new URL(redirect.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CLIENT.redirect);
    expect(loc.searchParams.get("state")).toBe("st-1");
    const basic = `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString("base64")}`;
    const tok = await fetch(`${app.url}/oauth/token`, { method: "POST", headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: CLIENT.redirect }) });
    expect(tok.status).toBe(200);
    return { uid: u.uid, tokens: await tok.json() };
  }

  const directive = (namespace: string, name: string, token: string, endpointId?: string, payload: Record<string, unknown> = {}) => ({
    directive: {
      header: { namespace, name, payloadVersion: "3", messageId: `m-${Math.random()}`, correlationToken: "ct" },
      ...(endpointId ? { endpoint: { endpointId, scope: { type: "BearerToken", token } } } : {}),
      payload: namespace === "Alexa.Discovery" ? { scope: { type: "BearerToken", token } } : payload,
    },
  });

  it("account linking with PKCE: the code needs the matching verifier", async () => {
    const { createHash } = await import("node:crypto");
    const email = `alexapkce${Date.now()}@example.com`;
    const u = await createUser(email);
    const inv = await invite(ctx, owner, hid, { role: "adult", email });
    await acceptInvitation(ctx, { uid: u.uid, email, emailVerified: true, displayName: "P" }, inv.token);
    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const post = (o: Record<string, string>) => fetch(`${app.url}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form(o) });
    const basic = `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString("base64")}`;
    const token = (code: string, extra: Record<string, string> = {}) => fetch(`${app.url}/oauth/token`, { method: "POST", headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code, redirect_uri: CLIENT.redirect, ...extra }) });
    const verifier = "pkce-verifier-" + "x".repeat(50);
    const q = { response_type: "code", client_id: CLIENT.id, redirect_uri: CLIENT.redirect, state: "st-p", scope: "homehub",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const getCode = async () => {
      const page = await fetch(`${app.url}/oauth/authorize?${form(q)}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(`name="code_challenge" value="${q.code_challenge}"`); // carried through sign-in
      const consent = await post({ ...q, step: "signin", email, password: "correct-horse-battery" });
      const session = /name="session" value="([^"]+)"/.exec(await consent.text())![1];
      const redirect = await post({ step: "consent", session, householdId: hid });
      return new URL(redirect.headers.get("location")!).searchParams.get("code")!;
    };
    expect((await fetch(`${app.url}/oauth/authorize?${form({ ...q, code_challenge_method: "plain" })}`)).status).toBe(400);
    // Missing verifier: refused, and the code is spent.
    const c1 = await getCode();
    const noVerifier = await token(c1);
    expect(noVerifier.status).toBe(400);
    expect((await noVerifier.json()).error).toBe("invalid_grant");
    expect((await token(c1, { code_verifier: verifier })).status).toBe(400);
    // Wrong verifier: refused.
    expect((await token(await getCode(), { code_verifier: "wrong-" + "y".repeat(50) })).status).toBe(400);
    // Matching verifier: linked.
    const ok = await token(await getCode(), { code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect((await ok.json()).access_token).toMatch(/^hha_/);
  });

  it("account linking: refresh tokens rotate and reuse revokes the link", async () => {
    const { tokens } = await linkUser();
    const basic = `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString("base64")}`;
    const refresh = (rt: string) => fetch(`${app.url}/oauth/token`, { method: "POST", headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }).toString() });
    const r1 = await refresh(tokens.refresh_token);
    expect(r1.status).toBe(200);
    const t2 = await r1.json();
    expect(t2.refresh_token).not.toBe(tokens.refresh_token);
    const reuse = await refresh(tokens.refresh_token);
    expect(reuse.status).toBe(400);
    expect((await handleDirective(ctx, directive("Alexa.Discovery", "Discover", t2.access_token)) as any).event.payload.type).toBe("INVALID_AUTHORIZATION_CREDENTIAL");
    const wrongClient = await fetch(`${app.url}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: CLIENT.id, client_secret: "nope" }).toString() });
    expect(wrongClient.status).toBe(401);
  });

  it("Smart Home: discovers only exposed devices, verifies actions, refuses voice unlock, isolates households", async () => {
    const { by } = await connectDemo();
    const { tokens } = await linkUser();
    const lamp = by("living-lamp"), door = by("front-door"), ac = by("bedroom-ac");
    for (const d of [lamp, door, ac]) await setDeviceExposure(ctx, owner, hid, d.id, { alexaExposed: true });
    const t = tokens.access_token;
    let disc: any = await handleDirective(ctx, directive("Alexa.Discovery", "Discover", t));
    expect(disc.event.payload.endpoints.map((e: any) => e.friendlyName).sort()).toEqual(["Bedroom AC", "Front door lock", "Living room lamp"]);
    expect(disc.event.payload.endpoints.find((e: any) => e.endpointId === lamp.id).manufacturerName).toBe("HomeHub (simulated)");
    await setRoomExposure(ctx, owner, hid, ac.roomId, false);
    disc = await handleDirective(ctx, directive("Alexa.Discovery", "Discover", t));
    expect(disc.event.payload.endpoints).toHaveLength(2);

    const on: any = await handleDirective(ctx, directive("Alexa.PowerController", "TurnOn", t, lamp.id));
    expect(on.event.header.name).toBe("Response");
    expect(on.context.properties.find((p: any) => p.name === "powerState").value).toBe("ON");

    const unlock: any = await handleDirective(ctx, directive("Alexa.LockController", "Unlock", t, door.id));
    expect(unlock.event.payload.type).toBe("NOT_SUPPORTED_IN_CURRENT_MODE");
    expect((await ctx.db.doc(`households/${hid}/devices/${door.id}`).get()).data()!.state.lock).toBe("LOCKED");

    const hidden: any = await handleDirective(ctx, directive("Alexa.PowerController", "TurnOn", t, ac.id));
    expect(hidden.event.payload.type).toBe("NO_SUCH_ENDPOINT");
    const notExposed: any = await handleDirective(ctx, directive("Alexa.PowerController", "TurnOn", t, by("kitchen-plug").id));
    expect(notExposed.event.payload.type).toBe("NO_SUCH_ENDPOINT");

    // A device id from another household is never reachable with this token.
    await connectIntegration(ctx, { uid: "p1_other", kind: "user" }, hid2, { pluginId: "homehub.demo-devices", consent: true });
    const other = ((await listDevices(ctx, hid2, { uid: "p1_other", kind: "user" })).devices as any[]).find((d) => d.externalId === "living-lamp");
    await setDeviceExposure(ctx, { uid: "p1_other", kind: "user" }, hid2, other.id, { alexaExposed: true });
    expect(((await handleDirective(ctx, directive("Alexa.PowerController", "TurnOn", t, other.id))) as any).event.payload.type).toBe("NO_SUCH_ENDPOINT");

    const state: any = await handleDirective(ctx, directive("Alexa", "ReportState", t, lamp.id));
    expect(state.event.header.name).toBe("StateReport");
    const range: any = await handleDirective(ctx, directive("Alexa.ThermostatController", "SetTargetTemperature", t, lamp.id, { targetSetpoint: { value: 40, scale: "CELSIUS" } }));
    expect(range.event.payload.type).toBe("TEMPERATURE_VALUE_OUT_OF_RANGE");
  });

  it("forwarder requests must carry a fresh HMAC", async () => {
    const body = JSON.stringify({ directive: { header: { namespace: "Alexa.Discovery", name: "Discover", payloadVersion: "3", messageId: "m" }, payload: { scope: { type: "BearerToken", token: "hha_x" } } } });
    const t = Math.floor(Date.now() / 1000);
    const send = (sig: string, ts = t) => fetch(`${app.url}/smart-home`, { method: "POST", headers: { "Content-Type": "application/json", "X-HomeHub-Forwarder-Timestamp": String(ts), "X-HomeHub-Forwarder-Signature": sig }, body });
    expect((await send("0".repeat(64))).status).toBe(401);
    expect((await send(signForwarded("fwd-secret", t - 900, body), t - 900)).status).toBe(401);
    const ok = await send(signForwarded("fwd-secret", t, body));
    expect(ok.status).toBe(200);
    expect((await ok.json()).event.payload.type).toBe("INVALID_AUTHORIZATION_CREDENTIAL");
  });

  it("AcceptGrant stores Event Gateway tokens; app-side changes send a ChangeReport", async () => {
    const { by } = await connectDemo();
    const { tokens } = await linkUser();
    const lamp = by("living-lamp");
    await setDeviceExposure(ctx, owner, hid, lamp.id, { alexaExposed: true });
    lwaCalls.length = 0;
    const grant: any = await handleDirective(ctx, { directive: { header: { namespace: "Alexa.Authorization", name: "AcceptGrant", payloadVersion: "3", messageId: "g1" }, payload: { grant: { type: "OAuth2.AuthorizationCode", code: "grant-code" }, grantee: { type: "BearerToken", token: tokens.access_token } } } as never }, { fetchImpl: amazon });
    expect(grant.event.header.name).toBe("AcceptGrant.Response");
    expect(lwaCalls[0]).toContain("grant_type=authorization_code");
    await executeDeviceAction(ctx, hid, owner, lamp.id, { type: "power", value: "ON" }, { channel: "app", origin: { channel: "app" } });
    const report = lwaCalls.find((c) => c.startsWith("event:"));
    expect(report).toBeTruthy();
    const ev = JSON.parse(report!.slice(6));
    expect(ev.event.header.name).toBe("ChangeReport");
    expect(ev.event.payload.change.cause.type).toBe("APP_INTERACTION");
    expect(ev.event.payload.change.properties[0]).toMatchObject({ name: "powerState", value: "ON" });
  });

  it("custom skill: link card when unlinked, confirmation before adding, no finance in briefings", async () => {
    const unlinked: any = await handleCustomSkill(ctx, { request: { type: "LaunchRequest" }, context: { System: { user: {} } } });
    expect(unlinked.response.card.type).toBe("LinkAccount");
    const { tokens } = await linkUser();
    const sys = { System: { user: { accessToken: tokens.access_token } } };
    await createShoppingList(ctx, hid, owner, "Weekly");
    const intent = (name: string, extra: Record<string, unknown> = {}) => handleCustomSkill(ctx, { context: sys, request: { type: "IntentRequest", intent: { name, ...extra } } }) as Promise<any>;
    const ask = await intent("AddShoppingItemIntent", { slots: { item: { name: "item", value: "eggs" } }, confirmationStatus: "NONE" });
    expect(ask.response.directives[0].type).toBe("Dialog.ConfirmIntent");
    expect((await intent("ShoppingListIntent")).response.outputSpeech.text).toBe("Your shopping list is empty.");
    await intent("AddShoppingItemIntent", { slots: { item: { name: "item", value: "eggs" } }, confirmationStatus: "CONFIRMED" });
    expect((await intent("ShoppingListIntent")).response.outputSpeech.text).toContain("eggs");
    await ctx.db.collection(`households/${hid}/bills`).add({ name: "Electricity", amountMinor: 245000, currency: "INR", active: true, nextDueAt: new Date(Date.now() + 86400_000), householdId: hid });
    const brief = await intent("BriefingIntent");
    expect(brief.response.outputSpeech.text).not.toMatch(/Electricity|2,450|₹|bill/i);
  });
});
