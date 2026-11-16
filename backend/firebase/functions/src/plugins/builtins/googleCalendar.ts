import { DateTime } from "luxon";
import { definePlugin } from "../sdk";

/**
 * Google Calendar, read-only, through the calendar's private iCal address (Google Calendar → Settings → your calendar →
 * "Secret address in iCal format"). No Google sign-in or API project is needed and HomeHub can only read. The address is
 * itself a secret, so it is kept in Secret Manager. Recurring events are expanded (DAILY / WEEKLY with BYDAY / MONTHLY /
 * YEARLY, INTERVAL, COUNT, UNTIL, EXDATE); anything more exotic is shown once at its first date and flagged `recurs: true`.
 */
export interface CalEvent { uid: string; title: string; start: string; end?: string; allDay: boolean; location?: string; recurs?: boolean }

const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, "");
const unescapeText = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

function parseWhen(value: string, params: string): { dt: DateTime; allDay: boolean } | null {
  if (/VALUE=DATE(?!-)/.test(params) || /^\d{8}$/.test(value)) {
    const d = DateTime.fromFormat(value, "yyyyMMdd", { zone: "utc" });
    return d.isValid ? { dt: d, allDay: true } : null;
  }
  const tz = /TZID=([^;:]+)/.exec(params)?.[1];
  const utc = value.endsWith("Z");
  const d = DateTime.fromFormat(value.replace(/Z$/, ""), "yyyyMMdd'T'HHmmss", { zone: utc ? "utc" : tz ?? "utc" });
  return d.isValid ? { dt: d.toUTC(), allDay: false } : null;
}

interface Raw { uid: string; title: string; start: { dt: DateTime; allDay: boolean }; end?: DateTime; location?: string; rrule?: string; exdates: Set<string>; recurrenceId?: string }

export function parseIcs(text: string): Raw[] {
  const out: Raw[] = [];
  let cur: Raw | null = null;
  for (const line of unfold(text).split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") { cur = { uid: "", title: "", start: undefined as never, exdates: new Set() }; continue; }
    if (line === "END:VEVENT") { if (cur?.start) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...rest] = head.split(";"); const params = rest.join(";");
    switch (name.toUpperCase()) {
      case "UID": cur.uid = value; break;
      case "SUMMARY": cur.title = unescapeText(value); break;
      case "LOCATION": cur.location = unescapeText(value) || undefined; break;
      case "DTSTART": { const w = parseWhen(value, params); if (w) cur.start = w; break; }
      case "DTEND": { const w = parseWhen(value, params); if (w) cur.end = w.dt; break; }
      case "RRULE": cur.rrule = value; break;
      case "RECURRENCE-ID": cur.recurrenceId = value; break;
      case "EXDATE": for (const v of value.split(",")) { const w = parseWhen(v, params); if (w) cur.exdates.add(w.dt.toISO()!); } break;
    }
  }
  return out;
}

const DAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** Occurrence start times of one raw event inside [from, to]. */
export function occurrences(ev: Raw, from: DateTime, to: DateTime, max = 200): { starts: DateTime[]; unsupported: boolean } {
  const first = ev.start.dt;
  if (!ev.rrule) return { starts: first >= from.minus({ days: 1 }) && first <= to ? [first] : [], unsupported: false };
  const r = Object.fromEntries(ev.rrule.split(";").map((p) => p.split("=") as [string, string]));
  const freq = r.FREQ, interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1);
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq) || r.BYSETPOS || r.BYMONTHDAY?.includes(",") || (freq === "MONTHLY" && r.BYDAY)) {
    return { starts: first >= from && first <= to ? [first] : [], unsupported: true };
  }
  const until = r.UNTIL ? parseWhen(r.UNTIL, "")?.dt ?? null : null;
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const days = r.BYDAY ? r.BYDAY.split(",").map((d) => DAY.indexOf(d.slice(-2))).filter((n) => n >= 0) : [];
  const starts: DateTime[] = [];
  let n = 0;
  const emit = (d: DateTime): boolean => { // returns false to stop
    if (until && d > until) return false;
    if (++n > count) return false;
    if (d > to) return false;
    if (d >= from.minus({ days: 1 }) && !ev.exdates.has(d.toISO()!)) starts.push(d);
    return starts.length < max;
  };
  for (let k = 0; k < 5000; k++) {
    if (freq === "WEEKLY") {
      const weekStart = first.startOf("week").plus({ weeks: k * interval }).set({ hour: first.hour, minute: first.minute, second: first.second });
      const set = days.length ? days : [first.weekday - 1];
      for (const wd of [...set].sort((a, b) => a - b)) {
        const d = weekStart.plus({ days: wd });
        if (d < first) continue;
        if (!emit(d)) return { starts, unsupported: false };
      }
    } else {
      const d = freq === "DAILY" ? first.plus({ days: k * interval }) : freq === "MONTHLY" ? first.plus({ months: k * interval }) : first.plus({ years: k * interval });
      if (freq === "MONTHLY" && d.day !== first.day) continue; // e.g. the 31st skips short months, as iCal does
      if (!emit(d)) return { starts, unsupported: false };
    }
  }
  return { starts, unsupported: false };
}

export function upcoming(text: string, now: DateTime, days: number, zone: string, limit: number): CalEvent[] {
  const to = now.plus({ days });
  const raws = parseIcs(text);
  const overridden = new Set(raws.filter((r) => r.recurrenceId).map((r) => `${r.uid}|${r.recurrenceId}`));
  const out: Array<CalEvent & { _t: number }> = [];
  for (const ev of raws) {
    const { starts, unsupported } = occurrences(ev, now, to);
    for (const s of starts) {
      if (!ev.recurrenceId && overridden.has(`${ev.uid}|${s.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")}`)) continue;
      const dur = ev.end ? ev.end.toMillis() - ev.start.dt.toMillis() : 0;
      const end = dur > 0 ? s.plus({ milliseconds: dur }) : undefined;
      if ((end ?? s) < now && !ev.start.allDay) continue;
      const fmt = (d: DateTime) => ev.start.allDay ? d.toUTC().toISODate()! : d.setZone(zone).toISO({ suppressMilliseconds: true })!;
      out.push({ uid: ev.uid, title: ev.title || "(no title)", start: fmt(s), end: end ? fmt(end) : undefined, allDay: ev.start.allDay, location: ev.location, recurs: ev.rrule ? true : undefined, _t: s.toMillis() });
      void unsupported;
    }
  }
  return out.sort((a, b) => a._t - b._t).slice(0, limit).map(({ _t, ...e }) => e);
}

export const googleCalendar = definePlugin({
  manifest: {
    manifestVersion: 1, id: "homehub.google-calendar", name: "Google Calendar (read-only)", publisher: "HomeHub", tier: "first_party", supportLevel: "official_api",
    version: "1.0.0", category: "productivity", icon: "calendar",
    description: "Let the assistant see your Google Calendar for scheduling and conflict checks. Read-only: uses the calendar's private iCal address, so no Google sign-in is shared.",
    docsUrl: "https://support.google.com/calendar/answer/37648",
    regions: ["*"], languages: ["en"], platforms: ["server"], minApiVersion: 1,
    auth: { method: "api_key", scopes: [] }, dataCategories: ["calendar event titles, times and locations"],
    tools: [{
      name: "list_upcoming_events", description: "Events from the linked Google Calendar in the next N days",
      input: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 60, default: 7 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 30 } }, additionalProperties: false },
      access: "read", risk: "low", idempotent: true, confirmation: "none", physicalSafety: false,
    }],
    events: [],
    lifecycle: { setup: false, healthCheck: true, disconnect: false, refreshCredentials: false, deleteData: false },
    network: ["https://calendar.google.com"], userNetworkFields: [],
    privacy: { policyUrl: "https://policies.google.com/privacy", retention: "HomeHub reads events on request and does not store them.", support: "HomeHub support" },
    config: [
      { key: "icalUrl", label: "Secret iCal address", type: "string", required: true, secret: true, help: "Google Calendar → Settings → your calendar → Integrate calendar → Secret address in iCal format." },
      { key: "timezone", label: "Time zone (e.g. Asia/Kolkata)", type: "string", required: false, secret: false },
    ],
  },
  handlers: {
    async healthCheck(ctx) {
      const url = await ctx.secret("icalUrl");
      if (!url || !/^https:\/\/calendar\.google\.com\/calendar\/ical\//.test(url)) return { ok: false, message: "That doesn't look like a Google Calendar iCal address" };
      try { const r = await ctx.fetch(url); return r.ok ? { ok: true } : { ok: false, message: `Google answered ${r.status}. Check the address.` }; }
      catch { return { ok: false, message: "Could not reach Google Calendar" }; }
    },
    tools: {
      list_upcoming_events: async (ctx, input) => {
        const url = await ctx.secret("icalUrl");
        if (!url || !/^https:\/\/calendar\.google\.com\/calendar\/ical\//.test(url)) throw new Error("The iCal address is missing or isn't a Google Calendar address");
        const res = await ctx.fetch(url);
        if (!res.ok) throw new Error(`Google Calendar answered ${res.status}`);
        const zone = String(ctx.config.timezone || "Asia/Kolkata");
        const events = upcoming(await res.text(), DateTime.fromJSDate(ctx.now()), Math.min(60, Number(input.days ?? 7) || 7), DateTime.local().setZone(zone).isValid ? zone : "UTC", Math.min(100, Number(input.limit ?? 30) || 30));
        return { events, count: events.length };
      },
    },
  },
});
