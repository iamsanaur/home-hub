import { beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, testCtx } from "./helpers";
import { Actor, audit } from "../../src/services/base";
import { acceptInvitation, createHousehold, invite } from "../../src/services/households";
import { clearActivity, deleteActivityEntry } from "../../src/services/activityFeed";

const ctx = testCtx();
const owner: Actor = { uid: "af_owner", kind: "user" };
const admin: Actor = { uid: "af_admin", kind: "user" };
const adult: Actor = { uid: "af_adult", kind: "user" };
let hid: string, hid2: string;

async function join(h: string, as: Actor, role: "admin" | "adult") {
  const email = `${as.uid}@example.com`;
  const inv = await invite(ctx, owner, h, { role, email });
  await acceptInvitation(ctx, { uid: as.uid, email, emailVerified: true, displayName: as.uid }, inv.token);
}
const feed = async (h = hid) => (await ctx.db.collection(`households/${h}/activityLogs`).get()).docs;

beforeEach(async () => {
  await clearFirestore();
  const mk = (name: string, uid = owner.uid) => createHousehold(ctx, { uid, displayName: "O", email: `${uid}@example.com` }, { name, currency: "INR", timezone: "Asia/Kolkata", locale: "en" });
  hid = (await mk("Home")).householdId; hid2 = (await mk("Other", "af_other")).householdId;
  await join(hid, admin, "admin"); await join(hid, adult, "adult");
  for (let i = 0; i < 5; i++) await audit(ctx, hid, owner, "agent.run_started", { type: "agentWorkflow", id: `w${i}` });
  await audit(ctx, hid2, { uid: "af_other", kind: "user" }, "agent.run_started", { type: "agentWorkflow", id: "x" });
});

describe("deleting recent-activity entries", () => {
  it("owners and administrators can delete one entry, and the deletion is recorded in the audit trail", async () => {
    const before = await feed();
    const target = before.find((d) => d.data().action === "agent.run_started")!;
    expect(await deleteActivityEntry(ctx, hid, admin, target.id)).toEqual({ removed: 1 });
    expect((await feed()).length).toBe(before.length - 1);
    const trail = (await ctx.db.collection(`households/${hid}/auditEvents`).get()).docs.map((d) => d.data());
    expect(trail.some((e) => e.requestedAction === "activity.entry_deleted" && e.actorUid === admin.uid)).toBe(true);
    await expect(deleteActivityEntry(ctx, hid, owner, target.id)).rejects.toThrow(/not found/i);
  });

  it("adults and other households can't delete anything", async () => {
    const [first] = await feed();
    await expect(deleteActivityEntry(ctx, hid, adult, first.id)).rejects.toThrow(/owners and administrators/);
    await expect(clearActivity(ctx, hid, adult)).rejects.toThrow(/owners and administrators/);
    await expect(deleteActivityEntry(ctx, hid2, owner, first.id)).rejects.toThrow(); // owner isn't a member of hid2
    expect((await feed(hid2)).length).toBeGreaterThan(0);
  });

  it("clearing removes the feed, keeps entries of runs still in progress, and never touches the audit trail", async () => {
    await ctx.db.doc(`households/${hid}/agentWorkflows/w-live`).set({ status: "executing", requestedBy: owner.uid });
    await audit(ctx, hid, { ...owner, workflowId: "w-live" }, "task.created", { type: "task", id: "t1" });
    const otherBefore = (await feed(hid2)).length;
    const r = await clearActivity(ctx, hid, owner);
    expect(r.removed).toBeGreaterThanOrEqual(5);
    const left = await feed();
    expect(left.every((d) => d.data().workflowId === "w-live")).toBe(true);
    expect(left.length).toBe(1);
    const trail = (await ctx.db.collection(`households/${hid}/auditEvents`).get()).docs.map((d) => d.data().requestedAction);
    expect(trail).toContain("activity.feed_cleared");
    expect((await feed(hid2)).length).toBe(otherBefore); // another household is untouched
  });
});
