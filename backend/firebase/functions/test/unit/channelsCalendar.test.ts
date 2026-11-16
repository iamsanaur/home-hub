import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { upcoming } from "../../src/plugins/builtins/googleCalendar";
import { telegram } from "../../src/plugins/builtins/telegram";
import { googleCalendar } from "../../src/plugins/builtins/googleCalendar";
import { validateManifest, networkAllowed } from "../../src/plugins/manifest";
import type { PluginContext } from "../../src/plugins/sdk";

const ICS = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;
const now = DateTime.fromISO("2026-11-16T03:00:00Z", { zone: "utc" });
const ctx = (over: Partial<PluginContext> & { fetchImpl?: (u: string, i?: RequestInit) => Promise<Response> }): PluginContext => ({
  householdId: "h", integrationId: "i", config: {}, secret: async () => null, fetch: over.fetchImpl ?? (async () => new Response("{}")),
  store: { get: async () => null, set: async () => {} }, reportDevice: async () => {}, log: () => {}, now: () => now.toJSDate(), ...over,
} as PluginContext);

describe("calendar reader", () => {
  it("reads timed, all-day and floating events, sorted", () => {
    const ev = upcoming(ICS(
      "BEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Asia/Kolkata:20261118T170000\r\nDTEND;TZID=Asia/Kolkata:20261118T180000\r\nSUMMARY:Parents\\, dinner\r\nLOCATION:Home\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:b\r\nDTSTART;VALUE=DATE:20261117\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n"), now, 7, "Asia/Kolkata", 10);
    expect(ev.map((e) => e.title)).toEqual(["Holiday", "Parents, dinner"]);
    expect(ev[0].allDay).toBe(true); expect(ev[0].start).toBe("2026-11-17");
    expect(ev[1].start).toBe("2026-11-18T17:00:00+05:30"); expect(ev[1].location).toBe("Home");
  });
  it("expands weekly recurrence with BYDAY, COUNT and EXDATE", () => {
    const ev = upcoming(ICS("BEGIN:VEVENT\r\nUID:w\r\nDTSTART:20261102T040000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=8\r\nEXDATE:20261119T040000Z\r\nSUMMARY:Swim\r\nEND:VEVENT\r\n"), now, 14, "UTC", 20);
    expect(ev.map((e) => e.start.slice(0, 10))).toEqual(["2026-11-16", "2026-11-23", "2026-11-26"]); // Mon 16, (Thu 19 excluded), Mon 23, Thu 26 (8th occurrence is Thu 26? count caps)
  });
  it("honours UNTIL and skips events that have already finished", () => {
    const ev = upcoming(ICS("BEGIN:VEVENT\r\nUID:d\r\nDTSTART:20261110T040000Z\r\nDTEND:20261110T050000Z\r\nRRULE:FREQ=DAILY;UNTIL=20261118T040000Z\r\nSUMMARY:Walk\r\nEND:VEVENT\r\n"), now, 10, "UTC", 20);
    expect(ev.map((e) => e.start.slice(0, 10))).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
  });
  it("a moved occurrence replaces the original", () => {
    const ev = upcoming(ICS(
      "BEGIN:VEVENT\r\nUID:m\r\nDTSTART:20261116T040000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:m\r\nRECURRENCE-ID:20261117T040000Z\r\nDTSTART:20261117T100000Z\r\nSUMMARY:Standup (moved)\r\nEND:VEVENT\r\n"), now, 5, "UTC", 20);
    expect(ev.map((e) => e.title + e.start.slice(11, 16))).toEqual(["Standup04:00", "Standup (moved)10:00", "Standup04:00"]);
  });
});

describe("plugin manifests", () => {
  it("are valid and keep to their network allowlists", () => {
    for (const p of [telegram, googleCalendar]) expect(validateManifest(p.manifest).ok, p.manifest.id).toBe(true);
    expect(networkAllowed(telegram.manifest, "https://api.telegram.org/botX/sendMessage")).toBe(true);
    expect(networkAllowed(telegram.manifest, "https://evil.example/x")).toBe(false);
    expect(telegram.manifest.tools[0].confirmation).toBe("approval");
    expect(googleCalendar.manifest.tools.every((t) => t.access === "read")).toBe(true);
  });
});

describe("telegram", () => {
  it("sends to the configured chat and never leaks the token in errors", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const c = ctx({ config: { chatId: "-100123" }, secret: async () => "SECRET:TOKEN", fetchImpl: async (u, i) => { sent = { url: u, body: JSON.parse(String(i?.body)) }; return new Response(JSON.stringify({ ok: true, result: {} })); } });
    expect(await telegram.handlers.tools.send_message(c, { text: "Milk is low" })).toEqual({ delivered: true });
    expect(sent!.url).toContain("/botSECRET:TOKEN/sendMessage"); expect(sent!.body).toMatchObject({ chat_id: "-100123", text: "Milk is low" });
    const bad = ctx({ config: { chatId: "-100123" }, secret: async () => "SECRET:TOKEN", fetchImpl: async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }) });
    await expect(telegram.handlers.tools.send_message(bad, { text: "x" })).rejects.toThrow(/chat not found/);
    await expect(telegram.handlers.tools.send_message(ctx({ config: { chatId: "abc" }, secret: async () => "t" }), { text: "x" })).rejects.toThrow(/Chat ID/);
    await expect(telegram.handlers.tools.send_message(ctx({ config: { chatId: "1" } }), { text: "x" })).rejects.toThrow(/token is missing/);
  });
  it("health check reports an invalid token without throwing", async () => {
    const r = await telegram.handlers.healthCheck!(ctx({ secret: async () => "t", fetchImpl: async () => new Response("{}", { status: 401 }) }));
    expect(r.ok).toBe(false);
  });
});

describe("google calendar tool", () => {
  it("refuses addresses that are not Google Calendar", async () => {
    await expect(googleCalendar.handlers.tools.list_upcoming_events(ctx({ secret: async () => "https://evil.example/a.ics" }), {})).rejects.toThrow(/Google Calendar address/);
  });
});
