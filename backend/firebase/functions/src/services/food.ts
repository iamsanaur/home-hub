import { DateTime } from "luxon";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { can } from "../core/roles";
import { multiplyQuantity, money } from "../core/money";
import { MealPlanInput, ShoppingItemInput } from "../core/schemas";
import { Actor, audit, Ctx, forbidden, invalid, notFound, paths, requireMember, ts } from "./base";
import { createDoc, toIso, updateDoc } from "./docs";

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Unit normalisation for aggregation: mass → g, volume → ml, count → pcs. */
const UNIT_FACTORS: Record<string, { base: string; factor: number }> = {
  g: { base: "g", factor: 1 }, kg: { base: "g", factor: 1000 },
  mg: { base: "g", factor: 0.001 },
  ml: { base: "ml", factor: 1 }, l: { base: "ml", factor: 1000 }, ltr: { base: "ml", factor: 1000 },
  tsp: { base: "ml", factor: 5 }, tbsp: { base: "ml", factor: 15 }, cup: { base: "ml", factor: 240 },
  pcs: { base: "pcs", factor: 1 }, pc: { base: "pcs", factor: 1 }, piece: { base: "pcs", factor: 1 },
  dozen: { base: "pcs", factor: 12 },
};

export function toBase(quantity: number, unit: string): { quantity: number; unit: string } {
  const f = UNIT_FACTORS[unit.trim().toLowerCase()];
  if (!f) return { quantity, unit: unit.trim().toLowerCase() };
  return { quantity: Math.round(quantity * f.factor * 1000) / 1000, unit: f.base };
}

async function householdCurrency(ctx: Ctx, hid: string): Promise<{ currency: string; timezone: string }> {
  const hh = await ctx.db.doc(paths.household(hid)).get();
  if (!hh.exists) throw notFound("Household");
  return { currency: hh.data()!.currency, timezone: hh.data()!.timezone };
}

// ---------------- shopping ----------------

export async function createShoppingList(ctx: Ctx, hid: string, actor: Actor, name: string, store?: string) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "shopping.write") || m.role === "child") throw forbidden("You cannot create shopping lists");
  const { id } = await createDoc(ctx, hid, "shoppingLists", actor, {
    name: name.trim().slice(0, 80), store: store ?? null, archived: false, itemCount: 0, purchasedCount: 0,
  });
  await audit(ctx, hid, actor, "shopping.list_created", { type: "shoppingList", id }, { name });
  return { id };
}

export async function addShoppingItem(ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof ShoppingItemInput>) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "shopping.write")) throw forbidden("You cannot add shopping items");
  const list = await ctx.db.doc(`${paths.col(hid, "shoppingLists")}/${input.listId}`).get();
  if (!list.exists) throw notFound("Shopping list");
  const key = normalizeName(input.name);
  // Merge with an existing unpurchased line of the same product and unit instead of duplicating.
  const existing = await ctx.db.collection(paths.col(hid, "groceryItems"))
    .where("listId", "==", input.listId).where("purchased", "==", false).get();
  const dup = existing.docs.find((d) => d.data().nameKey === key && d.data().unit === input.unit);
  if (dup) {
    const res = await updateDoc(ctx, hid, "groceryItems", dup.id, actor, {
      quantity: Math.round((dup.data().quantity + input.quantity) * 1000) / 1000,
    });
    return { id: dup.id, merged: true, version: res.version };
  }
  const { id } = await createDoc(ctx, hid, "groceryItems", actor, {
    listId: input.listId,
    name: input.name.trim(),
    nameKey: key,
    quantity: input.quantity,
    unit: input.unit,
    category: input.category,
    preferredBrand: input.preferredBrand ?? null,
    preferredStore: input.preferredStore ?? null,
    estimatedPriceMinor: input.estimatedPriceMinor ?? null,
    actualPriceMinor: null,
    purchased: false,
    purchasedAt: null,
    purchasedBy: null,
  });
  await ctx.db.doc(`${paths.col(hid, "shoppingLists")}/${input.listId}`).update({ itemCount: FieldValue.increment(1) });
  return { id, merged: false };
}

export async function markItemPurchased(
  ctx: Ctx, hid: string, actor: Actor, itemId: string, actualPriceMinor?: number,
) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "shopping.write")) throw forbidden("You cannot update shopping items");
  if (actualPriceMinor !== undefined && (!Number.isSafeInteger(actualPriceMinor) || actualPriceMinor < 0)) {
    throw invalid("actualPriceMinor must be a non-negative integer");
  }
  const res = await updateDoc(ctx, hid, "groceryItems", itemId, actor, {
    purchased: true, purchasedAt: ts(ctx.now()), purchasedBy: actor.uid, actualPriceMinor: actualPriceMinor ?? null,
  }, undefined, (cur) => { if (cur.purchased) throw invalid("Item is already marked purchased"); });
  await ctx.db.doc(`${paths.col(hid, "shoppingLists")}/${res.data.listId}`).update({ purchasedCount: FieldValue.increment(1) });
  // Restock the matching pantry item (same name, convertible unit) through the movement ledger.
  const pantry = await ctx.db.collection(paths.col(hid, "pantryItems")).where("nameKey", "==", res.data.nameKey).limit(1).get();
  if (!pantry.empty) {
    const p = pantry.docs[0];
    const add = toBase(res.data.quantity, res.data.unit);
    const have = toBase(1, p.data().unit);
    if (add.unit === have.unit) {
      const delta = Math.round((add.quantity / have.quantity) * 1000) / 1000;
      await adjustPantry(ctx, hid, actor, p.id, delta, "restock", `Purchased via shopping list`);
    }
  }
  return { id: itemId, version: res.version };
}

// ---------------- pantry ----------------

export async function adjustPantry(
  ctx: Ctx, hid: string, actor: Actor, itemId: string, delta: number,
  kind: "restock" | "consume" | "waste" | "adjust", note?: string,
) {
  const ref = ctx.db.doc(`${paths.col(hid, "pantryItems")}/${itemId}`);
  const movementRef = ctx.db.collection(paths.col(hid, "pantryMovements")).doc();
  await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Pantry item");
    const d = snap.data()!;
    const quantity = Math.max(0, Math.round((d.quantity + delta) * 1000) / 1000);
    tx.update(ref, {
      quantity,
      lowStock: d.minQuantity != null && quantity <= d.minQuantity,
      version: (d.version ?? 0) + 1,
      updatedAt: ts(ctx.now()),
      updatedBy: actor.uid,
    });
    tx.set(movementRef, {
      householdId: hid, itemId, name: d.name, kind, delta, unit: d.unit, note: note ?? null,
      createdBy: actor.uid, createdAt: ts(ctx.now()),
    });
  });
}

export async function getInventory(ctx: Ctx, hid: string, actor: Actor, opts: { location?: string; limit?: number } = {}) {
  await requireMember(ctx, hid, actor.uid);
  let q: FirebaseFirestore.Query = ctx.db.collection(paths.col(hid, "pantryItems"));
  if (opts.location) q = q.where("location", "==", opts.location);
  const snap = await q.limit(Math.min(opts.limit ?? 50, 200)).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, name: x.name, quantity: x.quantity, unit: x.unit, minQuantity: x.minQuantity ?? null,
      lowStock: !!x.lowStock, location: x.location ?? null, expiresAt: toIso(x.expiresAt),
    };
  });
}

export async function getLowStockItems(ctx: Ctx, hid: string, actor: Actor) {
  await requireMember(ctx, hid, actor.uid);
  const now = ctx.now();
  const soon = new Date(now.getTime() + 3 * 86400_000);
  const [low, expiring] = await Promise.all([
    ctx.db.collection(paths.col(hid, "pantryItems")).where("lowStock", "==", true).limit(100).get(),
    ctx.db.collection(paths.col(hid, "pantryItems")).where("expiresAt", "<=", Timestamp.fromDate(soon)).limit(100).get(),
  ]);
  return {
    lowStock: low.docs.map((d) => ({ id: d.id, name: d.data().name, quantity: d.data().quantity, unit: d.data().unit, minQuantity: d.data().minQuantity ?? null })),
    expiringSoon: expiring.docs.map((d) => ({ id: d.id, name: d.data().name, expiresAt: toIso(d.data().expiresAt) })),
  };
}

// ---------------- meals ----------------

export async function getMealPlan(ctx: Ctx, hid: string, actor: Actor, weekStart: string) {
  await requireMember(ctx, hid, actor.uid);
  const snap = await ctx.db.doc(`${paths.col(hid, "mealPlans")}/${weekStart}`).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  return { id: snap.id, weekStart: d.weekStart, entries: d.entries, version: d.version };
}

/** Meal plans are keyed by ISO week start date so creating twice replaces, never duplicates. */
export async function createMealPlan(ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof MealPlanInput>) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "meals.write")) throw forbidden("You cannot plan meals");
  const start = DateTime.fromISO(input.weekStart);
  if (!start.isValid) throw invalid("Invalid weekStart");
  for (const e of input.entries) {
    const d = DateTime.fromISO(e.date);
    const diff = d.diff(start, "days").days;
    if (diff < 0 || diff > 6) throw invalid(`Entry ${e.date} is outside the week of ${input.weekStart}`);
  }
  const ref = ctx.db.doc(`${paths.col(hid, "mealPlans")}/${input.weekStart}`);
  const existing = await ref.get();
  if (existing.exists) {
    const res = await updateDoc(ctx, hid, "mealPlans", input.weekStart, actor, { entries: input.entries });
    await audit(ctx, hid, actor, "meals.plan_updated", { type: "mealPlan", id: input.weekStart });
    return { id: input.weekStart, version: res.version, replaced: true };
  }
  await createDoc(ctx, hid, "mealPlans", actor, { weekStart: input.weekStart, entries: input.entries }, input.weekStart);
  await audit(ctx, hid, actor, "meals.plan_created", { type: "mealPlan", id: input.weekStart });
  return { id: input.weekStart, version: 1, replaced: false };
}

interface Need { name: string; nameKey: string; quantity: number; unit: string; category: string; unitPriceMinor: number | null; priceUnitQty: number }

/**
 * Deterministically turns a meal plan into a shopping list:
 *  1. scale each recipe's ingredients by planned servings / recipe servings;
 *  2. aggregate by product + base unit;
 *  3. subtract what the pantry already holds;
 *  4. estimate cost only from known prices (recipe ingredient price or the last
 *     purchase price); unpriced items are counted, never guessed.
 */
export async function generateMealShoppingList(
  ctx: Ctx, hid: string, actor: Actor, weekStart: string, listId?: string,
) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "shopping.write") || m.role === "child") throw forbidden("You cannot generate shopping lists");
  const { currency } = await householdCurrency(ctx, hid);
  const plan = await ctx.db.doc(`${paths.col(hid, "mealPlans")}/${weekStart}`).get();
  if (!plan.exists) throw notFound("Meal plan");
  const entries = plan.data()!.entries as Array<{ recipeId?: string; servings: number }>;
  const recipeIds = [...new Set(entries.map((e) => e.recipeId).filter(Boolean))] as string[];
  const recipes = new Map<string, FirebaseFirestore.DocumentData>();
  for (let i = 0; i < recipeIds.length; i += 30) {
    const chunk = recipeIds.slice(i, i + 30);
    const refs = chunk.map((id) => ctx.db.doc(`${paths.col(hid, "recipes")}/${id}`));
    const snaps = await ctx.db.getAll(...refs);
    snaps.forEach((s) => s.exists && recipes.set(s.id, s.data()!));
  }

  const needs = new Map<string, Need>();
  for (const e of entries) {
    if (!e.recipeId) continue;
    const r = recipes.get(e.recipeId);
    if (!r) continue;
    const scale = e.servings / (r.servings || 1);
    for (const ing of (r.ingredients ?? []) as Array<{ name: string; quantity: number; unit: string; category?: string; estimatedPriceMinor?: number; priceUnitQuantity?: number }>) {
      const base = toBase(ing.quantity * scale, ing.unit);
      const key = `${normalizeName(ing.name)}|${base.unit}`;
      const cur = needs.get(key);
      const priceUnit = ing.estimatedPriceMinor != null ? toBase(ing.priceUnitQuantity ?? 1, ing.unit).quantity : 1;
      if (cur) cur.quantity = Math.round((cur.quantity + base.quantity) * 1000) / 1000;
      else needs.set(key, {
        name: ing.name.trim(), nameKey: normalizeName(ing.name), quantity: base.quantity, unit: base.unit,
        category: ing.category ?? "Groceries", unitPriceMinor: ing.estimatedPriceMinor ?? null, priceUnitQty: priceUnit,
      });
    }
  }

  // Subtract pantry stock.
  const pantry = await ctx.db.collection(paths.col(hid, "pantryItems")).get();
  const stock = new Map<string, number>();
  pantry.docs.forEach((d) => {
    const b = toBase(d.data().quantity, d.data().unit);
    stock.set(`${d.data().nameKey ?? normalizeName(d.data().name)}|${b.unit}`, b.quantity);
  });

  // Last known purchase prices (price book) for items without recipe prices.
  const history = await ctx.db.collection(paths.col(hid, "groceryItems")).where("purchased", "==", true).limit(300).get();
  const lastPrice = new Map<string, { minor: number; qty: number }>();
  history.docs.forEach((d) => {
    const x = d.data();
    if (x.actualPriceMinor != null && x.quantity > 0) {
      const b = toBase(x.quantity, x.unit);
      lastPrice.set(`${x.nameKey}|${b.unit}`, { minor: x.actualPriceMinor, qty: b.quantity });
    }
  });

  let targetList = listId;
  if (!targetList) {
    targetList = (await createShoppingList(ctx, hid, actor, `Meals · week of ${weekStart}`)).id;
  }
  const items: Array<{ id: string; name: string; quantity: number; unit: string; estimatedPriceMinor: number | null }> = [];
  let totalMinor = 0;
  let unpriced = 0;
  let coveredByPantry = 0;
  for (const [key, need] of needs) {
    const have = stock.get(key) ?? 0;
    const qty = Math.round((need.quantity - have) * 1000) / 1000;
    if (qty <= 0) { coveredByPantry++; continue; }
    let est: number | null = null;
    if (need.unitPriceMinor != null) {
      est = multiplyQuantity(money(need.unitPriceMinor, currency), qty / need.priceUnitQty).amountMinor;
    } else if (lastPrice.has(key)) {
      const lp = lastPrice.get(key)!;
      est = multiplyQuantity(money(lp.minor, currency), qty / lp.qty).amountMinor;
    }
    if (est == null) unpriced++; else totalMinor += est;
    const added = await addShoppingItem(ctx, hid, actor, {
      listId: targetList, name: need.name, quantity: qty, unit: need.unit, category: need.category,
      estimatedPriceMinor: est ?? undefined,
    });
    items.push({ id: added.id, name: need.name, quantity: qty, unit: need.unit, estimatedPriceMinor: est });
  }
  await audit(ctx, hid, actor, "meals.shopping_list_generated", { type: "shoppingList", id: targetList }, { weekStart, items: items.length });
  return {
    listId: targetList, items, coveredByPantry,
    estimate: { totalMinor, currency, unpricedItems: unpriced, basis: "recipe prices and last purchase prices only" },
  };
}

export const PantryBulkItem = z.object({
  name: z.string().trim().min(1).max(60),
  quantity: z.number().positive().max(100_000),
  unit: z.string().trim().min(1).max(20).default("pcs"),
  location: z.string().trim().max(60).optional(),
  minQuantity: z.number().min(0).max(100_000).optional(),
});

/**
 * Adds many pantry items at once. An item already in the pantry (same name and unit) has the quantity added and a
 * "restock" movement recorded, instead of creating a duplicate. Same item twice in one request is combined.
 */
export async function addPantryItems(ctx: Ctx, hid: string, actor: Actor, rawItems: Array<z.infer<typeof PantryBulkItem>>) {
  const m = await requireMember(ctx, hid, actor.uid);
  if (!can(m, "pantry.write")) throw forbidden("You cannot change the pantry");
  if (rawItems.length === 0 || rawItems.length > 100) throw invalid("Send between 1 and 100 items");
  const wanted = new Map<string, z.infer<typeof PantryBulkItem>>();
  for (const i of rawItems) {
    const k = `${normalizeName(i.name)}|${i.unit.toLowerCase()}`;
    const prev = wanted.get(k);
    wanted.set(k, prev ? { ...prev, quantity: Math.round((prev.quantity + i.quantity) * 1000) / 1000 } : { ...i, unit: i.unit.toLowerCase() });
  }
  const existing = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  (await ctx.db.collection(paths.col(hid, "pantryItems")).limit(1000).get()).docs.forEach((d) => existing.set(`${d.data().nameKey ?? normalizeName(String(d.data().name))}|${String(d.data().unit).toLowerCase()}`, d));
  const results: Array<{ name: string; quantity: number; unit: string; action: "created" | "added_to_existing"; nowQuantity: number }> = [];
  for (const [k, i] of wanted) {
    const hit = existing.get(k);
    if (hit) {
      const next = Math.round((Number(hit.data().quantity) + i.quantity) * 1000) / 1000;
      const min = hit.data().minQuantity ?? null;
      await updateDoc(ctx, hid, "pantryItems", hit.id, actor, { quantity: next, lowStock: min !== null && next <= min });
      await ctx.db.collection(paths.col(hid, "pantryMovements")).add({
        householdId: hid, createdBy: actor.uid, itemId: hit.id, name: hit.data().name, kind: "restock", delta: i.quantity, unit: i.unit, createdAt: ts(ctx.now()),
      });
      results.push({ name: String(hit.data().name), quantity: i.quantity, unit: i.unit, action: "added_to_existing", nowQuantity: next });
    } else {
      await createDoc(ctx, hid, "pantryItems", actor, {
        name: i.name, nameKey: normalizeName(i.name), quantity: i.quantity, unit: i.unit, minQuantity: i.minQuantity ?? null,
        lowStock: i.minQuantity !== undefined && i.quantity <= i.minQuantity, location: i.location ?? "Pantry shelf", expiresAt: null,
      });
      results.push({ name: i.name, quantity: i.quantity, unit: i.unit, action: "created", nowQuantity: i.quantity });
    }
  }
  await audit(ctx, hid, actor, "pantry.bulk_added", { type: "pantry" }, { items: results.length });
  return { created: results.filter((r) => r.action === "created").length, updated: results.filter((r) => r.action === "added_to_existing").length, items: results };
}
