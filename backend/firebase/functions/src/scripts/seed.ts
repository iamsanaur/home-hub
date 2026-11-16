/**
 * Local development seed — SAMPLE DATA ONLY, for the Firebase Emulator Suite.
 * Refuses to run unless FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST are set.
 *
 *   firebase emulators:start   (in backend/firebase)
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm run seed
 *
 * Demo sign-ins (password: homehub-demo-1):
 *   owner@homehub.test (owner) · adult@homehub.test (adult) · staff@homehub.test (staff) · child@homehub.test (child)
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { DateTime } from "luxon";
import { acceptInvitation, createHousehold, invite } from "../services/households";
import { Ctx } from "../services/base";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error("Refusing to seed: emulator environment variables are not set.");
  process.exit(1);
}

async function main() {
  initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "demo-homehub" });
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  const ctx: Ctx = { db, now: () => new Date() };
  const auth = getAuth();

  const people = [
    { email: "owner@homehub.test", name: "Priya Sharma", role: "owner" },
    { email: "adult@homehub.test", name: "Arjun Sharma", role: "adult" },
    { email: "staff@homehub.test", name: "Lakshmi", role: "staff" },
    { email: "child@homehub.test", name: "Anaya", role: "child" },
  ] as const;
  const uids: Record<string, string> = {};
  for (const p of people) {
    const existing = await auth.getUserByEmail(p.email).catch(() => null);
    const u = existing ?? (await auth.createUser({ email: p.email, password: "homehub-demo-1", displayName: p.name, emailVerified: true }));
    uids[p.role] = u.uid;
    await db.doc(`users/${u.uid}`).set({ displayName: p.name, email: p.email, onboarding: { completed: true } }, { merge: true });
  }

  const owner = { uid: uids.owner, kind: "user" as const };
  const { householdId: hid } = await createHousehold(ctx, { uid: uids.owner, displayName: "Priya Sharma", email: "owner@homehub.test" },
    { name: "Sharma Home", currency: "INR", timezone: "Asia/Kolkata", locale: "en-IN", country: "IN" });
  for (const p of people.filter((x) => x.role !== "owner")) {
    const inv = await invite(ctx, owner, hid, { role: p.role, email: p.email });
    await acceptInvitation(ctx, { uid: uids[p.role], email: p.email, emailVerified: true, displayName: p.name }, inv.token);
  }

  const tz = "Asia/Kolkata";
  const now = DateTime.now().setZone(tz);
  const T = (d: DateTime) => Timestamp.fromDate(d.toJSDate());
  const meta = (by = uids.owner) => ({ householdId: hid, createdBy: by, createdAt: T(now), updatedBy: by, updatedAt: T(now), version: 1, source: "seed" });
  const batch = db.batch();
  const col = (c: string, id?: string) => (id ? db.doc(`households/${hid}/${c}/${id}`) : db.collection(`households/${hid}/${c}`).doc());

  const tasks: Array<[string, string, DateTime | null, string | null, string, Record<string, unknown>?]> = [
    ["Pay school fees for Anaya", "high", now.plus({ days: 2 }).set({ hour: 10, minute: 0 }), uids.owner, "Family"],
    ["Mop living room and hallway", "normal", now.set({ hour: 11, minute: 0 }), uids.staff, "Cleaning", { recurrence: { freq: "daily" } }],
    ["Renew car insurance", "urgent", now.minus({ days: 1 }).set({ hour: 18, minute: 0 }), uids.adult, "Finance"],
    ["Water balcony plants", "low", now.set({ hour: 8, minute: 0 }), uids.child, "Home", { recurrence: { freq: "daily" } }],
    ["Descale the kettle", "normal", now.plus({ days: 5 }), null, "Kitchen"],
    ["Book dentist check-up", "normal", now.plus({ days: 9 }), uids.adult, "Health"],
  ];
  for (const [title, priority, due, assignee, category, extra] of tasks) {
    batch.set(col("tasks"), { ...meta(), title, priority, status: "open", dueAt: due ? T(due) : null, assigneeUid: assignee, category, notes: null, checklist: [], recurrence: null, seriesStartAt: due && extra?.recurrence ? T(due) : null, ...extra });
  }

  const rooms = ["Kitchen", "Living room", "Bedrooms", "Bathrooms", "Balcony"];
  rooms.forEach((name, i) => batch.set(col("cleaningRooms", `room${i}`), { ...meta(), name, order: i }));
  batch.set(col("cleaningSchedules"), { ...meta(), roomId: "room0", title: "Wipe counters & stove", frequency: "daily", assigneeUid: uids.staff, nextDueAt: T(now.plus({ hours: 4 })), visibleToChildren: false });
  batch.set(col("cleaningSchedules"), { ...meta(), roomId: "room3", title: "Deep clean bathrooms", frequency: "weekly", assigneeUid: uids.staff, nextDueAt: T(now.plus({ days: 2 })), visibleToChildren: false });
  batch.set(col("cleaningSchedules"), { ...meta(), roomId: "room2", title: "Turn mattresses", frequency: "seasonal", assigneeUid: null, nextDueAt: T(now.plus({ days: 40 })), visibleToChildren: false });

  const listId = "weekly";
  batch.set(col("shoppingLists", listId), { ...meta(), name: "Weekly groceries", store: "Local market", archived: false, itemCount: 5, purchasedCount: 1 });
  const groceries: Array<[string, number, string, string, number | null, boolean]> = [
    ["Toor dal", 1, "kg", "Staples", 16000, false], ["Tomatoes", 1, "kg", "Vegetables", 4000, false],
    ["Milk", 4, "l", "Dairy", 27200, false], ["Basmati rice", 5, "kg", "Staples", 62500, true], ["Coriander", 2, "bunch", "Vegetables", null, false],
  ];
  for (const [name, quantity, unit, category, price, purchased] of groceries) {
    batch.set(col("groceryItems"), { ...meta(), listId, name, nameKey: name.toLowerCase(), quantity, unit, category, estimatedPriceMinor: price, actualPriceMinor: purchased ? price : null, purchased, purchasedAt: purchased ? T(now.minus({ days: 1 })) : null, purchasedBy: purchased ? uids.staff : null, preferredBrand: null, preferredStore: null });
  }
  const pantry: Array<[string, number, string, number, string, DateTime | null]> = [
    ["Basmati rice", 6, "kg", 2, "Pantry shelf", null], ["Toor dal", 0.3, "kg", 1, "Pantry shelf", null],
    ["Milk", 1, "l", 2, "Fridge", now.plus({ days: 2 })], ["Paneer", 200, "g", 200, "Fridge", now.plus({ days: 1 })],
    ["Onion", 3, "kg", 1, "Basket", null], ["Atta", 4, "kg", 2, "Pantry shelf", null],
  ];
  for (const [name, quantity, unit, min, location, exp] of pantry) {
    batch.set(col("pantryItems"), { ...meta(), name, nameKey: name.toLowerCase(), quantity, unit, minQuantity: min, lowStock: quantity <= min, location, expiresAt: exp ? T(exp) : null });
  }

  batch.set(col("recipes", "dal-tadka"), { ...meta(), name: "Dal tadka", servings: 4, tags: ["vegetarian"], ingredients: [
    { name: "Toor dal", quantity: 250, unit: "g", category: "Staples", estimatedPriceMinor: 4000, priceUnitQuantity: 250 },
    { name: "Tomatoes", quantity: 2, unit: "pcs", category: "Vegetables" }, { name: "Onion", quantity: 1, unit: "pcs", category: "Vegetables" },
    { name: "Ghee", quantity: 2, unit: "tbsp", category: "Dairy" }] });
  batch.set(col("recipes", "veg-pulao"), { ...meta(), name: "Vegetable pulao", servings: 4, tags: ["vegetarian"], ingredients: [
    { name: "Basmati rice", quantity: 300, unit: "g", category: "Staples", estimatedPriceMinor: 12500, priceUnitQuantity: 1000 },
    { name: "Peas", quantity: 150, unit: "g", category: "Vegetables" }, { name: "Carrot", quantity: 2, unit: "pcs", category: "Vegetables" }] });
  const weekStart = now.startOf("week");
  batch.set(col("mealPlans", weekStart.toISODate()!), { ...meta(), weekStart: weekStart.toISODate(), entries: [
    { date: weekStart.toISODate(), slot: "dinner", recipeId: "dal-tadka", title: "Dal tadka", servings: 4 },
    { date: weekStart.plus({ days: 2 }).toISODate(), slot: "dinner", recipeId: "veg-pulao", title: "Vegetable pulao", servings: 4 },
    { date: weekStart.plus({ days: 1 }).toISODate(), slot: "breakfast", title: "Poha", servings: 4 }] });
  batch.set(col("preferences", "dietary"), { vegetarianDays: ["Tuesday"], allergies: [], notes: "User-entered: no peanuts for Anaya's lunchbox (school rule)." });

  const period = now.toFormat("yyyy-MM");
  batch.set(col("budgets", `${period}-all`), { ...meta(), period, category: "*", limitMinor: 8500000, currency: "INR" });
  batch.set(col("budgets", `${period}-groceries`), { ...meta(), period, category: "Groceries", limitMinor: 1800000, currency: "INR" });
  batch.set(col("budgets", `${period}-utilities`), { ...meta(), period, category: "Utilities", limitMinor: 900000, currency: "INR" });
  const txs: Array<[string, number, string, string, number]> = [
    ["income", 15000000, "Salary", "bank_transfer", 1], ["expense", 1245000, "Groceries", "upi", 3], ["expense", 245000, "Utilities", "upi", 5],
    ["expense", 450000, "Transport", "card", 6], ["expense", 2500000, "Rent", "bank_transfer", 1], ["expense", 189900, "Dining", "card", 8],
  ];
  for (const [type, amountMinor, category, paymentMethod, day] of txs) {
    const d = now.startOf("month").plus({ days: day - 1, hours: 12 });
    if (d > now) continue;
    batch.set(col("transactions"), { ...meta(), type, amountMinor, currency: "INR", category, paymentMethod, occurredAt: T(d), description: null, locked: false, receiptPath: null });
  }
  batch.set(col("savingsGoals"), { ...meta(), name: "Goa trip", targetMinor: 6000000, savedMinor: 1850000, currency: "INR", targetDate: T(now.plus({ months: 5 })) });
  const bills: Array<[string, string, number, DateTime, Record<string, unknown> | null]> = [
    ["Electricity", "Utilities", 245000, now.plus({ days: 3 }).set({ hour: 10 }), { freq: "monthly" }],
    ["Broadband", "Utilities", 99900, now.plus({ days: 10 }).set({ hour: 10 }), { freq: "monthly" }],
    ["Society maintenance", "Housing", 350000, now.minus({ days: 1 }).set({ hour: 10 }), { freq: "monthly" }],
    ["Health insurance", "Insurance", 2850000, now.plus({ days: 45 }), { freq: "yearly" }],
  ];
  for (const [name, category, amountMinor, due, recurrence] of bills) {
    batch.set(col("bills"), { ...meta(), name, category, provider: null, amountMinor, currency: "INR", nextDueAt: T(due), seriesStartAt: T(due), recurrence, reminderDaysBefore: 3, active: true, status: "upcoming" });
  }

  batch.set(col("assets", "ac-bedroom"), { ...meta(), name: "Bedroom AC", category: "Appliance", location: "Master bedroom", purchaseDate: T(now.minus({ years: 2 })), warrantyExpiresAt: T(now.plus({ months: 4 })), nextServiceAt: T(now.plus({ days: 6 })) });
  batch.set(col("assets", "water-purifier"), { ...meta(), name: "Water purifier", category: "Appliance", location: "Kitchen", purchaseDate: T(now.minus({ years: 1 })), warrantyExpiresAt: T(now.minus({ days: 10 })), nextServiceAt: T(now.plus({ days: 20 })) });
  batch.set(col("maintenanceRecords"), { ...meta(), title: "AC not cooling well", assetId: "ac-bedroom", assetName: "Bedroom AC", status: "requested", priority: "high", nextDueAt: T(now.plus({ days: 2 })), providerName: null, costMinor: null, assigneeUid: null, underWarranty: true });
  batch.set(col("maintenanceRecords"), { ...meta(), title: "Purifier filter change", assetId: "water-purifier", assetName: "Water purifier", status: "done", priority: "normal", nextDueAt: null, providerName: "AquaCare", costMinor: 180000, assigneeUid: null });
  batch.set(col("inventoryItems"), { ...meta(), name: "Sofa set", category: "Furniture", location: "Living room", quantity: 1, purchaseDate: T(now.minus({ years: 3 })) });
  batch.set(col("inventoryItems"), { ...meta(), name: "Pressure cooker (5 L)", category: "Kitchen", location: "Kitchen", quantity: 2, purchaseDate: T(now.minus({ years: 1 })) });

  const events: Array<[string, DateTime, number, string, string[], boolean]> = [
    ["Parent–teacher meeting", now.plus({ days: 1 }).set({ hour: 9, minute: 30 }), 60, "school", [uids.owner], false],
    ["Arjun's birthday", now.plus({ days: 12 }).startOf("day").plus({ hours: 19 }), 180, "birthday", [], true],
    ["Dentist — Anaya", now.plus({ days: 3 }).set({ hour: 17, minute: 0 }), 45, "appointment", [uids.adult, uids.child], false],
  ];
  for (const [title, start, mins, category, attendees, staffVisible] of events) {
    batch.set(col("events"), { ...meta(), title, startAt: T(start), endAt: T(start.plus({ minutes: mins })), category, attendeeUids: attendees, visibility: "household", staffVisible, location: null, reminderMinutes: 60 });
  }
  batch.set(col("documents"), { ...meta(), title: "Rental agreement 2026", category: "Property", restricted: false, allowedUids: [], storagePath: `households/${hid}/documents/rental/agreement.pdf`, expiresAt: T(now.plus({ months: 7 })), fileType: "pdf" });
  batch.set(col("documents"), { ...meta(), title: "Health insurance policy", category: "Insurance", restricted: true, allowedUids: [uids.adult], storagePath: `households/${hid}/documents/insurance/policy.pdf`, expiresAt: T(now.plus({ days: 45 })), fileType: "pdf" });
  batch.set(col("notes"), { ...meta(), title: "Wi-Fi for guests", body: "Network: SharmaHome-Guest", visibility: "household", category: "Home" });
  batch.set(col("notes"), { ...meta(uids.adult), createdBy: uids.adult, title: "Gift ideas for Priya", body: "Pottery class voucher", visibility: "private", category: "Personal" });
  await batch.commit();

  console.log(`Seeded household ${hid}. Sign in as owner@homehub.test / homehub-demo-1`);
}

main().catch((e) => { console.error(e); process.exit(1); });
