import { createVerify, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

/**
 * Verification of requests sent by Alexa to a custom-skill HTTPS endpoint
 * ("Verify that the request was sent by Alexa" in the Alexa Skills Kit docs):
 *  1. SignatureCertChainUrl: https, host s3.amazonaws.com, path under /echo.api/, port 443.
 *  2. Download the PEM chain; leaf valid now, SAN includes echo-api.amazon.com,
 *     chain links verify and end at a trusted root CA.
 *  3. Signature-256 header = base64 RSA-SHA256 of the raw body under the leaf key.
 *  4. request.timestamp within 150 seconds.
 *  5. session/context application id equals the configured skill id.
 */
export class AlexaVerificationError extends Error {}

export function validCertUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol.toLowerCase() !== "https:") return false;
  if (u.hostname.toLowerCase() !== "s3.amazonaws.com") return false;
  if (u.port && u.port !== "443") return false;
  // URL() already normalises dot segments, so "/echo.api/../x" becomes "/x".
  return u.pathname.startsWith("/echo.api/");
}

function splitPem(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

let trustedRoots: X509Certificate[] | null = null;
function roots(): X509Certificate[] {
  if (!trustedRoots) trustedRoots = rootCertificates.map((r) => { try { return new X509Certificate(r); } catch { return null; } }).filter((x): x is X509Certificate => !!x);
  return trustedRoots;
}

export function verifyChain(chain: X509Certificate[], now: Date, trust: X509Certificate[] = roots()): X509Certificate {
  if (!chain.length) throw new AlexaVerificationError("empty certificate chain");
  const leaf = chain[0];
  for (const c of chain) {
    if (new Date(c.validFrom) > now || new Date(c.validTo) < now) throw new AlexaVerificationError("certificate not valid now");
  }
  const san = leaf.subjectAltName ?? "";
  if (!san.split(/,\s*/).some((e) => e.trim().toLowerCase() === "dns:echo-api.amazon.com")) throw new AlexaVerificationError("SAN mismatch");
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) throw new AlexaVerificationError("broken chain");
  }
  const top = chain[chain.length - 1];
  const anchored = trust.some((r) => (top.fingerprint256 === r.fingerprint256) || (top.checkIssued(r) && top.verify(r.publicKey)));
  if (!anchored) throw new AlexaVerificationError("untrusted root");
  return leaf;
}

const certCache = new Map<string, { pem: string; at: number }>();

export interface VerifyOptions {
  skillId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  trust?: X509Certificate[];
  toleranceSeconds?: number;
}

export async function verifyAlexaRequest(headers: Record<string, string | string[] | undefined>, rawBody: Buffer | string, opts: VerifyOptions): Promise<Record<string, unknown>> {
  const h = (k: string) => { const v = headers[k] ?? headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
  const certUrl = h("signaturecertchainurl");
  const sig = h("signature-256");
  if (!validCertUrl(certUrl)) throw new AlexaVerificationError("invalid certificate URL");
  if (!sig) throw new AlexaVerificationError("missing signature");
  const now = opts.now ?? new Date();

  let pem = certCache.get(certUrl!)?.pem;
  if (!pem) {
    const res = await (opts.fetchImpl ?? fetch)(certUrl!);
    if (!res.ok) throw new AlexaVerificationError("certificate download failed");
    pem = await res.text();
    certCache.set(certUrl!, { pem, at: now.getTime() });
    if (certCache.size > 20) certCache.delete(certCache.keys().next().value!);
  }
  const leaf = verifyChain(splitPem(pem), now, opts.trust);

  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const v = createVerify("RSA-SHA256");
  v.update(body);
  if (!v.verify(leaf.publicKey, sig, "base64")) throw new AlexaVerificationError("bad signature");

  let json: Record<string, any>;
  try { json = JSON.parse(body.toString("utf8")); } catch { throw new AlexaVerificationError("invalid JSON"); }
  const tsMs = Date.parse(json?.request?.timestamp ?? "");
  if (!Number.isFinite(tsMs) || Math.abs(now.getTime() - tsMs) > (opts.toleranceSeconds ?? 150) * 1000) throw new AlexaVerificationError("stale request");
  const appId = json?.context?.System?.application?.applicationId ?? json?.session?.application?.applicationId;
  if (appId !== opts.skillId) throw new AlexaVerificationError("wrong application id");
  return json;
}

/** Test hook. */
export function _clearCertCache() { certCache.clear(); }
