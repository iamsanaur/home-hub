import { DateTime } from "luxon";
import { getMessaging } from "firebase-admin/messaging";
import { Ctx, paths, sha256, ts } from "./base";

export type NotificationCategory =
  | "tasks" | "bills" | "pantry" | "maintenance" | "approvals" | "agent" | "briefing" | "calendar";

export interface NotifyInput {
  recipients: string[];
  category: NotificationCategory;
  title: string;
  body: string;
  deepLink?: string;
  dedupeKey: string; // same key + recipient → one notification
}

interface Prefs {
  categories?: Partial<Record<NotificationCategory, boolean>>;
  quietHours?: { start: string; end: string } | null; // "22:00"–"07:00" local
  timezone?: string;
}

export function inQuietHours(prefs: Prefs, now: Date, fallbackTz: string): boolean {
  const q = prefs.quietHours;
  if (!q) return false;
  const local = DateTime.fromJSDate(now).setZone(prefs.timezone ?? fallbackTz);
  const minutes = local.hour * 60 + local.minute;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const start = toMin(q.start);
  const end = toMin(q.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * In-app notifications are always written (deduplicated by deterministic ID).
 * Push is sent only when the category is enabled, outside quiet hours, and FCM is
 * configured (FCM_ENABLED=true). Approvals bypass quiet hours only for the in-app
 * record, never for push.
 */
export async function notify(ctx: Ctx, hid: string, input: NotifyInput): Promise<{ created: number; pushed: number }> {
  if (input.recipients.length === 0) return { created: 0, pushed: 0 };
  const hh = await ctx.db.doc(paths.household(hid)).get();
  const tz = hh.data()?.timezone ?? "UTC";
  let created = 0;
  let pushed = 0;
  for (const uid of [...new Set(input.recipients)]) {
    const id = sha256(`${input.dedupeKey}|${uid}`).slice(0, 32);
    const ref = ctx.db.doc(`${paths.col(hid, "notifications")}/${id}`);
    try {
      await ref.create({
        householdId: hid, recipientUid: uid, category: input.category, title: input.title.slice(0, 120),
        body: input.body.slice(0, 400), deepLink: input.deepLink ?? null, dedupeKey: input.dedupeKey,
        createdAt: ts(ctx.now()), readAt: null,
      });
      created++;
    } catch (e: unknown) {
      if ((e as { code?: number }).code === 6) continue; // already notified
      throw e;
    }
    const user = await ctx.db.doc(`users/${uid}`).get();
    const prefs: Prefs = user.data()?.notificationPrefs ?? {};
    if (prefs.categories?.[input.category] === false) continue;
    if (inQuietHours(prefs, ctx.now(), tz)) continue;
    if (process.env.FCM_ENABLED !== "true") continue;
    const devices = await ctx.db.collection(`users/${uid}/devices`).get();
    const tokens = devices.docs.map((d) => d.data().token as string).filter(Boolean);
    if (tokens.length === 0) continue;
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: input.title, body: input.body },
      data: { householdId: hid, category: input.category, deepLink: input.deepLink ?? "", notificationId: id },
      // Channel ids match the Android app (notifications/HomeHubMessagingService.kt).
      android: { collapseKey: input.category, priority: input.category === "approvals" ? "high" : "normal", notification: { channelId: input.category === "approvals" ? "approvals" : "household" } },
      apns: { payload: { aps: { "thread-id": input.category } } },
    });
    pushed += res.successCount;
    // Remove tokens FCM reports as invalid (handles token rotation and uninstall).
    await Promise.all(res.responses.map(async (r, i) => {
      const code = r.error?.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        await devices.docs[i].ref.delete();
      }
    }));
  }
  return { created, pushed };
}
