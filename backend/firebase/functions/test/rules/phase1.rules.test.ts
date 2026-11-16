import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

let env: RulesTestEnvironment;
const A = "hhA", B = "hhB";

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-homehub", firestore: { rules: readFileSync(resolve(__dirname, "../../../firestore.rules"), "utf8") } });
});
afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    for (const [h, uid, role] of [[A, "ownerA", "owner"], [A, "adultA", "adult"], [A, "adult2A", "adult"], [A, "childA", "child"], [A, "staffA", "staff"], [B, "ownerB", "owner"]]) {
      await setDoc(doc(db, `households/${h}/members/${uid}`), { uid, role, status: "active", permissions: {} });
    }
    await setDoc(doc(db, `households/${A}/devices/lamp`), { householdId: A, name: "Lamp", safety: "normal", state: { power: "OFF" } });
    await setDoc(doc(db, `households/${A}/devices/door`), { householdId: A, name: "Front door", safety: "physical_safety", state: { lock: "LOCKED" } });
    await setDoc(doc(db, `households/${A}/integrations/hh`), { householdId: A, scope: "household", ownerUid: "ownerA", status: "connected" });
    await setDoc(doc(db, `households/${A}/integrations/mine`), { householdId: A, scope: "personal", ownerUid: "adultA", status: "connected", category: "ai_provider" });
    await setDoc(doc(db, `households/${A}/integrationSecretsRefs/hh`), { refs: { apiKey: "projects/x/secrets/y" } });
    await setDoc(doc(db, `households/${A}/auditEvents/e1`), { actorUid: "adultA", requestedAction: "x" });
    await setDoc(doc(db, `households/${A}/auditEvents/e2`), { actorUid: "ownerA", requestedAction: "y" });
    await setDoc(doc(db, `households/${A}/automations/a1`), { name: "Night", enabled: true });
    await setDoc(doc(db, `alexaTokens/t1`), { linkId: "l1", type: "access" });
    await setDoc(doc(db, `alexaLinks/l1`), { uid: "adultA", householdId: A });
    await setDoc(doc(db, `oauthStates/s1`), { verifier: "v" });
    await setDoc(doc(db, `bridgeCredentials/c1`), { householdId: A });
    await setDoc(doc(db, `_devSecrets/k1`), { value: "secret" });
    await setDoc(doc(db, `pluginCatalog/homehub.demo-devices`), { killSwitch: false });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();

describe("phase 1 rules: server-written, policy-gated collections", () => {
  it("no client can write devices, integrations, automations or audit events", async () => {
    await assertFails(updateDoc(doc(as("ownerA"), `households/${A}/devices/lamp`), { "state.power": "ON" }));
    await assertFails(setDoc(doc(as("ownerA"), `households/${A}/devices/fake`), { name: "Fake", safety: "normal" }));
    await assertFails(updateDoc(doc(as("ownerA"), `households/${A}/integrations/hh`), { status: "connected", enabledTools: ["unlock"] }));
    await assertFails(setDoc(doc(as("ownerA"), `households/${A}/automations/a2`), { name: "x" }));
    await assertFails(setDoc(doc(as("ownerA"), `households/${A}/auditEvents/forged`), { actorUid: "ownerA" }));
    await assertFails(updateDoc(doc(as("ownerA"), `pluginCatalog/homehub.demo-devices`), { killSwitch: true }));
  });
  it("captured spending is readable only by finance-permitted members of the household, and never client-written", async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), `households/${A}/spendCaptures/c1`), { status: "pending", amountMinor: 45000, currency: "INR" });
      await setDoc(doc(c.firestore(), `households/${A}/spendRules/r1`), { merchant: "Swiggy", category: "Dining" });
    });
    await assertSucceeds(getDoc(doc(as("ownerA"), `households/${A}/spendCaptures/c1`)));
    await assertSucceeds(getDoc(doc(as("adultA"), `households/${A}/spendRules/r1`)));
    await assertFails(getDoc(doc(as("childA"), `households/${A}/spendCaptures/c1`)));
    await assertFails(getDoc(doc(as("staffA"), `households/${A}/spendCaptures/c1`)));
    await assertFails(getDoc(doc(as("ownerB"), `households/${A}/spendCaptures/c1`)));
    await assertFails(setDoc(doc(as("ownerA"), `households/${A}/spendCaptures/forged`), { status: "pending", amountMinor: 1 }));
    await assertFails(updateDoc(doc(as("ownerA"), `households/${A}/spendCaptures/c1`), { status: "confirmed" }));
    await assertFails(setDoc(doc(as("ownerA"), `households/${A}/spendRules/r2`), { merchant: "X", category: "Rent" }));
  });
  it("children and staff never see physical-safety devices", async () => {
    await assertSucceeds(getDoc(doc(as("childA"), `households/${A}/devices/lamp`)));
    await assertFails(getDoc(doc(as("childA"), `households/${A}/devices/door`)));
    await assertFails(getDoc(doc(as("staffA"), `households/${A}/devices/door`)));
    await assertSucceeds(getDoc(doc(as("adultA"), `households/${A}/devices/door`)));
  });
  it("personal model accounts are visible only to their owner; secrets refs to nobody", async () => {
    await assertSucceeds(getDoc(doc(as("adultA"), `households/${A}/integrations/mine`)));
    await assertFails(getDoc(doc(as("adult2A"), `households/${A}/integrations/mine`)));
    await assertFails(getDoc(doc(as("ownerA"), `households/${A}/integrations/mine`)));
    await assertSucceeds(getDoc(doc(as("ownerA"), `households/${A}/integrations/hh`)));
    await assertFails(getDoc(doc(as("adultA"), `households/${A}/integrations/hh`)));
    await assertFails(getDoc(doc(as("ownerA"), `households/${A}/integrationSecretsRefs/hh`)));
  });
  it("audit trail: managers read all, members only their own", async () => {
    await assertSucceeds(getDoc(doc(as("ownerA"), `households/${A}/auditEvents/e1`)));
    await assertSucceeds(getDoc(doc(as("adultA"), `households/${A}/auditEvents/e1`)));
    await assertFails(getDoc(doc(as("adultA"), `households/${A}/auditEvents/e2`)));
  });
  it("cross-household isolation holds for devices and automations", async () => {
    await assertFails(getDoc(doc(as("ownerB"), `households/${A}/devices/lamp`)));
    await assertFails(getDoc(doc(as("ownerB"), `households/${A}/automations/a1`)));
    await assertFails(getDoc(doc(as("childA"), `households/${A}/automations/a1`)));
  });
  it("Alexa tokens, links, OAuth states, bridge credentials and dev secrets are server-only", async () => {
    for (const path of ["alexaTokens/t1", "alexaLinks/l1", "oauthStates/s1", "bridgeCredentials/c1", "_devSecrets/k1"]) {
      await assertFails(getDoc(doc(as("adultA"), path)));
      await assertFails(getDoc(doc(as("ownerA"), path)));
    }
    await assertSucceeds(getDoc(doc(as("adultA"), `pluginCatalog/homehub.demo-devices`)));
  });
});
