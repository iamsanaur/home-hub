import { beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, testCtx } from "./helpers";
import { Actor } from "../../src/services/base";
import { acceptInvitation, createHousehold, invite } from "../../src/services/households";
import { captureSpend, dismissCapture, listCaptures } from "../../src/finance/spendCapture";
import { importStatement, StatementImportInput } from "../../src/finance/statementImport";
import { recordExpense } from "../../src/services/finance";

const ctx = testCtx();
const owner: Actor = { uid: "si_owner", kind: "user" };
const child: Actor = { uid: "si_child", kind: "user" };
let hid: string;
let hid2: string;

beforeEach(async () => {
  await clearFirestore();
  const mk = (name: string, uid = owner.uid) => createHousehold(ctx, { uid, displayName: "O", email: `${uid}@example.com` }, { name, currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" } as never);
  hid = (await mk("Sharma Home")).householdId;
  hid2 = (await mk("Other Home", "si_other")).householdId;
  const email = `${child.uid}@example.com`;
  const inv = await invite(ctx, owner, hid, { role: "child", email });
  await acceptInvitation(ctx, { uid: child.uid, email, emailVerified: true, displayName: "C" }, inv.token);
});

const day = (n: number) => new Date(ctx.now().getTime() - n * 86_400_000);
const iso = (d: Date) => d.toISOString();
const row = (o: Record<string, unknown>) => ({ occurredAt: iso(day(2)), timeKnown: true, amountMinor: 45000, direction: "debit", merchant: "Swiggy", upiRef: "432112345678", method: "upi", ...o });
const input = (rows: unknown[], dryRun = false) => StatementImportInput.parse({ sourceApp: "phonepe", rows, dryRun });
const statuses = (r: { results: Array<{ status: string }> }) => r.results.map((x) => x.status);

describe("statement import and deduplication", () => {
  it("matches a payment already captured from an SMS by its UPI reference, and keeps the rest", async () => {
    await captureSpend(ctx, hid, owner, { source: "android_notification", text: "Rs.450.00 debited from A/c XX1234 to VPA swiggy@icici (UPI Ref No 432112345678).", receivedAt: iso(day(2)) });
    const r = await importStatement(ctx, hid, owner, input([
      row({}),                                                                   // same UTR as the SMS
      row({ upiRef: "432100000001", merchant: "Zomato", amountMinor: 29900, occurredAt: iso(day(3)) }),
    ]));
    expect(statuses(r)).toEqual(["already_captured", "new"]);
    expect(r.summary).toMatchObject({ found: 2, alreadyCaptured: 1, new: 1, imported: 1 });
    expect((await listCaptures(ctx, hid, owner)).length).toBe(2);
  });

  it("previews with dryRun without writing, then importing twice never duplicates", async () => {
    const rows = [row({ upiRef: "432100000002", merchant: "Blinkit", amountMinor: 12500 }), row({ upiRef: "432100000003", merchant: "Uber", amountMinor: 18000, occurredAt: iso(day(4)) })];
    const preview = await importStatement(ctx, hid, owner, input(rows, true));
    expect(statuses(preview)).toEqual(["new", "new"]);
    expect((await listCaptures(ctx, hid, owner)).length).toBe(0);
    expect((await importStatement(ctx, hid, owner, input(rows))).summary.imported).toBe(2);
    const again = await importStatement(ctx, hid, owner, input(rows));
    expect(statuses(again)).toEqual(["already_captured", "already_captured"]);
    expect((await listCaptures(ctx, hid, owner)).length).toBe(2);
  });

  it("keeps a payment listed twice in one file once", async () => {
    const r = await importStatement(ctx, hid, owner, input([row({}), row({})]));
    expect(statuses(r)).toEqual(["new", "duplicate_in_file"]);
    expect((await listCaptures(ctx, hid, owner)).length).toBe(1);
  });

  it("does not bring back a payment the person already dismissed", async () => {
    await importStatement(ctx, hid, owner, input([row({})]));
    const [c] = await listCaptures(ctx, hid, owner);
    await dismissCapture(ctx, hid, owner, c.id as string);
    const r = await importStatement(ctx, hid, owner, input([row({})]));
    expect(r.results[0]).toMatchObject({ status: "already_captured", existingStatus: "dismissed" });
  });

  it("flags — but still offers — a payment that matches one entered by hand", async () => {
    await recordExpense(ctx, hid, owner, { amountMinor: 45000, currency: "INR", category: "Dining", occurredAt: iso(day(2)), method: "upi", description: "Swiggy", idempotencyKey: "manual-swiggy-1" } as never);
    // Statement row has no reference (e.g. a bank statement line) and the same amount at the same time.
    const r = await importStatement(ctx, hid, owner, input([row({ upiRef: null })]));
    expect(statuses(r)).toEqual(["possible_duplicate"]);
    expect(r.summary).toMatchObject({ possibleDuplicate: 1, imported: 1 });
    const [c] = await listCaptures(ctx, hid, owner);
    expect(c.possibleDuplicateOf).toBeTruthy();
  });

  it("treats a date-only row as the same day, not the same minute", async () => {
    await recordExpense(ctx, hid, owner, { amountMinor: 45000, currency: "INR", category: "Dining", occurredAt: iso(day(2)), method: "upi", description: "Swiggy", idempotencyKey: "manual-swiggy-2" } as never);
    const sameDay = await importStatement(ctx, hid, owner, input([row({ upiRef: null, timeKnown: false, occurredAt: iso(new Date(day(2).getTime() + 3 * 3_600_000)) })], true));
    expect(statuses(sameDay)).toEqual(["possible_duplicate"]);
    const otherDay = await importStatement(ctx, hid, owner, input([row({ upiRef: null, timeKnown: false, occurredAt: iso(day(4)) })], true));
    expect(statuses(otherDay)).toEqual(["new"]);
  });

  it("rejects absurd dates, never stores the reference, and enforces permissions and isolation", async () => {
    const r = await importStatement(ctx, hid, owner, input([row({ occurredAt: iso(new Date(ctx.now().getTime() + 30 * 86_400_000)) }), row({ upiRef: "432100000009" })]));
    expect(statuses(r)).toEqual(["invalid", "new"]);
    const [c] = await listCaptures(ctx, hid, owner);
    expect(JSON.stringify((await ctx.db.doc(`households/${hid}/spendCaptures/${c.id}`).get()).data())).not.toContain("432100000009");
    await expect(importStatement(ctx, hid, child, input([row({})]))).rejects.toThrow();
    await expect(importStatement(ctx, hid2, owner, input([row({})]))).rejects.toThrow();
    expect((await listCaptures(ctx, hid2, { uid: "si_other", kind: "user" })).length).toBe(0);
  });

  it("validates its input", () => {
    expect(() => input([])).toThrow();
    expect(() => input([row({ upiRef: "12345" })])).toThrow();
    expect(() => input([row({ amountMinor: 0 })])).toThrow();
    expect(() => input(Array.from({ length: 151 }, () => row({})))).toThrow();
  });
});
