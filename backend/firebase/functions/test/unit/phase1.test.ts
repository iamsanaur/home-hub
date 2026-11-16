import { execFileSync } from "node:child_process";
import { createSign, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { networkAllowed, validateManifest } from "../../src/plugins/manifest";
import { BUILTIN_PLUGINS } from "../../src/plugins/catalog";
import { signWebhook } from "../../src/plugins/builtins/webhook";
import { AlexaVerificationError, validCertUrl, verifyAlexaRequest, verifyChain, _clearCertCache } from "../../src/alexa/signature";
import { propertiesFor } from "../../src/alexa/smartHome";
import { signForwarded } from "../../src/alexa/app";

const base = () => structuredClone(BUILTIN_PLUGINS.find((p) => p.manifest.id === "homehub.demo-devices")!.manifest) as any;

describe("plugin manifest validator", () => {
  it("accepts every built-in manifest", () => {
    for (const p of BUILTIN_PLUGINS) expect(validateManifest(p.manifest).issues.filter((i) => i.severity === "error"), p.manifest.id).toEqual([]);
  });
  it("rejects physical-safety tools that don't require approval", () => {
    const m = base();
    m.tools.find((t: any) => t.name === "unlock").confirmation = "confirm";
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.message).join(" ")).toMatch(/approval/i);
  });
  it("rejects non-https network entries and unmarked sensitive config", () => {
    const m = base();
    m.network = ["http://api.example.com"];
    m.config.push({ key: "apiToken", label: "API token", type: "string", required: true, secret: false });
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });
  it("network allowlist: only declared https hosts, plus user-configured endpoints", () => {
    const m = base();
    m.network = ["https://api.example.com"];
    m.userNetworkFields = [];
    expect(networkAllowed(m, "https://api.example.com/v1/x")).toBe(true);
    expect(networkAllowed(m, "https://evil.example.net/")).toBe(false);
    expect(networkAllowed(m, "http://api.example.com/")).toBe(false);
    const w = structuredClone(BUILTIN_PLUGINS.find((p) => p.manifest.id === "homehub.webhook")!.manifest);
    expect(networkAllowed(w, "https://hooks.example.org/in", { outboundUrl: "https://hooks.example.org/in" })).toBe(true);
    expect(networkAllowed(w, "https://other.example.org/in", { outboundUrl: "https://hooks.example.org/in" })).toBe(false);
  });
});

describe("signatures", () => {
  it("webhook HMAC is deterministic and covers timestamp + body", () => {
    const a = signWebhook("s3cret", 1700000000, '{"a":1}');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(signWebhook("s3cret", 1700000001, '{"a":1}')).not.toBe(a);
    expect(signWebhook("s3cret", 1700000000, '{"a":2}')).not.toBe(a);
    expect(signForwarded("k", 1, Buffer.from("x"))).toBe(signForwarded("k", 1, "x"));
  });
});

describe("Alexa request verification", () => {
  let dir: string;
  let leafKey: string;
  let chainPem: string;
  let root: X509Certificate;
  const CERT_URL = "https://s3.amazonaws.com/echo.api/echo-api-cert-test.pem";
  const SKILL = "amzn1.ask.skill.test";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "alexa-sig-"));
    const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
    o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
    o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=echo-api.amazon.com");
    writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:echo-api.amazon.com\n");
    o("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "ext.cnf");
    leafKey = readFileSync(join(dir, "leaf.key"), "utf8");
    chainPem = readFileSync(join(dir, "leaf.pem"), "utf8") + readFileSync(join(dir, "ca.pem"), "utf8");
    root = new X509Certificate(readFileSync(join(dir, "ca.pem")));
  });

  const request = (over: Record<string, unknown> = {}) => JSON.stringify({
    version: "1.0", context: { System: { application: { applicationId: SKILL } } },
    request: { type: "LaunchRequest", requestId: "r1", timestamp: new Date().toISOString(), ...over },
  });
  const sign = (body: string) => { const s = createSign("RSA-SHA256"); s.update(body); return s.sign(leafKey, "base64"); };
  const fetchPem = (async () => new Response(chainPem)) as unknown as typeof fetch;

  it("validates the certificate URL exactly as Amazon specifies", () => {
    expect(validCertUrl("https://s3.amazonaws.com/echo.api/echo-api-cert.pem")).toBe(true);
    expect(validCertUrl("https://s3.amazonaws.com:443/echo.api/echo-api-cert.pem")).toBe(true);
    expect(validCertUrl("https://S3.AMAZONAWS.COM/echo.api/x.pem")).toBe(true);
    expect(validCertUrl("http://s3.amazonaws.com/echo.api/x.pem")).toBe(false);
    expect(validCertUrl("https://s3.amazonaws.com/EcHo.aPi/x.pem")).toBe(false);
    expect(validCertUrl("https://s3.amazonaws.com/invalid.path/x.pem")).toBe(false);
    expect(validCertUrl("https://s3.amazonaws.com/echo.api/../invalid.path/x.pem")).toBe(false);
    expect(validCertUrl("https://s3.amazonaws.com:563/echo.api/x.pem")).toBe(false);
    expect(validCertUrl("https://evil.com/echo.api/x.pem")).toBe(false);
  });

  it("accepts a correctly signed, fresh request for this skill", async () => {
    _clearCertCache();
    const body = request();
    const json = await verifyAlexaRequest({ signaturecertchainurl: CERT_URL, "signature-256": sign(body) }, body, { skillId: SKILL, fetchImpl: fetchPem, trust: [root] });
    expect((json.request as any).type).toBe("LaunchRequest");
  });

  it("rejects tampered bodies, stale timestamps, other skills and untrusted chains", async () => {
    _clearCertCache();
    const body = request();
    const h = { signaturecertchainurl: CERT_URL, "signature-256": sign(body) };
    await expect(verifyAlexaRequest(h, body.replace("LaunchRequest", "IntentRequest"), { skillId: SKILL, fetchImpl: fetchPem, trust: [root] })).rejects.toThrow(/bad signature/);
    const stale = request({ timestamp: new Date(Date.now() - 151_000).toISOString() });
    await expect(verifyAlexaRequest({ ...h, "signature-256": sign(stale) }, stale, { skillId: SKILL, fetchImpl: fetchPem, trust: [root] })).rejects.toThrow(/stale/);
    await expect(verifyAlexaRequest(h, body, { skillId: "amzn1.ask.skill.other", fetchImpl: fetchPem, trust: [root] })).rejects.toThrow(/application id/);
    _clearCertCache();
    await expect(verifyAlexaRequest(h, body, { skillId: SKILL, fetchImpl: fetchPem })).rejects.toBeInstanceOf(AlexaVerificationError); // system roots don't trust the test CA
    await expect(verifyAlexaRequest({ ...h, signaturecertchainurl: "https://evil.com/echo.api/x.pem" }, body, { skillId: SKILL, fetchImpl: fetchPem, trust: [root] })).rejects.toThrow(/certificate URL/);
  });

  it("rejects a leaf without the echo-api SAN and expired chains", () => {
    const chain = [new X509Certificate(chainPem.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----"), root];
    expect(() => verifyChain(chain, new Date(Date.now() + 5 * 86400_000), [root])).toThrow(/not valid now/);
    expect(() => verifyChain([root], new Date(), [root])).toThrow(/SAN/);
  });
});

describe("Alexa Smart Home state", () => {
  it("reports only verified state and marks stale devices unreachable", () => {
    const now = new Date();
    const fresh = propertiesFor({ capabilities: ["power", "brightness"], state: { power: "ON", brightness: 40 }, reachable: true, lastSeenAt: { toDate: () => now }, stateUpdatedAt: { toDate: () => now } }, now);
    expect(fresh.reachable).toBe(true);
    expect(fresh.properties.map((p) => p.name)).toEqual(["connectivity", "powerState", "brightness"]);
    const stale = propertiesFor({ capabilities: ["power"], state: { power: "ON" }, reachable: true, lastSeenAt: { toDate: () => new Date(now.getTime() - 2 * 3600_000) } }, now);
    expect(stale.reachable).toBe(false);
    expect(stale.properties[0].value).toEqual({ value: "UNREACHABLE" });
  });
});
