import { DateTime } from "luxon";
import { Actor, AppError, Ctx, paths } from "../services/base";
import { recordAuditEvent } from "../services/auditEvents";
import { computeBriefing } from "../services/reports";
import { listTasks } from "../services/tasks";
import { addShoppingItem } from "../services/food";
import { resolveAlexaToken, AlexaPrincipal } from "./oauth";

/**
 * HomeHub custom Alexa skill ("Alexa, ask Home Hub …"). Deterministic: no model calls.
 * Voice is a shared, overheard channel, so answers never include finance amounts, and
 * writes ask for confirmation first (Dialog.ConfirmIntent).
 *
 * Intents (see backend/alexa/skill-package/interactionModels):
 *   ShoppingListIntent, AddShoppingItemIntent{item}, ChoresIntent, DinnerIntent,
 *   BriefingIntent, DoorLockedIntent, AMAZON.HelpIntent / StopIntent / CancelIntent / FallbackIntent
 */
type Json = Record<string, any>;

const MAX_SPOKEN_ITEMS = 6;

function speak(text: string, opts: { end?: boolean; reprompt?: string; card?: Json; directives?: Json[] } = {}) {
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      ...(opts.reprompt ? { reprompt: { outputSpeech: { type: "PlainText", text: opts.reprompt } } } : {}),
      ...(opts.card ? { card: opts.card } : {}),
      ...(opts.directives ? { directives: opts.directives } : {}),
      shouldEndSession: opts.end ?? true,
    },
  };
}

const list = (xs: string[]) => {
  const shown = xs.slice(0, MAX_SPOKEN_ITEMS);
  const more = xs.length - shown.length;
  const body = shown.length <= 1 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return more > 0 ? `${body}, plus ${more} more` : body;
};

export async function handleCustomSkill(ctx: Ctx, body: Json): Promise<Json> {
  const req = body?.request ?? {};
  if (req.type === "SessionEndedRequest") return { version: "1.0", response: {} };
  const token = body?.context?.System?.user?.accessToken ?? body?.session?.user?.accessToken;
  let p: AlexaPrincipal;
  try { p = await resolveAlexaToken(ctx, token); }
  catch (e) {
    const msg = e instanceof AppError && e.code === "INSUFFICIENT_PERMISSIONS"
      ? "This HomeHub account can no longer use Alexa. Ask a household manager for help."
      : "To use Home Hub, link your account in the Alexa app. I've sent a card to help.";
    return speak(msg, { card: { type: "LinkAccount" } });
  }
  const actor: Actor = { uid: p.uid, kind: "user" };
  const hid = p.householdId;

  if (req.type === "LaunchRequest") {
    return speak("Home Hub here. You can ask what's on the shopping list, your chores, tonight's dinner, or for today's briefing.", { end: false, reprompt: "What would you like?" });
  }
  if (req.type !== "IntentRequest") return speak("Sorry, I can't help with that yet.");

  const intent = req.intent ?? {};
  const name: string = intent.name ?? "";
  const done = async (action: string, result: "succeeded" | "failed" | "denied", details: Json = {}) =>
    recordAuditEvent(ctx, hid, { actorUid: p.uid, actorKind: "user", channel: "alexa", target: { type: "intent", id: name }, requestedAction: `alexa.${action}`, result, details });

  try {
    switch (name) {
      case "ShoppingListIntent": {
        const items = await openShoppingItems(ctx, hid);
        await done("shopping_list", "succeeded", { count: items.length });
        return speak(items.length ? `On your shopping list: ${list(items)}.` : "Your shopping list is empty.");
      }
      case "AddShoppingItemIntent": {
        const item = String(intent.slots?.item?.value ?? "").trim().slice(0, 120);
        if (!item) return speak("What should I add to the shopping list?", { end: false, reprompt: "Say, for example, add milk." });
        if (intent.confirmationStatus === "NONE" || !intent.confirmationStatus) {
          return speak(`Add ${item} to the shopping list?`, { end: false, directives: [{ type: "Dialog.ConfirmIntent", updatedIntent: intent }] });
        }
        if (intent.confirmationStatus === "DENIED") return speak("Okay, I didn't add it.");
        const listId = await defaultListId(ctx, hid);
        if (!listId) return speak("You don't have a shopping list yet. Create one in the Home Hub app.");
        const r = await addShoppingItem(ctx, hid, actor, { listId, name: item, quantity: 1, unit: "pcs", category: "Other" });
        await done("add_shopping_item", "succeeded", { itemId: r.id, merged: r.merged });
        return speak(r.merged ? `${item} was already on the list, so I increased the quantity.` : `Added ${item} to the shopping list.`);
      }
      case "ChoresIntent": {
        const tasks = await listTasks(ctx, hid, actor, "today", 20);
        await done("chores", "succeeded", { count: tasks.length });
        return speak(tasks.length ? `You have ${tasks.length} task${tasks.length > 1 ? "s" : ""} for today: ${list(tasks.map((t) => t.title))}.` : "Nothing is due for you today.");
      }
      case "DinnerIntent": {
        const dinner = await tonightsDinner(ctx, hid);
        await done("dinner", "succeeded");
        return speak(dinner ? `Tonight's dinner is ${dinner}.` : "There's no dinner planned for tonight. You can plan meals in the Home Hub app.");
      }
      case "BriefingIntent": {
        const b = await computeBriefing(ctx, hid, actor);
        // Spoken briefings omit finance: amounts and bill names stay in the app.
        const parts: string[] = [];
        if (b.overdueTasks.length) parts.push(`${b.overdueTasks.length} overdue task${b.overdueTasks.length > 1 ? "s" : ""}`);
        if (b.dueToday.length) parts.push(`${b.dueToday.length} task${b.dueToday.length > 1 ? "s" : ""} due today`);
        if (b.events.length) parts.push(`${b.events.length} event${b.events.length > 1 ? "s" : ""}: ${list(b.events.map((e) => e.title))}`);
        if (b.lowStock.length) parts.push(`running low on ${list(b.lowStock)}`);
        if (b.maintenance.length) parts.push(`${b.maintenance.length} service reminder${b.maintenance.length > 1 ? "s" : ""}`);
        await done("briefing", "succeeded");
        return speak(parts.length ? `Today: ${parts.join("; ")}.` : "Nothing urgent today.");
      }
      case "DoorLockedIntent": {
        const locks = await ctx.db.collection(paths.col(hid, "devices")).where("type", "==", "lock").where("alexa.exposed", "==", true).limit(10).get();
        await done("door_locked", "succeeded", { locks: locks.size });
        if (locks.empty) return speak("I don't see any locks shared with Alexa.");
        const now = ctx.now().getTime();
        const said = locks.docs.map((d) => {
          const v = d.data();
          const fresh = v.reachable !== false && now - (v.lastSeenAt?.toMillis?.() ?? 0) < 60 * 60_000;
          if (!fresh) return `I can't reach the ${v.name} right now`;
          return v.state?.lock === "LOCKED" ? `the ${v.name} is locked` : v.state?.lock === "UNLOCKED" ? `the ${v.name} is unlocked` : `I'm not sure about the ${v.name}`;
        });
        const s = said.join(", ");
        return speak(s.charAt(0).toUpperCase() + s.slice(1) + ".");
      }
      case "AMAZON.HelpIntent":
        return speak("Try: what's on the shopping list, add eggs, what are my chores, what's for dinner, give me my briefing, or is the front door locked.", { end: false, reprompt: "What would you like?" });
      case "AMAZON.StopIntent":
      case "AMAZON.CancelIntent":
        return speak("Okay.");
      default:
        return speak("I can help with the shopping list, chores, dinner, the briefing, and locks. Say help for examples.", { end: false });
    }
  } catch (e) {
    await done(name || "unknown", e instanceof AppError && e.status === 403 ? "denied" : "failed", { code: e instanceof AppError ? e.code : "internal" }).catch(() => undefined);
    if (e instanceof AppError && e.status === 403) return speak("Your Home Hub role doesn't allow that.");
    return speak("Home Hub couldn't do that right now. Please try again in the app.");
  }
}

async function openShoppingItems(ctx: Ctx, hid: string): Promise<string[]> {
  const listId = await defaultListId(ctx, hid);
  if (!listId) return [];
  const snap = await ctx.db.collection(paths.col(hid, "groceryItems")).where("listId", "==", listId).where("purchased", "==", false).limit(30).get();
  return snap.docs.map((d) => d.data().name as string);
}

/** Most recently updated, non-archived list. */
async function defaultListId(ctx: Ctx, hid: string): Promise<string | null> {
  const snap = await ctx.db.collection(paths.col(hid, "shoppingLists")).where("archived", "==", false).limit(20).get();
  if (snap.empty) return null;
  const sorted = snap.docs.sort((a, b) => (b.data().updatedAt?.toMillis?.() ?? 0) - (a.data().updatedAt?.toMillis?.() ?? 0));
  return sorted[0].id;
}

async function tonightsDinner(ctx: Ctx, hid: string): Promise<string | null> {
  const tz = (await ctx.db.doc(paths.household(hid)).get()).data()?.timezone ?? "UTC";
  const today = DateTime.fromJSDate(ctx.now()).setZone(tz).toISODate()!;
  const plans = await ctx.db.collection(paths.col(hid, "mealPlans")).where("weekStart", "<=", today).orderBy("weekStart", "desc").limit(2).get();
  for (const p of plans.docs) {
    const e = (p.data().entries ?? []).find((x: Json) => x.date === today && x.slot === "dinner");
    if (e) return String(e.title);
  }
  return null;
}
