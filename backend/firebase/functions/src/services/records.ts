/**
 * Deleting household records (used by the approval action `delete_record`, so the assistant can propose a
 * deletion and a person confirms it). Mirrors the security rules: owners/administrators for finance and assets,
 * adults for everyday records. Reconciled (locked) transactions can never be deleted.
 */
import { Actor, audit, Ctx, forbidden, getMembership, invalid, notFound, paths } from "./base";

const MANAGER_ONLY = new Set(["bills", "transactions", "assets", "maintenanceRecords", "inventoryItems", "budgets", "savingsGoals"]);
const ADULT_OK = new Set(["tasks", "shoppingLists", "groceryItems", "pantryItems", "recipes", "mealPlans", "events"]);
export const DELETABLE = [...MANAGER_ONLY, ...ADULT_OK] as const;

export async function deleteRecord(ctx: Ctx, hid: string, actor: Actor, collection: string, id: string): Promise<Record<string, unknown>> {
  if (!MANAGER_ONLY.has(collection) && !ADULT_OK.has(collection)) throw invalid(`Can't delete from "${collection}". Allowed: ${DELETABLE.join(", ")}`);
  const m = await getMembership(ctx, hid, actor.uid);
  if (!m || m.status !== "active") throw forbidden("Not a member of this household");
  const manager = ["owner", "admin"].includes(m.role);
  if (MANAGER_ONLY.has(collection) ? !manager : !(manager || m.role === "adult")) throw forbidden(MANAGER_ONLY.has(collection) ? "Only owners and administrators can delete this" : "Only adults can delete this");
  const ref = ctx.db.doc(`${paths.col(hid, collection)}/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Record");
  const data = snap.data()!;
  if (collection === "transactions" && data.locked === true) throw invalid("This transaction is locked (reconciled) and can't be deleted");
  let alsoRemoved = 0;
  const removeAll = async (q: FirebaseFirestore.Query) => {
    for (;;) {
      const s = await q.limit(400).get();
      if (s.empty) break;
      const b = ctx.db.batch(); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); alsoRemoved += s.size;
    }
  };
  if (collection === "shoppingLists") await removeAll(ctx.db.collection(paths.col(hid, "groceryItems")).where("listId", "==", id));
  if (collection === "bills") await removeAll(ctx.db.collection(paths.col(hid, "billLedgers")).where("billId", "==", id)); // payment history is kept
  await ref.delete();
  await audit(ctx, hid, actor, "records.deleted", { type: collection, id }, { name: data.name ?? data.title ?? null, alsoRemoved });
  return { collection, id, deleted: true, alsoRemoved };
}
