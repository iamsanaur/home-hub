import { DateTime } from "luxon";

/**
 * A small, deterministic recurrence model (subset of RFC 5545 RRULE) shared by
 * tasks, cleaning schedules, bills, events and maintenance reminders. All
 * calculations happen in the household's IANA timezone so "every Monday 9:00"
 * stays at 9:00 local time across DST changes.
 */
export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

export interface RecurrenceRule {
  freq: Frequency;
  interval?: number; // default 1
  byWeekday?: number[]; // 1 = Monday … 7 = Sunday (ISO), weekly only
  byMonthDay?: number; // 1–31, or -1 for last day; monthly only
  count?: number; // total occurrences including the first
  until?: string; // ISO date/time (inclusive)
}

export class RecurrenceError extends Error {}

export function validateRule(rule: RecurrenceRule): void {
  const interval = rule.interval ?? 1;
  if (!["daily", "weekly", "monthly", "yearly"].includes(rule.freq)) {
    throw new RecurrenceError(`Unsupported frequency ${rule.freq}`);
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
    throw new RecurrenceError("interval must be an integer 1–366");
  }
  if (rule.byWeekday && (rule.freq !== "weekly" || rule.byWeekday.some((d) => d < 1 || d > 7))) {
    throw new RecurrenceError("byWeekday is only valid for weekly rules with values 1–7");
  }
  if (rule.byMonthDay !== undefined) {
    if (rule.freq !== "monthly") throw new RecurrenceError("byMonthDay is only valid for monthly rules");
    if (rule.byMonthDay !== -1 && (rule.byMonthDay < 1 || rule.byMonthDay > 31)) {
      throw new RecurrenceError("byMonthDay must be 1–31 or -1");
    }
  }
  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1)) {
    throw new RecurrenceError("count must be a positive integer");
  }
}

function monthlyDate(base: DateTime, monthOffset: number, day: number): DateTime {
  const target = base.plus({ months: monthOffset }).startOf("month");
  const dim = target.daysInMonth ?? 28;
  const d = day === -1 ? dim : Math.min(day, dim); // clamp the 31st to the month's last day
  return target.set({ day: d, hour: base.hour, minute: base.minute, second: 0, millisecond: 0 });
}

/**
 * Generate occurrences starting at `start` (the first occurrence) that fall
 * strictly after `after`, up to `limit` results.
 */
export function occurrences(
  rule: RecurrenceRule,
  startIso: string,
  timezone: string,
  options: { after?: string; limit?: number } = {},
): string[] {
  validateRule(rule);
  const start = DateTime.fromISO(startIso, { zone: timezone });
  if (!start.isValid) throw new RecurrenceError(`Invalid start ${startIso}`);
  const after = options.after ? DateTime.fromISO(options.after, { zone: timezone }) : undefined;
  const until = rule.until ? DateTime.fromISO(rule.until, { zone: timezone }) : undefined;
  const limit = Math.min(options.limit ?? 10, 500);
  const interval = rule.interval ?? 1;
  const out: string[] = [];
  let emitted = 0;

  const consider = (dt: DateTime): boolean => {
    if (dt < start) return true;
    if (until && dt > until) return false;
    if (rule.count !== undefined && emitted >= rule.count) return false;
    emitted += 1;
    if (!after || dt > after) out.push(dt.toUTC().toISO()!);
    return out.length < limit;
  };

  // Safety bound: never iterate more than 5000 periods.
  for (let i = 0; i < 5000; i++) {
    let candidates: DateTime[];
    switch (rule.freq) {
      case "daily":
        candidates = [start.plus({ days: i * interval })];
        break;
      case "weekly": {
        const weekStart = start.startOf("week").plus({ weeks: i * interval });
        const days = rule.byWeekday?.length ? [...rule.byWeekday].sort() : [start.weekday];
        candidates = days.map((wd) =>
          weekStart.plus({ days: wd - 1 }).set({ hour: start.hour, minute: start.minute, second: 0, millisecond: 0 }),
        );
        break;
      }
      case "monthly":
        candidates = [monthlyDate(start, i * interval, rule.byMonthDay ?? start.day)];
        break;
      case "yearly": {
        const target = start.plus({ years: i * interval });
        candidates = [target];
        break;
      }
    }
    for (const c of candidates) {
      if (!consider(c)) return out;
    }
  }
  return out;
}

/** Next occurrence strictly after `afterIso`, or null when the series has ended. */
export function nextOccurrence(
  rule: RecurrenceRule,
  startIso: string,
  timezone: string,
  afterIso: string,
): string | null {
  return occurrences(rule, startIso, timezone, { after: afterIso, limit: 1 })[0] ?? null;
}

/** Human-readable description used in UI copy and agent context. */
export function describe(rule: RecurrenceRule): string {
  const n = rule.interval ?? 1;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq];
  let text = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (rule.byWeekday?.length) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    text += ` on ${rule.byWeekday.map((d) => names[d - 1]).join(", ")}`;
  }
  if (rule.byMonthDay !== undefined) {
    text += rule.byMonthDay === -1 ? " on the last day" : ` on day ${rule.byMonthDay}`;
  }
  if (rule.count) text += `, ${rule.count} times`;
  if (rule.until) text += `, until ${rule.until.slice(0, 10)}`;
  return text;
}
