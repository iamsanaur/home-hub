import { beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, testCtx } from "./helpers";
import { Actor } from "../../src/services/base";
import { acceptInvitation, createHousehold, invite } from "../../src/services/households";
import { captureSpend, confirmCapture, dismissCapture, listCaptures } from "../../src/finance/spendCapture";

const ctx = testCtx();
const owner: Actor = { uid: "sc_owner", kind: "user" };
const child: Actor = { uid: "sc_child", kind: "user" };
const staff: Actor = { uid: "sc_staff", kind: "user" };
let hid: string;
let hid2: string;

async function join(h: string, as: Actor, role: "child" | "staff") {
  const email = `${as.uid}@example.com`;
  const inv = await invite(ctx, owner, h, { role, email });
  await acceptInvitation(ctx, { uid: as.uid, email, emailVerified: true, displayName: as.uid }, inv.token);
}

beforeEach(async () => {
  await clearFirestore();
  const mk = (name: string, uid = owner.uid) => createHousehold(ctx, { uid, displayName: "O", email: `${uid}@example.com` }, { name, currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN" });
  hid = (await mk("Sharma Home")).householdId;
  hid2 = (await mk("Other Home", "sc_other")).householdId;
  await join(hid, child, "child");
  await join(hid, staff, "staff");
});

const SWIGGY = "Rs.450.00 debited from A/c XX1234 on 16-11-26 to VPA swiggy@icici (UPI Ref No 432112345678).";

describe("automatic spending capture", () => {
  it("captures once, books on confirm, learns the category, and never stores the raw text", async () => {
    const first = await captureSpend(ctx, hid, owner, { source: "android_notification", text: SWIGGY });
    expect(first.status).toBe("captured");
    // Same payment again (e.g. SMS + app notification) → one capture.
    expect((await captureSpend(ctx, hid, owner, { source: "ios_shortcut", text: SWIGGY })).status).toBe("duplicate");
    expect((await captureSpend(ctx, hid, owner, { source: "android_notification", text: "Your OTP for txn of Rs 500 is 123456" })).status).toBe("ignored");

    const [c] = await listCaptures(ctx, hid, owner);
    expect(c).toMatchObject({ amountMinor: 45000, merchant: "Swiggy", suggestedCategory: "Dining", refLast4: "5678", accountLast4: "1234", status: "pending" });
    const stored = (await ctx.db.doc(`households/${hid}/spendCaptures/${c.id}`).get()).data()!;
    expect(JSON.stringify(stored)).not.toContain("432112345678");
    expect(JSON.stringify(stored)).not.toContain("debited from");

    // Nothing is booked before confirmation.
    expect((await ctx.db.collection(`households/${hid}/transactions`).get()).size).toBe(0);
    const r = await confirmCapture(ctx, hid, owner, c.id, { category: "Groceries" });
    expect(r.status).toBe("confirmed");
    const tx = (await ctx.db.doc(`households/${hid}/transactions/${r.transactionId}`).get()).data()!;
    expect(tx).toMatchObject({ type: "expense", amountMinor: 45000, category: "Groceries", paymentMethod: "upi" });
    // Confirming twice is idempotent.
    expect((await confirmCapture(ctx, hid, owner, c.id, {})).transactionId).toBe(r.transactionId);
    expect((await ctx.db.collection(`households/${hid}/transactions`).get()).size).toBe(1);

    // The household's correction is remembered for the next Swiggy payment.
    const next = await captureSpend(ctx, hid, owner, { source: "android_notification", text: "₹199 paid to Swiggy" });
    expect(next.status === "captured" && next.capture.suggestedCategory).toBe("Groceries");
  });

  it("flags a payment already entered by hand, and dismisses without booking", async () => {
    await ctx.db.collection(`households/${hid}/transactions`).add({ type: "expense", amountMinor: 29900, currency: "INR", category: "Dining", paymentMethod: "upi", occurredAt: new Date(ctx.now().getTime() - 5 * 60_000) });
    const c = await captureSpend(ctx, hid, owner, { source: "android_notification", text: "Paid ₹299 to Zomato" });
    expect(c.status === "captured" && c.capture.possibleDuplicateOf).toBeTruthy();
    await dismissCapture(ctx, hid, owner, (c as { id: string }).id);
    expect(await listCaptures(ctx, hid, owner)).toHaveLength(0);
    expect((await listCaptures(ctx, hid, owner, "dismissed"))[0].expiresAt).toBeTruthy();
    await expect(confirmCapture(ctx, hid, owner, (c as { id: string }).id, {})).rejects.toThrow(/dismissed/);
  });

  it("only finance-permitted adults can capture or read, and households stay isolated", async () => {
    await expect(captureSpend(ctx, hid, child, { source: "ios_shortcut", text: SWIGGY })).rejects.toThrow();
    await expect(captureSpend(ctx, hid, staff, { source: "ios_shortcut", text: SWIGGY })).rejects.toThrow();
    await expect(listCaptures(ctx, hid, child)).rejects.toThrow();
    await captureSpend(ctx, hid, owner, { source: "android_notification", text: SWIGGY });
    await expect(listCaptures(ctx, hid2, owner)).rejects.toThrow(); // not a member of hid2
    expect(await listCaptures(ctx, hid2, { uid: "sc_other", kind: "user" })).toHaveLength(0);
  });
});
