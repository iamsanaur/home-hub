// HomeHub Alexa Smart Home forwarder (AWS Lambda, Node.js 22, no dependencies).
//
// Smart Home skills must use an AWS Lambda endpoint. This function holds no household data
// and no HomeHub credentials beyond a shared HMAC secret: it signs each directive and
// forwards it to HomeHub's `alexa` Cloud Function, which authenticates the Alexa bearer
// token, enforces exposure and device policy, verifies state, and builds the response.
//
// Environment:
//   HOMEHUB_SMART_HOME_URL   https://<region>-<project>.cloudfunctions.net/alexa/smart-home
//   FORWARDER_SECRET         same value as the ALEXA_FORWARDER_SECRET Firebase secret
//   ALEXA_SKILL_ID           optional: reject events whose skill id doesn't match (set the
//                            Lambda's Alexa Smart Home trigger with skill-id verification too)
import { createHmac, randomUUID } from "node:crypto";

const TIMEOUT_MS = 7000; // Alexa waits ~8 s for a Smart Home response

export function sign(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

function errorResponse(event, type, message) {
  const d = event?.directive ?? {};
  return {
    event: {
      header: { namespace: "Alexa", name: "ErrorResponse", payloadVersion: "3", messageId: randomUUID(), ...(d.header?.correlationToken ? { correlationToken: d.header.correlationToken } : {}) },
      ...(d.endpoint?.endpointId ? { endpoint: { endpointId: d.endpoint.endpointId } } : {}),
      payload: { type, message },
    },
  };
}

export async function handler(event, _context, deps = {}) {
  const url = process.env.HOMEHUB_SMART_HOME_URL;
  const secret = process.env.FORWARDER_SECRET;
  if (!url || !secret) return errorResponse(event, "INTERNAL_ERROR", "Forwarder is not configured");
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "X-HomeHub-Forwarder-Timestamp": String(t), "X-HomeHub-Forwarder-Signature": sign(secret, t, body) },
      body,
    });
    if (!res.ok) return errorResponse(event, "INTERNAL_ERROR", `HomeHub returned ${res.status}`);
    return await res.json();
  } catch {
    return errorResponse(event, "BRIDGE_UNREACHABLE", "HomeHub can't be reached right now");
  } finally {
    clearTimeout(timer);
  }
}
