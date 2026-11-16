import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";

let env: RulesTestEnvironment;
const A = "hhA";
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-homehub",
    firestore: { rules: readFileSync(resolve(__dirname, "../../../firestore.rules"), "utf8") },
    storage: { rules: readFileSync(resolve(__dirname, "../../../storage.rules"), "utf8") },
  });
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    for (const [uid, role, perms] of [["ownerA", "owner", {}], ["adultA", "adult", {}], ["nofinA", "adult", { finance: false }], ["staffA", "staff", {}]] as const) {
      await setDoc(doc(db, `households/${A}/members/${uid}`), { uid, role, status: "active", permissions: perms });
    }
    await setDoc(doc(db, `households/${A}/documents/dPriv`), { restricted: true, allowedUids: ["adultA"] });
    await uploadBytes(ref(c.storage(), `households/${A}/documents/dPriv/will.pdf`), pdf, { contentType: "application/pdf" });
    await uploadBytes(ref(c.storage(), `households/${A}/receipts/tx1/r.pdf`), pdf, { contentType: "application/pdf" });
  });
});
afterAll(async () => { await env?.cleanup(); });

const st = (uid: string) => env.authenticatedContext(uid).storage();

describe("storage rules mirror Firestore membership", () => {
  it("isolates households", async () => {
    await assertFails(getBytes(ref(st("ownerB"), `households/${A}/receipts/tx1/r.pdf`)));
    await assertFails(uploadBytes(ref(st("ownerB"), `households/${A}/documents/x/y.pdf`), pdf, { contentType: "application/pdf" }));
  });
  it("restricts receipts to finance-permitted adults", async () => {
    await assertSucceeds(getBytes(ref(st("adultA"), `households/${A}/receipts/tx1/r.pdf`)));
    await assertFails(getBytes(ref(st("nofinA"), `households/${A}/receipts/tx1/r.pdf`)));
    await assertFails(getBytes(ref(st("staffA"), `households/${A}/receipts/tx1/r.pdf`)));
  });
  it("honours restricted document allow-lists", async () => {
    await assertSucceeds(getBytes(ref(st("adultA"), `households/${A}/documents/dPriv/will.pdf`)));
    await assertFails(getBytes(ref(st("nofinA"), `households/${A}/documents/dPriv/will.pdf`)));
    await assertSucceeds(getBytes(ref(st("ownerA"), `households/${A}/documents/dPriv/will.pdf`)));
  });
  it("rejects unsafe content types and overwrites", async () => {
    await assertFails(uploadBytes(ref(st("adultA"), `households/${A}/documents/new/x.exe`), pdf, { contentType: "application/x-msdownload" }));
    // Unique path per run: objects are immutable, so a leftover from a previous run must not matter.
    const path = `households/${A}/documents/new-${Date.now()}/x.pdf`;
    await assertSucceeds(uploadBytes(ref(st("adultA"), path), pdf, { contentType: "application/pdf" }));
    await assertFails(uploadBytes(ref(st("adultA"), path), pdf, { contentType: "application/pdf" }));
  });
});
