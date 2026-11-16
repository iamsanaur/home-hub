import { describe, expect, it } from "vitest";
import { addMonths, buildLedger, chargeMinor, daysInMonth, dueDateFor, normalizeException, toMilli, validateTerms } from "../../src/core/vendorBill";

const milk = { unit: "l", rateMinor: 6000, defaultQuantity: 1, weekdays: [1, 2, 3, 4, 5, 6, 7] };

describe("vendor bills (pay per delivery)", () => {
  it("charges a full month when nothing is skipped (30 days × 1 l × ₹60)", () => {
    const { totals } = buildLedger("2026-11", milk, {}, "2026-12-01");
    expect(totals).toMatchObject({ deliveredDays: 30, skippedDays: 0, deliveredQuantity: 30, soFarMinor: 180000, totalMinor: 180000 });
  });

  it("doesn't charge days the vendor didn't come", () => {
    const { totals, days } = buildLedger("2026-11", milk, { "2026-11-05": 0, "2026-11-06": 0, "2026-11-12": 0 }, "2026-12-01");
    expect(totals).toMatchObject({ deliveredDays: 27, skippedDays: 3, totalMinor: 27 * 6000 });
    expect(days.find((d) => d.date === "2026-11-05")).toMatchObject({ status: "skipped", quantity: 0 });
  });

  it("handles extra quantity and fractional liters exactly, with integer money", () => {
    const { totals } = buildLedger("2026-11", milk, { "2026-11-02": 2.5, "2026-11-03": 0.5 }, "2026-12-01");
    expect(totals.quantity).toBe(30 - 2 + 2.5 + 0.5);
    expect(totals.totalMinor).toBe(chargeMinor(toMilli(31), 6000)); // 31 l → ₹1,860.00
    expect(Number.isInteger(totals.totalMinor)).toBe(true);
    expect(chargeMinor(toMilli(0.333), 5250)).toBe(Math.round(333 * 5250 / 1000));
  });

  it("splits what's been delivered so far from what's planned, using today's date", () => {
    const { totals } = buildLedger("2026-11", milk, { "2026-11-02": 0 }, "2026-11-10");
    expect(totals.deliveredDays).toBe(9);          // 1st..10th minus the skipped 2nd
    expect(totals.soFarMinor).toBe(9 * 6000);
    expect(totals.plannedDays).toBe(20);
    expect(totals.totalMinor).toBe(29 * 6000);
  });

  it("follows the weekday schedule, with extras on non-delivery days (a maid who works Mon–Sat)", () => {
    const maid = { unit: "days", rateMinor: 40000, defaultQuantity: 1, weekdays: [1, 2, 3, 4, 5, 6] };
    expect(buildLedger("2026-11", maid, {}, "2026-12-01").totals.deliveredDays).toBe(25);   // 30 days minus 5 Sundays
    const extra = buildLedger("2026-11", maid, { "2026-11-01": 1 }, "2026-12-01");           // a Sunday
    expect(extra.days[0].status).toBe("extra");
    expect(extra.totals.deliveredDays).toBe(26);
  });

  it("keeps stored exceptions minimal", () => {
    expect(normalizeException(milk, "2026-11-05", 1)).toBeNull();     // same as the schedule → no exception
    expect(normalizeException(milk, "2026-11-05", 0)).toBe(0);        // skipped
    expect(normalizeException(milk, "2026-11-05", null)).toBeNull();  // cleared
    expect(normalizeException({ ...milk, weekdays: [1] }, "2026-11-04", 0)).toBeNull(); // already not scheduled
  });

  it("dates: month arithmetic, due date in the following month, short months", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(daysInMonth("2028-02")).toHaveLength(29);
    expect(dueDateFor("2026-11", 5, "Asia/Kolkata").toISOString()).toBe("2026-12-05T03:30:00.000Z");
    expect(dueDateFor("2026-01", 28, "Asia/Kolkata").getUTCDate()).toBe(28);
  });

  it("validates terms", () => {
    expect(validateTerms({ ...milk, dueDay: 5 })).toBeNull();
    expect(validateTerms({ ...milk, rateMinor: 0 })).toMatch(/Rate/);
    expect(validateTerms({ ...milk, rateMinor: 60.5 })).toMatch(/Rate/);
    expect(validateTerms({ ...milk, weekdays: [] })).toMatch(/delivery day/);
    expect(validateTerms({ ...milk, weekdays: [8] })).toMatch(/delivery day/);
    expect(validateTerms({ ...milk, dueDay: 31 })).toMatch(/Due day/);
  });
});
