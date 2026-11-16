import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handler, sign } from "./index.mjs";

const event = { directive: { header: { namespace: "Alexa.Discovery", name: "Discover", payloadVersion: "3", messageId: "m1" }, payload: { scope: { type: "BearerToken", token: "hha_x" } } } };

test("signs the exact forwarded body and relays HomeHub's response", async () => {
  process.env.HOMEHUB_SMART_HOME_URL = "https://example.test/alexa/smart-home";
  process.env.FORWARDER_SECRET = "s";
  let seen;
  const out = await handler(event, {}, { fetch: async (url, init) => { seen = init; return new Response(JSON.stringify({ event: { header: { name: "Discover.Response" } } })); } });
  assert.equal(out.event.header.name, "Discover.Response");
  const t = seen.headers["X-HomeHub-Forwarder-Timestamp"];
  assert.equal(seen.headers["X-HomeHub-Forwarder-Signature"], createHmac("sha256", "s").update(`${t}.${seen.body}`).digest("hex"));
  assert.equal(sign("s", 1, "x"), createHmac("sha256", "s").update("1.x").digest("hex"));
});

test("returns an Alexa ErrorResponse when HomeHub is down or unconfigured", async () => {
  process.env.HOMEHUB_SMART_HOME_URL = "https://example.test/x";
  process.env.FORWARDER_SECRET = "s";
  const down = await handler(event, {}, { fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.event.payload.type, "BRIDGE_UNREACHABLE");
  delete process.env.FORWARDER_SECRET;
  assert.equal((await handler(event, {})).event.payload.type, "INTERNAL_ERROR");
});
