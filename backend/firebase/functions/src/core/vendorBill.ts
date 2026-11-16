/**
 * Vendor bills that depend on what was actually delivered: milk per liter, newspapers per copy, a maid or cook
 * per day worked, water cans, tiffin meals. The month's amount is `quantity delivered × rate`, so a day the
 * vendor doesn't come is simply not charged.
 *
 * Money is integer minor units (paise). Quantities are kept in thousandths so 0.5 l or 1.25 kg are exact and
 * the total is `round(totalMilli × rateMinor / 1000)` — never floating-point money arithmetic.
 */
import { DateTime } from "luxon";

export interface MeterTerms {
  unit: string;            // "l", "kg", "copies", "days", "cans"…
  rateMinor: number;       // price of ONE unit, in minor units (₹60/l → 6000)
  defaultQuantity: number; // normal quantity on a scheduled day
  weekdays: number[];      // ISO weekdays that are normally delivered: 1 = Monday … 7 = Sunday
}

export interface LedgerDay { date: string; weekday: number; scheduled: boolean; quantity: number; status: "delivered" | "skipped" | "extra" | "planned" | "none" }

export interface LedgerTotals {
  deliveredDays: number; skippedDays: number; plannedDays: number;
  deliveredQuantity: number;   // so far (through today)
  quantity: number;            // whole month: delivered so far + planned
  soFarMinor: number;          // charge for what has been delivered through today
  totalMinor: number;          // charge for the whole month if the rest goes as planned
}

export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
export const toMilli = (q: number) => Math.round(q * 1000);
export const fromMilli = (m: number) => m / 1000;
export const chargeMinor = (milli: number, rateMinor: number) => Math.round((milli * rateMinor) / 1000);

export function validMonth(m: string): boolean { return /^\d{4}-(0[1-9]|1[0-2])$/.test(m); }
export function addMonths(month: string, n: number): string { return DateTime.fromISO(`${month}-01`, { zone: "utc" }).plus({ months: n }).toFormat("yyyy-MM"); }
export function monthOf(date: string): string { return date.slice(0, 7); }

export function daysInMonth(month: string): string[] {
  const first = DateTime.fromISO(`${month}-01`, { zone: "utc" });
  return Array.from({ length: first.daysInMonth! }, (_, i) => first.plus({ days: i }).toISODate()!);
}

/** The bill for deliveries in `cycleMonth` falls due on `dueDay` of the following month (09:00 household time). */
export function dueDateFor(cycleMonth: string, dueDay: number, timezone: string): Date {
  const next = DateTime.fromISO(`${addMonths(cycleMonth, 1)}-01`, { zone: timezone });
  return next.set({ day: Math.min(dueDay, next.daysInMonth!), hour: 9, minute: 0 }).toJSDate();
}

export function validateTerms(t: MeterTerms & { dueDay?: number }): string | null {
  if (!t.unit.trim() || t.unit.length > 20) return "Unit must be 1–20 characters";
  if (!Number.isSafeInteger(t.rateMinor) || t.rateMinor < 1 || t.rateMinor > 100_000_000) return "Rate must be a positive whole number of minor units";
  if (!(t.defaultQuantity >= 0) || t.defaultQuantity > 1000) return "Daily quantity must be between 0 and 1000";
  if (!Array.isArray(t.weekdays) || t.weekdays.length === 0 || t.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return "Pick at least one delivery day";
  if (t.dueDay !== undefined && (!Number.isInteger(t.dueDay) || t.dueDay < 1 || t.dueDay > 28)) return "Due day must be 1–28";
  return null;
}

/**
 * Builds one month. `exceptions` maps a date to the quantity that actually applies that day (0 = not delivered).
 * Days without an exception follow the schedule. `today` (YYYY-MM-DD) splits "delivered so far" from "planned".
 */
export function buildLedger(month: string, terms: MeterTerms, exceptions: Record<string, number>, today: string): { days: LedgerDay[]; totals: LedgerTotals } {
  const days: LedgerDay[] = [];
  let deliveredMilli = 0, plannedMilli = 0, deliveredDays = 0, skippedDays = 0, plannedDays = 0;
  for (const date of daysInMonth(month)) {
    const weekday = DateTime.fromISO(date, { zone: "utc" }).weekday;
    const scheduled = terms.weekdays.includes(weekday);
    const hasException = Object.prototype.hasOwnProperty.call(exceptions, date);
    const qty = hasException ? exceptions[date] : scheduled ? terms.defaultQuantity : 0;
    const past = date <= today;
    let status: LedgerDay["status"];
    if (qty === 0) status = scheduled && hasException ? "skipped" : "none";
    else if (!scheduled && hasException) status = "extra";
    else status = past ? "delivered" : "planned";
    if (status === "skipped") skippedDays++;
    if (qty > 0) { if (past) { deliveredMilli += toMilli(qty); deliveredDays++; } else { plannedMilli += toMilli(qty); plannedDays++; } }
    days.push({ date, weekday, scheduled, quantity: qty, status: status === "extra" && !past ? "planned" : status });
  }
  return {
    days,
    totals: {
      deliveredDays, skippedDays, plannedDays,
      deliveredQuantity: fromMilli(deliveredMilli), quantity: fromMilli(deliveredMilli + plannedMilli),
      soFarMinor: chargeMinor(deliveredMilli, terms.rateMinor), totalMinor: chargeMinor(deliveredMilli + plannedMilli, terms.rateMinor),
    },
  };
}

/** Keeps the stored exceptions minimal: an entry equal to what the schedule already implies is dropped. */
export function normalizeException(terms: MeterTerms, date: string, quantity: number | null): number | null {
  if (quantity === null) return null;
  const weekday = DateTime.fromISO(date, { zone: "utc" }).weekday;
  const normal = terms.weekdays.includes(weekday) ? terms.defaultQuantity : 0;
  return toMilli(quantity) === toMilli(normal) ? null : fromMilli(toMilli(quantity));
}
