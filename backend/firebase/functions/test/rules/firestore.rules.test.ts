import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where,
} from "firebase/firestore";

let env: RulesTestEnvironment;
const A = "hhA";
const B = "hhB";

const meta = (uid: string, hid = A) => ({ householdId: hid, createdBy: uid, createdAt: serverTimestamp(), updatedBy: uid, updatedAt: serverTimestamp(), version: 1 });
const bump = (uid: string, version: number) => ({ version: version + 1, updatedBy: uid, updatedAt: serverTimestamp() });

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-homehub",
    firestore: { rules: readFileSync(resolve(__dirname, "../../../firestore.rules"), "utf8") },
  });
});
afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const members: Array<[string, string, string, Record<string, unknown>?]> = [
      [A, "ownerA", "owner"], [A, "adminA", "admin"], [A, "adultA", "adult"], [A, "nofinA", "adult", { finance: false }],
      [A, "childA", "child"], [A, "staffA", "staff"], [A, "removedA", "adult"], [B, "ownerB", "owner"],
    ];
    await setDoc(doc(db, `households/${A}`), { name: "A", currency: "INR", timezone: "Asia/Kolkata", ownerUid: "ownerA", autonomy: { mode: "routine", paused: false } });
    await setDoc(doc(db, `households/${B}`), { name: "B", currency: "USD", timezone: "UTC", ownerUid: "ownerB" });
    for (const [h, uid, role, perms] of members) {
      await setDoc(doc(db, `households/${h}/members/${uid}`), { uid, role, status: uid === "removedA" ? "removed" : "active", permissions: perms ?? {} });
    }
    const now = Timestamp.now();
    const base = { householdId: A, createdBy: "ownerA", createdAt: now, updatedBy: "ownerA", updatedAt: now, version: 1 };
    await setDoc(doc(db, `households/${A}/tasks/tStaff`), { ...base, title: "Mop", status: "open", priority: "normal", assigneeUid: "staffA" });
    await setDoc(doc(db, `households/${A}/tasks/tFree`), { ...base, title: "Pay school fee", status: "open", priority: "high", assigneeUid: null });
    await setDoc(doc(db, `households/${B}/tasks/tB`), { ...base, householdId: B, title: "B task", status: "open", priority: "normal" });
    await setDoc(doc(db, `households/${A}/transactions/tx1`), { ...base, type: "expense", amountMinor: 50000, currency: "INR", category: "Groceries", paymentMethod: "upi", occurredAt: now, locked: false });
    await setDoc(doc(db, `households/${A}/transactions/txLocked`), { ...base, type: "expense", amountMinor: 1000, currency: "INR", category: "Bills", paymentMethod: "upi", occurredAt: now, locked: true });
    await setDoc(doc(db, `households/${A}/documents/dOpen`), { ...base, title: "Lease", restricted: false, storagePath: `households/${A}/documents/dOpen/lease.pdf` });
    await setDoc(doc(db, `households/${A}/documents/dPriv`), { ...base, title: "Will", restricted: true, allowedUids: ["adultA"], storagePath: `households/${A}/documents/dPriv/will.pdf` });
    await setDoc(doc(db, `households/${A}/notes/nPriv`), { ...base, createdBy: "adultA", visibility: "private", body: "secret" });
    await setDoc(doc(db, `households/${A}/approvals/ap1`), { householdId: A, status: "pending", requestedBy: "adultA", action: "purchase_items" });
    await setDoc(doc(db, `households/${A}/agentUsage/u1`), { householdId: A, inputTokens: 10 });
    await setDoc(doc(db, `households/${A}/notifications/n1`), { householdId: A, recipientUid: "adultA", title: "x", body: "y", readAt: null });
    await setDoc(doc(db, `households/${A}/bills/b1`), { ...base, name: "Electricity", amountMinor: 120000, currency: "INR" });
    await setDoc(doc(db, `households/${A}/pantryItems/p1`), { ...base, name: "Rice", quantity: 5, unit: "kg" });
    await setDoc(doc(db, `agentGrants/g1`), { householdId: A, uid: "adultA" });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();

describe("tenancy & identity", () => {
  it("denies unauthenticated access", async () => {
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), `households/${A}`)));
  });
  it("isolates households from each other", async () => {
    await assertSucceeds(getDoc(doc(as("ownerA"), `households/${A}`)));
    await assertFails(getDoc(doc(as("ownerB"), `households/${A}`)));
    await assertFails(getDoc(doc(as("ownerB"), `households/${A}/tasks/tFree`)));
    await assertFails(getDoc(doc(as("ownerA"), `households/${B}/tasks/tB`)));
    await assertFails(setDoc(doc(as("ownerB"), `households/${A}/tasks/x`), { ...meta("ownerB"), title: "intrude", status: "open", priority: "normal" }));
  });
  it("treats removed members as non-members", async () => {
    await assertFails(getDoc(doc(as("removedA"), `households/${A}`)));
  });
  it("never lets clients write memberships or escalate roles", async () => {
    await assertFails(updateDoc(doc(as("ownerA"), `households/${A}/members/adultA`), { role: "admin" }));
    await assertFails(setDoc(doc(as("adultA"), `households/${A}/members/adultA`), { uid: "adultA", role: "owner", status: "active" }));
    await assertFails(setDoc(doc(as("ownerB"), `households/${A}/members/ownerB`), { uid: "ownerB", role: "owner", status: "active" }));
    await assertFails(setDoc(doc(as("intruder"), `households/new`), { name: "x", ownerUid: "intruder" }));
  });
  it("lets managers edit household settings but not ownership or autonomy", async () => {
    await assertSucceeds(updateDoc(doc(as("adminA"), `households/${A}`), { name: "Home", currency: "INR", updatedBy: "adminA", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as("adminA"), `households/${A}`), { name: "Home", currency: "INR", ownerUid: "adminA", updatedBy: "adminA" }));
    await assertFails(updateDoc(doc(as("adminA"), `households/${A}`), { name: "Home", currency: "INR", autonomy: { mode: "advanced", paused: false }, updatedBy: "adminA" }));
    await assertFails(updateDoc(doc(as("adultA"), `households/${A}`), { name: "Mine", currency: "INR", updatedBy: "adultA" }));
  });
  it("only lets a user point activeHouseholdId at their own household", async () => {
    await assertSucceeds(setDoc(doc(as("adultA"), `users/adultA`), { displayName: "Asha", activeHouseholdId: A }));
    await assertFails(updateDoc(doc(as("adultA"), `users/adultA`), { activeHouseholdId: B }));
    await assertFails(getDoc(doc(as("adultA"), `users/ownerA`)));
  });
});

describe("tasks", () => {
  it("validates creation metadata", async () => {
    await assertSucceeds(setDoc(doc(as("adultA"), `households/${A}/tasks/n1`), { ...meta("adultA"), title: "Water plants", status: "open", priority: "low" }));
    await assertFails(setDoc(doc(as("adultA"), `households/${A}/tasks/n2`), { ...meta("ownerA"), title: "Spoof", status: "open", priority: "low" }));
    await assertFails(setDoc(doc(as("adultA"), `households/${A}/tasks/n3`), { ...meta("adultA"), version: 7, title: "Bad version", status: "open", priority: "low" }));
    await assertFails(setDoc(doc(as("adultA"), `households/${B}/tasks/n4`), { ...meta("adultA", B), title: "Other house", status: "open", priority: "low" }));
    await assertFails(setDoc(doc(as("adultA"), `households/${A}/tasks/n5`), { ...meta("adultA"), title: "x", status: "weird", priority: "low" }));
  });
  it("children may only create tasks for themselves", async () => {
    await assertSucceeds(setDoc(doc(as("childA"), `households/${A}/tasks/c1`), { ...meta("childA"), title: "Homework", status: "open", priority: "normal", assigneeUid: "childA" }));
    await assertFails(setDoc(doc(as("childA"), `households/${A}/tasks/c2`), { ...meta("childA"), title: "Chore for mum", status: "open", priority: "normal", assigneeUid: "adultA" }));
  });
  it("staff see and complete only their assigned work", async () => {
    const db = as("staffA");
    await assertSucceeds(getDoc(doc(db, `households/${A}/tasks/tStaff`)));
    await assertFails(getDoc(doc(db, `households/${A}/tasks/tFree`)));
    await assertSucceeds(getDocs(query(collection(db, `households/${A}/tasks`), where("assigneeUid", "==", "staffA"))));
    await assertFails(getDocs(collection(db, `households/${A}/tasks`)));
    await assertSucceeds(updateDoc(doc(db, `households/${A}/tasks/tStaff`), { status: "done", completedBy: "staffA", completedAt: serverTimestamp(), ...bump("staffA", 1) }));
    await assertFails(updateDoc(doc(db, `households/${A}/tasks/tStaff`), { title: "Renamed", ...bump("staffA", 2) }));
    await assertFails(setDoc(doc(db, `households/${A}/tasks/s1`), { ...meta("staffA"), title: "x", status: "open", priority: "low" }));
  });
  it("requires optimistic-concurrency version bumps and immutable fields", async () => {
    const db = as("adultA");
    await assertFails(updateDoc(doc(db, `households/${A}/tasks/tFree`), { title: "No bump", updatedBy: "adultA", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, `households/${A}/tasks/tFree`), { title: "Stale", ...bump("adultA", 5) }));
    await assertFails(updateDoc(doc(db, `households/${A}/tasks/tFree`), { createdBy: "adultA", ...bump("adultA", 1) }));
    await assertSucceeds(updateDoc(doc(db, `households/${A}/tasks/tFree`), { title: "Pay school fee today", ...bump("adultA", 1) }));
  });
});

describe("finance privacy", () => {
  it("restricts finance to permitted adults", async () => {
    await assertSucceeds(getDoc(doc(as("adultA"), `households/${A}/transactions/tx1`)));
    await assertFails(getDoc(doc(as("nofinA"), `households/${A}/transactions/tx1`)));
    await assertFails(getDoc(doc(as("childA"), `households/${A}/transactions/tx1`)));
    await assertFails(getDoc(doc(as("staffA"), `households/${A}/bills/b1`)));
    await assertFails(getDoc(doc(as("ownerB"), `households/${A}/transactions/tx1`)));
  });
  it("only accepts integer minor units and never edits locked records", async () => {
    const db = as("adultA");
    const tx = { ...meta("adultA"), type: "expense", currency: "INR", category: "Food", paymentMethod: "cash", occurredAt: Timestamp.now() };
    await assertSucceeds(setDoc(doc(db, `households/${A}/transactions/ok`), { ...tx, amountMinor: 12345 }));
    await assertFails(setDoc(doc(db, `households/${A}/transactions/float`), { ...tx, amountMinor: 123.45 }));
    await assertFails(setDoc(doc(db, `households/${A}/transactions/neg`), { ...tx, amountMinor: -5 }));
    await assertFails(updateDoc(doc(db, `households/${A}/transactions/txLocked`), { amountMinor: 1, ...bump("adultA", 1) }));
    await assertFails(deleteDoc(doc(db, `households/${A}/transactions/tx1`))); // adults cannot delete
  });
  it("keeps bill payment history append-only and self-confirmed", async () => {
    const db = as("adultA");
    const p = { householdId: A, billId: "b1", amountMinor: 120000, currency: "INR", confirmedBy: "adultA", createdAt: serverTimestamp() };
    await assertSucceeds(setDoc(doc(db, `households/${A}/billPayments/p1`), p));
    await assertFails(setDoc(doc(db, `households/${A}/billPayments/p2`), { ...p, confirmedBy: "ownerA" }));
    await assertFails(updateDoc(doc(db, `households/${A}/billPayments/p1`), { amountMinor: 1 }));
    await assertFails(deleteDoc(doc(as("ownerA"), `households/${A}/billPayments/p1`)));
  });
});

describe("documents, notes, pantry", () => {
  it("enforces restricted documents", async () => {
    await assertSucceeds(getDoc(doc(as("adultA"), `households/${A}/documents/dPriv`)));
    await assertFails(getDoc(doc(as("nofinA"), `households/${A}/documents/dPriv`)));
    await assertSucceeds(getDoc(doc(as("adminA"), `households/${A}/documents/dPriv`)));
    await assertSucceeds(getDoc(doc(as("nofinA"), `households/${A}/documents/dOpen`)));
    await assertFails(getDoc(doc(as("childA"), `households/${A}/documents/dOpen`)));
    await assertFails(setDoc(doc(as("adultA"), `households/${A}/documents/bad`), { ...meta("adultA"), title: "x", storagePath: `households/${B}/documents/bad/x.pdf` }));
  });
  it("keeps private notes private", async () => {
    await assertSucceeds(getDoc(doc(as("adultA"), `households/${A}/notes/nPriv`)));
    await assertFails(getDoc(doc(as("ownerA"), `households/${A}/notes/nPriv`)));
  });
  it("keeps pantry movements append-only", async () => {
    const db = as("staffA");
    const mv = { householdId: A, createdBy: "staffA", createdAt: serverTimestamp(), kind: "consume", delta: -1 };
    const ref = await assertSucceeds(addDoc(collection(db, `households/${A}/pantryMovements`), mv));
    await assertFails(updateDoc(ref, { delta: -100 }));
    await assertFails(addDoc(collection(db, `households/${A}/pantryMovements`), { ...mv, kind: "steal" }));
  });
});

describe("server-only agent and audit data", () => {
  it("blocks client writes to approvals, usage, logs, grants", async () => {
    await assertFails(updateDoc(doc(as("ownerA"), `households/${A}/approvals/ap1`), { status: "approved" }));
    await assertFails(setDoc(doc(as("ownerA"), `households/${A}/activityLogs/l1`), { action: "fake" }));
    await assertFails(setDoc(doc(as("ownerA"), `households/${A}/agentUsage/u2`), { inputTokens: 0 }));
    await assertFails(getDoc(doc(as("ownerA"), `agentGrants/g1`)));
  });
  it("lets approvers and requesters read approvals; usage is managers-only", async () => {
    await assertSucceeds(getDoc(doc(as("adultA"), `households/${A}/approvals/ap1`)));
    await assertFails(getDoc(doc(as("staffA"), `households/${A}/approvals/ap1`)));
    await assertSucceeds(getDoc(doc(as("adminA"), `households/${A}/agentUsage/u1`)));
    await assertFails(getDoc(doc(as("adultA"), `households/${A}/agentUsage/u1`)));
  });
  it("lets recipients only mark notifications read", async () => {
    await assertSucceeds(updateDoc(doc(as("adultA"), `households/${A}/notifications/n1`), { readAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as("adultA"), `households/${A}/notifications/n1`), { body: "changed" }));
    await assertFails(getDoc(doc(as("ownerA"), `households/${A}/notifications/n1`)));
  });
});
