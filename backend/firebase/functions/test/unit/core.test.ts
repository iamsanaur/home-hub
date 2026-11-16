import { describe, expect, it } from "vitest";
import { add, allocate, format, money, MoneyError, multiplyQuantity, multiplyRational, parseDecimal, ratioBasisPoints, sum } from "../../src/core/money";
import { describe as describeRule, nextOccurrence, occurrences, RecurrenceError } from "../../src/core/recurrence";
import { can, canChangeRole, Membership } from "../../src/core/roles";
import { decide } from "../../src/core/autonomy";
import { route } from "../../src/agent/router";
import { computeNextRun } from "../../src/services/jobs";
import { inQuietHours } from "../../src/services/notifications";
import { toBase } from "../../src/services/food";

describe("money (integer minor units)", () => {
  it("adds without floating point error", () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; in minor units it is exact.
    expect(add(money(10, "INR"), money(20, "INR")).amountMinor).toBe(30);
    expect(sum([money(1999, "USD"), money(1, "USD")], "USD").amountMinor).toBe(2000);
  });
  it("rejects non-integer amounts and mixed currencies", () => {
    expect(() => money(10.5, "INR")).toThrow(MoneyError);
    expect(() => add(money(1, "INR"), money(1, "USD"))).toThrow(/Currency mismatch/);
    expect(() => money(1, "inr")).toThrow(/Invalid currency/);
  });
  it("parses decimal strings exactly, respecting currency exponent", () => {
    expect(parseDecimal("1,234.50", "INR").amountMinor).toBe(123450);
    expect(parseDecimal("0.1", "USD").amountMinor).toBe(10);
    expect(parseDecimal("1500", "JPY").amountMinor).toBe(1500);
    expect(parseDecimal("1.234", "KWD").amountMinor).toBe(1234);
    expect(() => parseDecimal("1.234", "INR")).toThrow(/decimal places/);
    expect(() => parseDecimal("abc", "INR")).toThrow();
  });
  it("multiplies with banker's rounding", () => {
    expect(multiplyRational(money(5, "INR"), 1, 2).amountMinor).toBe(2); // 2.5 → 2 (even)
    expect(multiplyRational(money(15, "INR"), 1, 2).amountMinor).toBe(8); // 7.5 → 8 (even)
    expect(multiplyQuantity(money(4999, "INR"), 1.5).amountMinor).toBe(7498); // 7498.5 → 7498
    expect(multiplyQuantity(money(333, "INR"), 3).amountMinor).toBe(999);
  });
  it("allocates without losing a paisa", () => {
    const parts = allocate(money(1000, "INR"), [1, 1, 1]);
    expect(parts.map((p) => p.amountMinor)).toEqual([334, 333, 333]);
    expect(parts.reduce((a, p) => a + p.amountMinor, 0)).toBe(1000);
  });
  it("formats for display", () => {
    expect(format(money(123450, "INR"), "en-IN")).toBe("₹1,234.50");
    expect(format(money(-500, "USD"), "en-US")).toBe("-$5.00");
    expect(format(money(1500, "JPY"), "en-US")).toBe("¥1,500");
  });
  it("computes utilisation in basis points", () => {
    expect(ratioBasisPoints(8500, 10000)).toBe(8500);
    expect(ratioBasisPoints(1, 3)).toBe(3333);
    expect(ratioBasisPoints(5, 0)).toBe(0);
  });
});

describe("recurrence", () => {
  it("keeps local wall-clock time across DST", () => {
    const occ = occurrences({ freq: "weekly" }, "2026-03-02T09:00:00", "Europe/London", { limit: 5 });
    // 09:00 GMT → 08:00Z before DST; 09:00 BST → 08:00Z after 29 March.
    expect(occ[0]).toBe("2026-03-02T09:00:00.000Z");
    expect(occ[4]).toBe("2026-03-30T08:00:00.000Z");
  });
  it("clamps monthly day 31 to the month's last day", () => {
    const occ = occurrences({ freq: "monthly", byMonthDay: 31 }, "2026-01-31T10:00:00", "Asia/Kolkata", { limit: 3 });
    expect(occ.map((o) => o.slice(0, 10))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });
  it("supports weekly by weekday, interval, count and until", () => {
    const occ = occurrences({ freq: "weekly", byWeekday: [1, 3], count: 4 }, "2026-11-16T07:00:00", "UTC", { limit: 10 });
    expect(occ.map((o) => o.slice(0, 10))).toEqual(["2026-11-16", "2026-11-18", "2026-11-23", "2026-11-25"]);
    expect(occurrences({ freq: "daily", interval: 2, until: "2026-11-21T00:00:00" }, "2026-11-16T07:00:00", "UTC").length).toBe(3);
  });
  it("finds the next occurrence after a date and ends series", () => {
    expect(nextOccurrence({ freq: "daily" }, "2026-11-16T07:00:00Z", "UTC", "2026-11-16T07:00:00Z")).toBe("2026-11-17T07:00:00.000Z");
    expect(nextOccurrence({ freq: "daily", count: 1 }, "2026-11-16T07:00:00Z", "UTC", "2026-11-16T07:00:00Z")).toBeNull();
  });
  it("validates rules and describes them", () => {
    expect(() => occurrences({ freq: "daily", byWeekday: [1] }, "2026-01-01T00:00:00", "UTC")).toThrow(RecurrenceError);
    expect(describeRule({ freq: "weekly", interval: 2, byWeekday: [1, 5] })).toBe("Every 2 weeks on Mon, Fri");
  });
});

describe("roles & permissions", () => {
  const m = (role: Membership["role"], extra: Partial<Membership> = {}): Membership => ({ uid: role, role, status: "active", ...extra });
  it("restricts staff and children", () => {
    expect(can(m("staff"), "finance.read")).toBe(false);
    expect(can(m("staff"), "pantry.write")).toBe(true);
    expect(can(m("child"), "documents.read")).toBe(false);
    expect(can(m("adult"), "finance.read")).toBe(true);
    expect(can(m("adult", { permissions: { finance: false } }), "finance.read")).toBe(false);
    expect(can(m("adult", { status: "removed" }), "tasks.write")).toBe(false);
  });
  it("prevents privilege escalation", () => {
    expect(canChangeRole(m("admin"), m("adult"), "admin")).toBe(false); // admin can't mint admins
    expect(canChangeRole(m("admin"), m("adult"), "child")).toBe(true);
    expect(canChangeRole(m("admin"), m("owner"), "adult")).toBe(false);
    expect(canChangeRole(m("adult"), m("child"), "adult")).toBe(false);
    expect(canChangeRole(m("owner"), m("admin"), "owner")).toBe(true); // transfer
    expect(canChangeRole(m("owner"), { ...m("owner") }, "admin")).toBe(false); // self
  });
});

describe("autonomy policy", () => {
  it("allows routine reversible writes but gates sensitive actions in every mode", () => {
    expect(decide({ mode: "routine", paused: false }, "reversible_write").outcome).toBe("allow");
    expect(decide({ mode: "routine", paused: false }, "bounded_write").outcome).toBe("approval_required");
    expect(decide({ mode: "advanced", paused: false }, "sensitive", "payment").outcome).toBe("approval_required");
    expect(decide({ mode: "advanced", paused: false }, "reversible_write", "purchase").outcome).toBe("approval_required");
    expect(decide({ mode: "assistant", paused: false }, "reversible_write").outcome).toBe("approval_required");
  });
  it("emergency pause denies every write but still allows reads", () => {
    expect(decide({ mode: "advanced", paused: true }, "reversible_write").outcome).toBe("deny");
    expect(decide({ mode: "advanced", paused: true }, "read").outcome).toBe("allow");
  });
});

describe("router (no LLM)", () => {
  it("answers briefing requests deterministically", () => {
    expect(route("What's due today?")).toEqual({ kind: "deterministic", handler: "briefing" });
  });
  it("routes workflows and skills", () => {
    expect(route("Prepare everything for next week.")).toMatchObject({ skill: "household-manager", workflow: "weekly_preparation", tier: "complex" });
    expect(route("Prepare the house for guests on Saturday")).toMatchObject({ workflow: "guest_preparation" });
    expect(route("Plan dinners for this week")).toMatchObject({ skill: "meal-planner" });
    expect(route("The AC is leaking")).toMatchObject({ skill: "home-maintenance", workflow: "maintenance_coordination" });
    expect(route("Are we over budget on groceries?")).toMatchObject({ skill: "finance-manager", workflow: "budget_protection" });
    expect(route("add milk")).toMatchObject({ skill: "household-manager", tier: "simple" });
  });
  it("sends vendor and delivery talk to the finance skill, and keeps everyday shopping and cooking where they were", () => {
    for (const m of [
      "Add a milk vendor bill, 1 liter a day at 60 rupees a liter",
      "The milk vendor didn't come yesterday", "milk didn't come on the 3rd and 4th", "newspaper was not delivered today",
      "maid is on leave from 10th to 15th", "tiffin skipped on Friday", "Ramesh the milkman raised his price to 65 per liter",
      "we got 2 liters extra milk today", "water can delivery didn't come",
    ]) expect(route(m), m).toMatchObject({ skill: "finance-manager" });
    expect(route("add more milk to the list")).toMatchObject({ skill: "smart-shopping" });
    expect(route("Plan dinners for this week")).toMatchObject({ skill: "meal-planner" });
    expect(route("What's running low in the pantry?")).toMatchObject({ skill: "smart-shopping" });
    expect(route("Add 2 kg rice and 1 l oil to the pantry")).toMatchObject({ skill: "smart-shopping" });
  });
});

describe("scheduling helpers", () => {
  it("computes next run in the household timezone", () => {
    const next = computeNextRun({ kind: "daily", time: "07:30" }, "Asia/Kolkata", new Date("2026-11-16T03:00:00Z"));
    expect(next.toISOString()).toBe("2026-11-17T02:00:00.000Z"); // 07:30 IST next day (today's 07:30 IST = 02:00Z already passed)
    const weekly = computeNextRun({ kind: "weekly", time: "10:00", weekday: 7 }, "UTC", new Date("2026-11-16T00:00:00Z"));
    expect(weekly.toISOString()).toBe("2026-11-22T10:00:00.000Z");
  });
  it("evaluates quiet hours across midnight", () => {
    const prefs = { quietHours: { start: "22:00", end: "07:00" }, timezone: "Asia/Kolkata" };
    expect(inQuietHours(prefs, new Date("2026-11-16T18:00:00Z"), "UTC")).toBe(true); // 23:30 IST
    expect(inQuietHours(prefs, new Date("2026-11-16T06:00:00Z"), "UTC")).toBe(false); // 11:30 IST
  });
  it("normalises units for meal aggregation", () => {
    expect(toBase(1.5, "kg")).toEqual({ quantity: 1500, unit: "g" });
    expect(toBase(2, "tbsp")).toEqual({ quantity: 30, unit: "ml" });
    expect(toBase(3, "bunch")).toEqual({ quantity: 3, unit: "bunch" });
  });
});

import { secretEnv } from "../../src/core/env";
describe("secretEnv", () => {
  it("treats empty and the deploy placeholder as not configured", () => {
    process.env.HH_TEST_SECRET = "unset"; expect(secretEnv("HH_TEST_SECRET")).toBeUndefined();
    process.env.HH_TEST_SECRET = "  "; expect(secretEnv("HH_TEST_SECRET")).toBeUndefined();
    process.env.HH_TEST_SECRET = "sk-real"; expect(secretEnv("HH_TEST_SECRET")).toBe("sk-real");
    delete process.env.HH_TEST_SECRET; expect(secretEnv("HH_TEST_SECRET")).toBeUndefined();
  });
});
