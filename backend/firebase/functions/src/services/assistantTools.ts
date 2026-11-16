/**
 * Everything the assistant needs to do what the apps do, beyond the original tool set: reading shopping lists, pantry
 * usage, budgets and income, editing events and fixed bills, recipes, cleaning routines, notes, memory, and (through the
 * integration runtime) devices, automations and connected services. Each function checks the caller's role the same way
 * the apps' Firestore rules do, writes an audit event, and never moves money or contacts anyone.
 */
import { DateTime } from "luxon";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { can } from "../core/roles";
import { Actor, audit, AppError, Ctx, forbidden, invalid, notFound, paths, requireCapability, requireMember, ts } from "./base";
import { createDoc, toIso, updateDoc } from "./docs";
import { adjustPantry, normalizeName } from "./food";
import { checkScheduleConflicts } from "./home";

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
/** Finds one document by id, exact name, or unique "contains" match; otherwise explains what to choose from. */
function pick<T extends { id: string; name: string }>(rows: T[], ref: string | undefined, what: string): T {
  if (!rows.length) throw notFound(what);
  const r = lc(ref);
  if (!r) { if (rows.length === 1) return rows[0]; throw invalid(`Which ${what}? Options: ${rows.slice(0, 8).map((x) => x.name).join(", ")}`); }
  const hit = rows.find((x) => x.id === ref) ?? rows.find((x) => lc(x.name) === r);
  if (hit) return hit;
  const some = rows.filter((x) => lc(x.name).includes(r) || r.includes(lc(x.name)));
  if (some.length === 1) return some[0];
  throw invalid(some.length ? `More than one ${what} matches "${ref}": ${some.slice(0, 8).map((x) => x.name).join(", ")}` : `No ${what} called "${ref}". Options: ${rows.slice(0, 8).map((x) => x.name).join(", ")}`);
}

// ---------------- shopping ----------------

export async function listShoppingLists(ctx: Ctx, hid: string, a: Actor) {
  await requireMember(ctx, hid, a.uid);
  const s = await ctx.db.collection(paths.col(hid, "shoppingLists")).where("archived", "==", false).limit(50).get();
  return s.docs.map((d) => ({ id: d.id, name: d.data().name as string, store: d.data().store ?? null, items: d.data().itemCount ?? 0, purchased: d.data().purchasedCount ?? 0 }));
}

export async function getShoppingList(ctx: Ctx, hid: string, a: Actor, o: { list?: string; includePurchased?: boolean }) {
  const lists = await listShoppingLists(ctx, hid, a);
  const list = pick(lists, o.list, "shopping list");
  const s = await ctx.db.collection(paths.col(hid, "groceryItems")).where("listId", "==", list.id).limit(300).get();
  const items = s.docs.map((d) => {
    const x = d.data();
    return { id: d.id, name: x.name as string, quantity: x.quantity as number, unit: x.unit as string, category: x.category ?? null, estimatedPriceMinor: x.estimatedPriceMinor ?? null, purchased: !!x.purchased };
  }).filter((i) => o.includePurchased || !i.purchased);
  return { list: { id: list.id, name: list.name }, count: items.length, items };
}

/** Finds an unpurchased item by id or by name (optionally within one list) so the assistant never needs to guess an id. */
export async function findShoppingItem(ctx: Ctx, hid: string, a: Actor, o: { itemId?: string; item?: string; list?: string }): Promise<string> {
  if (o.itemId) return o.itemId;
  if (!o.item) throw invalid("Say which item (its name or id). Use get_shopping_list to see what is on the list.");
  const lists = o.list ? [pick(await listShoppingLists(ctx, hid, a), o.list, "shopping list")] : await listShoppingLists(ctx, hid, a);
  const key = normalizeName(o.item);
  const found: Array<{ id: string; name: string }> = [];
  for (const l of lists) {
    const s = await ctx.db.collection(paths.col(hid, "groceryItems")).where("listId", "==", l.id).where("purchased", "==", false).limit(300).get();
    s.docs.forEach((d) => { const k = d.data().nameKey as string; if (k === key || k.includes(key) || key.includes(k)) found.push({ id: d.id, name: `${d.data().name} (${l.name})` }); });
  }
  if (found.length === 1) return found[0].id;
  if (!found.length) throw notFound(`Unpurchased item "${o.item}"`);
  throw invalid(`More than one item matches "${o.item}": ${found.slice(0, 8).map((f) => f.name).join(", ")}. Pass list or item_id.`);
}

export async function updateShoppingItem(ctx: Ctx, hid: string, a: Actor, itemId: string, patch: { quantity?: number; unit?: string; estimatedPriceMinor?: number | null; preferredBrand?: string | null; category?: string }) {
  await requireCapability(ctx, hid, a.uid, "shopping.write");
  const r = await updateDoc(ctx, hid, "groceryItems", itemId, a, patch);
  return { id: itemId, version: r.version };
}

export async function removeShoppingItem(ctx: Ctx, hid: string, a: Actor, itemId: string) {
  await requireCapability(ctx, hid, a.uid, "shopping.write");
  const ref = ctx.db.doc(`${paths.col(hid, "groceryItems")}/${itemId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Shopping item");
  const x = snap.data()!;
  await ref.delete();
  await ctx.db.doc(`${paths.col(hid, "shoppingLists")}/${x.listId}`).update({ itemCount: FieldValue.increment(-1), ...(x.purchased ? { purchasedCount: FieldValue.increment(-1) } : {}) }).catch(() => undefined);
  await audit(ctx, hid, a, "shopping.item_removed", { type: "groceryItem", id: itemId }, { name: x.name });
  return { removed: x.name as string };
}

// ---------------- pantry usage ----------------

export async function adjustPantryByName(ctx: Ctx, hid: string, a: Actor, o: { item: string; kind: "consume" | "restock" | "waste"; quantity: number; note?: string }) {
  await requireCapability(ctx, hid, a.uid, "pantry.write");
  const s = await ctx.db.collection(paths.col(hid, "pantryItems")).limit(300).get();
  const rows = s.docs.map((d) => ({ id: d.id, name: d.data().name as string, unit: d.data().unit as string, quantity: d.data().quantity as number }));
  const it = pick(rows, o.item, "pantry item");
  await adjustPantry(ctx, hid, a, it.id, o.kind === "restock" ? o.quantity : -o.quantity, o.kind, o.note);
  const now = (await ctx.db.doc(`${paths.col(hid, "pantryItems")}/${it.id}`).get()).data()!;
  await audit(ctx, hid, a, `pantry.${o.kind}`, { type: "pantryItem", id: it.id }, { quantity: o.quantity });
  return { id: it.id, name: it.name, unit: it.unit, quantity: now.quantity as number, lowStock: !!now.lowStock };
}

// ---------------- budgets ----------------

export async function setBudget(ctx: Ctx, hid: string, a: Actor, o: { period: string; category: string; limitMinor: number }) {
  await requireCapability(ctx, hid, a.uid, "finance.write");
  const currency = ((await ctx.db.doc(paths.household(hid)).get()).data()?.currency as string) ?? "INR";
  const col = ctx.db.collection(paths.col(hid, "budgets"));
  const ex = await col.where("period", "==", o.period).where("category", "==", o.category).limit(1).get();
  if (!ex.empty) {
    await updateDoc(ctx, hid, "budgets", ex.docs[0].id, a, { limitMinor: o.limitMinor });
    await audit(ctx, hid, a, "finance.budget_updated", { type: "budget", id: ex.docs[0].id }, { limitMinor: o.limitMinor });
    return { id: ex.docs[0].id, updated: true };
  }
  const { id } = await createDoc(ctx, hid, "budgets", a, { period: o.period, category: o.category, limitMinor: o.limitMinor, currency });
  await audit(ctx, hid, a, "finance.budget_set", { type: "budget", id }, { limitMinor: o.limitMinor, category: o.category });
  return { id, updated: false };
}

// ---------------- calendar edits ----------------

export const EventPatch = z.object({
  title: z.string().trim().min(1).max(160).optional(), startAt: z.string().optional(), endAt: z.string().optional(),
  location: z.string().max(200).nullable().optional(), category: z.enum(["appointment", "birthday", "anniversary", "school", "bill", "task", "social", "other"]).optional(),
});

export async function updateEvent(ctx: Ctx, hid: string, a: Actor, eventId: string, p: z.infer<typeof EventPatch>) {
  await requireCapability(ctx, hid, a.uid, "calendar.write");
  const patch: Record<string, unknown> = { ...p };
  const cur = (await ctx.db.doc(`${paths.col(hid, "events")}/${eventId}`).get()).data();
  if (!cur) throw notFound("Event");
  const start = p.startAt ?? toIso(cur.startAt)!, end = p.endAt ?? toIso(cur.endAt)!;
  if (new Date(end) < new Date(start)) throw invalid("The event can't end before it starts");
  if (p.startAt) patch.startAt = Timestamp.fromDate(new Date(p.startAt));
  if (p.endAt) patch.endAt = Timestamp.fromDate(new Date(p.endAt));
  const r = await updateDoc(ctx, hid, "events", eventId, a, patch);
  const conflicts = p.startAt || p.endAt ? (await checkScheduleConflicts(ctx, hid, a, start, end, (cur.attendeeUids as string[]) ?? [])).conflicts.filter((c: { id?: string }) => c.id !== eventId) : [];
  await audit(ctx, hid, a, "calendar.event_updated", { type: "event", id: eventId }, { fields: Object.keys(p) });
  return { id: eventId, version: r.version, conflicts };
}

export async function cancelEvent(ctx: Ctx, hid: string, a: Actor, eventId: string) {
  await requireCapability(ctx, hid, a.uid, "calendar.write");
  const ref = ctx.db.doc(`${paths.col(hid, "events")}/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Event");
  await ref.delete();
  await audit(ctx, hid, a, "calendar.event_cancelled", { type: "event", id: eventId }, { title: snap.data()!.title });
  return { cancelled: snap.data()!.title as string };
}

// ---------------- fixed bills ----------------

export const FixedBillPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(), amountMinor: z.number().int().min(1).max(100_000_000_00).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), repeat: z.enum(["monthly", "yearly", "none"]).optional(), active: z.boolean().optional(),
});

export async function updateFixedBill(ctx: Ctx, hid: string, a: Actor, billId: string, p: z.infer<typeof FixedBillPatch>) {
  await requireCapability(ctx, hid, a.uid, "finance.write");
  const tz = ((await ctx.db.doc(paths.household(hid)).get()).data()?.timezone as string) ?? "UTC";
  const patch: Record<string, unknown> = {};
  if (p.name) patch.name = p.name;
  if (p.amountMinor) patch.amountMinor = p.amountMinor;
  if (p.active !== undefined) patch.active = p.active;
  if (p.repeat) patch.recurrence = p.repeat === "none" ? null : { freq: p.repeat };
  if (p.dueDate) { const d = DateTime.fromISO(p.dueDate, { zone: tz }).set({ hour: 10 }); if (!d.isValid) throw invalid("dueDate must be YYYY-MM-DD"); patch.nextDueAt = Timestamp.fromDate(d.toJSDate()); }
  const r = await updateDoc(ctx, hid, "bills", billId, a, patch, undefined, (cur) => { if (cur.kind === "metered") throw invalid("This is a pay-per-delivery bill: use update_vendor_bill to change its rate or schedule"); });
  await audit(ctx, hid, a, "bills.updated", { type: "bill", id: billId }, { fields: Object.keys(patch) });
  return { id: billId, version: r.version };
}

// ---------------- recipes ----------------

export const RecipeInput = z.object({
  name: z.string().trim().min(1).max(120), servings: z.number().int().min(1).max(50).default(2),
  ingredients: z.array(z.object({ name: z.string().trim().min(1).max(80), quantity: z.number().positive().max(100000), unit: z.string().max(20).default("pcs"), category: z.string().max(40).optional() })).min(1).max(60),
  tags: z.array(z.string().max(30)).max(10).default([]), instructions: z.string().max(4000).optional(),
});

export async function listRecipes(ctx: Ctx, hid: string, a: Actor, limit = 50) {
  await requireMember(ctx, hid, a.uid);
  const s = await ctx.db.collection(paths.col(hid, "recipes")).limit(limit).get();
  return s.docs.map((d) => ({ id: d.id, name: d.data().name as string, servings: d.data().servings, tags: d.data().tags ?? [], ingredients: ((d.data().ingredients ?? []) as Array<{ name: string; quantity: number; unit: string }>).map((i) => `${i.quantity} ${i.unit} ${i.name}`) }));
}

export async function createRecipe(ctx: Ctx, hid: string, a: Actor, r: z.infer<typeof RecipeInput>) {
  await requireCapability(ctx, hid, a.uid, "meals.write");
  const { id } = await createDoc(ctx, hid, "recipes", a, { name: r.name, servings: r.servings, ingredients: r.ingredients.map((i) => ({ ...i, category: i.category ?? "Groceries" })), tags: r.tags, instructions: r.instructions ?? null });
  await audit(ctx, hid, a, "meals.recipe_created", { type: "recipe", id }, { name: r.name });
  return { id };
}

// ---------------- cleaning ----------------

const FREQ_DAYS: Record<string, { days?: number; months?: number }> = { daily: { days: 1 }, weekly: { days: 7 }, monthly: { months: 1 }, seasonal: { months: 3 } };

export async function listCleaning(ctx: Ctx, hid: string, a: Actor) {
  const m = await requireMember(ctx, hid, a.uid);
  let q: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, "cleaningSchedules"));
  if (!can(m, "tasks.read.all")) q = q.where("assigneeUid", "==", a.uid);
  const s = await q.limit(100).get();
  return s.docs.map((d) => { const x = d.data(); return { id: d.id, name: x.title as string, room: x.roomName ?? null, frequency: x.frequency, assigneeUid: x.assigneeUid ?? null, nextDueAt: toIso(x.nextDueAt), lastCompletedAt: toIso(x.lastCompletedAt), deepClean: !!x.deepClean }; });
}

export async function createCleaningRoutine(ctx: Ctx, hid: string, a: Actor, o: { title: string; roomName?: string; frequency: string; assigneeUid?: string; nextDueAt?: string; deepClean: boolean }) {
  await requireCapability(ctx, hid, a.uid, "tasks.write");
  const { id } = await createDoc(ctx, hid, "cleaningSchedules", a, {
    title: o.title, roomName: o.roomName ?? null, frequency: o.frequency, assigneeUid: o.assigneeUid ?? null, deepClean: o.deepClean,
    nextDueAt: o.nextDueAt ? Timestamp.fromDate(new Date(o.nextDueAt)) : null, visibleToChildren: false, lastCompletedAt: null,
  });
  await audit(ctx, hid, a, "cleaning.routine_created", { type: "cleaningSchedule", id }, { title: o.title });
  return { id };
}

export async function markCleaned(ctx: Ctx, hid: string, a: Actor, routine: string) {
  const m = await requireMember(ctx, hid, a.uid);
  const rows = (await listCleaning(ctx, hid, a)).map((r) => ({ id: r.id, name: r.name, frequency: r.frequency as string }));
  const r = pick(rows, routine, "cleaning routine");
  if (!can(m, "tasks.write") && !can(m, "tasks.complete.assigned")) throw forbidden("You can't update cleaning routines");
  const step = FREQ_DAYS[r.frequency] ?? { days: 7 };
  const next = DateTime.fromJSDate(ctx.now()).plus(step).toJSDate();
  await updateDoc(ctx, hid, "cleaningSchedules", r.id, a, { lastCompletedAt: ts(ctx.now()), nextDueAt: Timestamp.fromDate(next) });
  await audit(ctx, hid, a, "cleaning.completed", { type: "cleaningSchedule", id: r.id }, {});
  return { id: r.id, name: r.name, nextDueAt: next.toISOString() };
}

// ---------------- notes ----------------

export async function listNotes(ctx: Ctx, hid: string, a: Actor, limit = 20) {
  const m = await requireMember(ctx, hid, a.uid);
  const col = ctx.db.collection(paths.col(hid, "notes"));
  const [mine, shared] = await Promise.all([
    col.where("createdBy", "==", a.uid).where("visibility", "==", "private").limit(limit).get(),
    m.role === "staff" ? Promise.resolve(null) : col.where("visibility", "==", "household").limit(limit).get(),
  ]);
  return [...mine.docs, ...(shared?.docs ?? [])].map((d) => ({ id: d.id, title: d.data().title as string, visibility: d.data().visibility as string, excerpt: String(d.data().body ?? "").slice(0, 200) })).slice(0, limit);
}

export async function createNote(ctx: Ctx, hid: string, a: Actor, o: { title: string; body: string; visibility: "private" | "household" }) {
  const m = await requireMember(ctx, hid, a.uid);
  if (m.role === "staff") throw forbidden("Staff can't create notes");
  const { id } = await createDoc(ctx, hid, "notes", a, { title: o.title, body: o.body, visibility: o.visibility, category: null, pinned: false });
  await audit(ctx, hid, a, "notes.created", { type: "note", id }, { visibility: o.visibility });
  return { id };
}



// ---------------- savings goals ----------------

export async function listSavingsGoals(ctx: Ctx, hid: string, a: Actor) {
  await requireCapability(ctx, hid, a.uid, "finance.read");
  const s = await ctx.db.collection(paths.col(hid, "savingsGoals")).limit(50).get();
  return s.docs.map((d) => { const x = d.data(); const t = x.targetMinor as number, v = (x.savedMinor ?? 0) as number; return { id: d.id, name: x.name as string, targetMinor: t, savedMinor: v, remainingMinor: Math.max(0, t - v), percent: t > 0 ? Math.min(100, Math.floor((v * 100) / t)) : 0, currency: x.currency as string, targetDate: toIso(x.targetDate) }; });
}

export async function createSavingsGoal(ctx: Ctx, hid: string, a: Actor, o: { name: string; targetMinor: number; savedMinor?: number; targetDate?: string }) {
  await requireCapability(ctx, hid, a.uid, "finance.write");
  const currency = ((await ctx.db.doc(paths.household(hid)).get()).data()?.currency as string) ?? "INR";
  const { id } = await createDoc(ctx, hid, "savingsGoals", a, { name: o.name, targetMinor: o.targetMinor, savedMinor: o.savedMinor ?? 0, currency, targetDate: o.targetDate ? Timestamp.fromDate(new Date(o.targetDate)) : null });
  await audit(ctx, hid, a, "finance.goal_created", { type: "savingsGoal", id }, { targetMinor: o.targetMinor });
  return { id };
}

/** Bookkeeping only: records that money was set aside for a goal. It never moves money. */
export async function addToSavingsGoal(ctx: Ctx, hid: string, a: Actor, goal: string, deltaMinor: number) {
  await requireCapability(ctx, hid, a.uid, "finance.write");
  if (!Number.isSafeInteger(deltaMinor) || deltaMinor === 0) throw invalid("Amount must be a non-zero whole number of minor units");
  const rows = (await listSavingsGoals(ctx, hid, a)).map((g) => ({ id: g.id, name: g.name }));
  const g = pick(rows, goal, "savings goal");
  const ref = ctx.db.doc(`${paths.col(hid, "savingsGoals")}/${g.id}`);
  const saved = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = Math.max(0, ((snap.data()!.savedMinor ?? 0) as number) + deltaMinor);
    tx.update(ref, { savedMinor: next, version: (snap.data()!.version ?? 0) + 1, updatedAt: ts(ctx.now()), updatedBy: a.uid });
    return next;
  });
  await audit(ctx, hid, a, "finance.goal_contribution", { type: "savingsGoal", id: g.id }, { deltaMinor });
  return { id: g.id, name: g.name, savedMinor: saved };
}

// ---------------- assets ----------------

export async function listAssets(ctx: Ctx, hid: string, a: Actor) {
  const m = await requireMember(ctx, hid, a.uid);
  if (m.role === "staff") throw forbidden("Assets are visible to family members");
  const s = await ctx.db.collection(paths.col(hid, "assets")).limit(200).get();
  return s.docs.map((d) => { const x = d.data(); return { id: d.id, name: x.name as string, category: x.category ?? null, brand: x.brand ?? null, location: x.location ?? null, purchaseDate: toIso(x.purchaseDate), warrantyExpiresAt: toIso(x.warrantyExpiresAt), nextServiceAt: toIso(x.nextServiceAt) }; });
}

export async function createAsset(ctx: Ctx, hid: string, a: Actor, o: { name: string; category?: string; brand?: string; model?: string; location?: string; purchaseDate?: string; warrantyExpiresAt?: string; serviceIntervalDays?: number }) {
  await requireCapability(ctx, hid, a.uid, "maintenance.write");
  const d = (x?: string) => (x ? Timestamp.fromDate(new Date(x)) : null);
  const { id } = await createDoc(ctx, hid, "assets", a, { name: o.name, category: o.category ?? "Appliance", brand: o.brand ?? null, model: o.model ?? null, location: o.location ?? null, purchaseDate: d(o.purchaseDate), warrantyExpiresAt: d(o.warrantyExpiresAt), serviceIntervalDays: o.serviceIntervalDays ?? null, nextServiceAt: null });
  await audit(ctx, hid, a, "assets.created", { type: "asset", id }, { name: o.name });
  return { id };
}

// ---------------- task comments ----------------

async function taskAccess(ctx: Ctx, hid: string, a: Actor, taskId: string) {
  const m = await requireMember(ctx, hid, a.uid);
  const t = await ctx.db.doc(`${paths.col(hid, "tasks")}/${taskId}`).get();
  if (!t.exists) throw notFound("Task");
  if (!can(m, "tasks.read.all") && t.data()!.assigneeUid !== a.uid) throw forbidden("You can only see comments on tasks assigned to you");
  return t.data()!;
}

export async function listTaskComments(ctx: Ctx, hid: string, a: Actor, taskId: string) {
  await taskAccess(ctx, hid, a, taskId);
  const s = await ctx.db.collection(`${paths.col(hid, "tasks")}/${taskId}/comments`).orderBy("createdAt", "asc").limit(100).get();
  return s.docs.map((d) => ({ id: d.id, authorUid: d.data().authorUid as string, body: d.data().body as string, createdAt: toIso(d.data().createdAt), byAssistant: d.data().source === "agent" }));
}

export async function addTaskComment(ctx: Ctx, hid: string, a: Actor, taskId: string, body: string) {
  await taskAccess(ctx, hid, a, taskId);
  const text = body.trim().slice(0, 2000);
  if (!text) throw invalid("Comment is empty");
  const ref = await ctx.db.collection(`${paths.col(hid, "tasks")}/${taskId}/comments`).add({ householdId: hid, authorUid: a.uid, body: text, createdAt: ts(ctx.now()), source: a.kind === "agent" ? "agent" : "user" });
  await audit(ctx, hid, a, "tasks.comment_added", { type: "task", id: taskId }, {});
  return { id: ref.id };
}

// ---------------- documents (metadata only; never file contents) ----------------

export async function listDocuments(ctx: Ctx, hid: string, a: Actor, o: { category?: string; expiringWithinDays?: number; limit?: number }) {
  const m = await requireMember(ctx, hid, a.uid);
  await requireCapability(ctx, hid, a.uid, "documents.read");
  const s = await ctx.db.collection(paths.col(hid, "documents")).limit(300).get();
  const horizon = o.expiringWithinDays !== undefined ? ctx.now().getTime() + o.expiringWithinDays * 86400_000 : null;
  const rows = s.docs.filter((d) => { const x = d.data(); return !x.restricted || (x.allowedUids ?? []).includes(a.uid) || ["owner", "admin"].includes(m.role); })
    .map((d) => { const x = d.data(); return { id: d.id, title: x.title as string, category: x.category ?? null, expiresAt: toIso(x.expiresAt), restricted: !!x.restricted }; })
    .filter((r) => (!o.category || lc(r.category) === lc(o.category)) && (horizon === null || (r.expiresAt !== null && new Date(r.expiresAt).getTime() <= horizon)))
    .sort((x, y) => (x.expiresAt ?? "9").localeCompare(y.expiresAt ?? "9"));
  return rows.slice(0, o.limit ?? 30);
}

// ---------------- people and payments: only ever run after a person approves ----------------

export async function findMember(ctx: Ctx, hid: string, ref: string): Promise<{ uid: string; name: string }> {
  const s = await ctx.db.collection(paths.col(hid, "members")).where("status", "==", "active").limit(100).get();
  const rows = s.docs.map((d) => ({ id: d.id, uid: d.id, name: String(d.data().displayName ?? d.data().email ?? d.id) }));
  const hit = pick(rows, ref, "member");
  return { uid: hit.uid, name: hit.name };
}

export { AppError };
