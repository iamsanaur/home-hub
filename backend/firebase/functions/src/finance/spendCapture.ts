/**
 * Automatic spending capture (Android payment notifications, iOS Shortcuts SMS automation).
 *
 * Phones send the text of a bank / UPI message; this module parses it deterministically (no model
 * calls, integer paise only), removes duplicates, suggests a category from household-learned and
 * default merchant rules, and files it in a "To review" inbox. Nothing is booked until a finance-
 * permitted adult confirms it — financial records are never written silently.
 *
 * Privacy: the raw message text is never stored. Only parsed fields are kept, account and card
 * numbers are reduced to their last four digits, and the UPI reference is stored only as a hash
 * (in the document id) plus its last four digits for display.
 */
import type { Express, NextFunction, Request, Response } from "express";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { Actor, AppError, Ctx, audit, invalid, notFound, paths, requireCapability, sha256, ts } from "../services/base";
import { recordExpense } from "../services/finance";

export type Direction = "debit" | "credit";
export type PayMethod = "upi" | "card" | "bank_transfer" | "wallet" | "other";

export interface ParsedSpend {
  amountMinor: number;
  currency: "INR";
  direction: Direction;
  merchant: string | null;
  upiRef: string | null;
  accountLast4: string | null;
  method: PayMethod;
}

// ---------------------------------------------------------------- parsing

const AMOUNT = /(?:₹|\bRs\.?|\bINR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
// Messages that mention money but aren't a completed payment.
const IGNORE = [
  /\bOTP\b/i, /one[- ]time password/i, /\bverification code\b/i,
  /\b(failed|declined|unsuccessful|not processed)\b/i,
  /\bwill be (debited|deducted|charged)\b/i, /\b(is|are) due\b/i, /\bdue (on|by|date)\b/i, /\bmin(imum)? (amt|amount) due\b/i,
  /\brequest(ed)? (money|payment)\b/i, /\bhas requested\b/i, /\bcollect request\b/i,
  /\bmandate\b.*\b(created|registered|set up)\b/i, /\bautopay\b.*\b(set up|registered|created)\b/i,
];
const DEBIT = /\b(debited|spent|paid|sent|withdrawn|purchase|txn of|transaction of|dr\.?)\b/i;
const CREDIT = /\b(credited|received|refund(ed)?|cashback|cr\.?|deposited)\b/i;

/** "1,234.5" → 123450 paise, without floating point. */
export function toMinor(amount: string): number {
  const [whole, frac = ""] = amount.replace(/,/g, "").split(".");
  const paise = (frac + "00").slice(0, 2);
  const v = Number(whole) * 100 + Number(paise);
  if (!Number.isSafeInteger(v)) throw invalid("Amount out of range");
  return v;
}

function cleanMerchant(raw: string | undefined): string | null {
  if (!raw) return null;
  let m = raw.trim();
  m = m.replace(/@[a-z0-9.-]+$/i, ""); // VPA → name part
  m = m.replace(/[._-]+/g, " ").replace(/\s{2,}/g, " ").trim();
  m = m.replace(/\b(on|via|ref|upi|txn|dated?|for)\b.*$/i, "").trim();
  m = m.replace(/[^A-Za-z0-9 &'.]/g, "").trim();
  if (!m || /^\d+$/.test(m) || m.length < 2) return null;
  // Title case ("AMAZON PAY INDIA" → "Amazon Pay India"), capped at 60 chars.
  return m.slice(0, 60).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse one bank/UPI message. Returns null when it isn't a completed debit or credit. */
export function parseBankMessage(text: string): ParsedSpend | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.length > 1000) return null;
  if (IGNORE.some((re) => re.test(t))) return null;
  const amt = AMOUNT.exec(t);
  if (!amt) return null;
  // Balance-only alerts ("Avl Bal Rs 5,000") have no debit/credit verb.
  const isDebit = DEBIT.test(t), isCredit = CREDIT.test(t);
  if (!isDebit && !isCredit) return null;
  // "debited … credited to X" is still a debit for this account; a pure credit says only credited/received.
  const direction: Direction = isDebit && (!isCredit || /\bdebited\b|\bspent\b|\bpaid\b|\bsent\b/i.test(t.split(/credited|received/i)[0] ?? "")) ? "debit" : "credit";
  const amountMinor = toMinor(amt[1]);
  if (amountMinor <= 0) return null;

  const upiRef = (/\b(?:UPI\s*Ref(?:erence)?(?:\s*No)?|Ref(?:erence)?\s*(?:No|#)?|UTR(?:\s*No)?|RRN)\.?\s*[:#-]?\s*([0-9]{10,16})/i.exec(t)?.[1]) ?? null;
  const accountLast4 = (/\b(?:a\/c|acct?|account|card)(?:\s*(?:no\.?|number|ending(?:\s*(?:in|with))?))?\s*[:-]?\s*(?:[xX*]+\s*)?([0-9]{3,4})\b/i.exec(t)?.[1]) ?? null;

  const merchant = cleanMerchant(
    // "paid to X", "Paid ₹299 to X", "Sent Rs.120 From … To X"
    /\b(?:paid|sent|transferred|debited)\b.{0,80}?\bto\s+(?:VPA\s+)?(?!your\b|a\/c\b)([A-Za-z0-9@ ._&'-]{2,60}?)(?=\s+(?:on|via|from|ref|upi|using|txn)\b|\s*\(|[,;]|\.(?:\s|$)|$)/i.exec(t)?.[1]
    ?? /\b(?:credited to|to VPA|trf to|towards)\s+([A-Za-z0-9@ ._&'-]{2,60}?)(?=\s+(?:on|via|ref|upi|txn)\b|\s*\(|[,;]|\.(?:\s|$)|$)/i.exec(t)?.[1]
    ?? /\bat\s+([A-Za-z0-9 ._&'-]{2,60}?)(?=\s+(?:on|via|ref|using|txn|avl)\b|[.,;]|$)/i.exec(t)?.[1]
    ?? /\bfrom\s+([A-Za-z0-9@ ._&'-]{2,60}?)(?=\s+(?:on|via|ref|upi|txn)\b|[.,;]|$)/i.exec(t)?.[1]
    ?? /UPI\/[A-Z]{2}\/\d+\/([A-Za-z0-9 ._&-]{2,40})/i.exec(t)?.[1],
  );

  const method: PayMethod = /\bUPI\b|@[a-z]+|VPA/i.test(t) ? "upi"
    : /\b(credit|debit) card\b|\bcard\b/i.test(t) ? "card"
      : /\b(NEFT|IMPS|RTGS)\b/i.test(t) ? "bank_transfer"
        : /\bwallet\b/i.test(t) ? "wallet" : "other";

  return { amountMinor, currency: "INR", direction, merchant, upiRef, accountLast4, method };
}

// ---------------------------------------------------------------- categories

/** Default merchant → category rules, using the apps' category names. Household corrections win. */
const DEFAULT_RULES: Array<[RegExp, string]> = [
  [/swiggy|zomato|domino|pizza|kfc|mcdonald|burger|starbucks|cafe|restaurant|eatsure|barbeque/i, "Dining"],
  [/blinkit|zepto|bigbasket|instamart|dmart|jiomart|grofers|more retail|reliance fresh|nature'?s basket|milk|dairy/i, "Groceries"],
  [/uber|ola|rapido|irctc|metro|redbus|indigo|air india|makemytrip|fastag|petrol|hpcl|bpcl|iocl|indian oil|shell/i, "Transport"],
  [/airtel|jio|vodafone|\bvi\b|bsnl|electricity|bescom|tata power|adani|mseb|bses|water|gas|act fibernet|hathway|broadband/i, "Utilities"],
  [/apollo|pharm|1mg|netmeds|medplus|hospital|clinic|diagnostic|lab/i, "Health"],
  [/school|college|tuition|byju|unacademy|udemy|coursera|fees/i, "Education"],
  [/rent|landlord|nobroker|housing/i, "Rent"],
  [/netflix|spotify|hotstar|prime video|zee5|sonyliv|youtube premium|bookmyshow|pvr|inox|cinema/i, "Entertainment"],
  [/urban company|plumber|electrician|repair|service centre/i, "Repairs"],
  [/amazon|flipkart|myntra|ajio|ikea|pepperfry|nykaa|meesho/i, "Household"],
];

export const normalizeMerchant = (m: string) => m.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function suggestCategory(ctx: Ctx, hid: string, merchant: string | null, direction: Direction): Promise<string> {
  if (direction === "credit") return "Other";
  if (!merchant) return "Other";
  const learned = await ctx.db.doc(`${paths.col(hid, "spendRules")}/${sha256(normalizeMerchant(merchant)).slice(0, 32)}`).get();
  if (learned.exists) return learned.data()!.category as string;
  return DEFAULT_RULES.find(([re]) => re.test(merchant))?.[1] ?? "Other";
}

// ---------------------------------------------------------------- inbox

export const CaptureInput = z.object({
  source: z.enum(["android_notification", "ios_shortcut"]),
  text: z.string().min(1).max(1000),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  /** Android: the posting app's package (allow-listed on the phone). iOS: the SMS sender if available. */
  sender: z.string().max(120).optional(),
});

const DEDUPE_WINDOW_MS = 10 * 60_000;

/** Files a parsed message in the review inbox. Idempotent: the same payment seen twice is one capture. */
export async function captureSpend(ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof CaptureInput>) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  const parsed = parseBankMessage(input.text);
  if (!parsed) return { status: "ignored" as const };
  const received = input.receivedAt ? new Date(input.receivedAt) : ctx.now();
  const occurredAt = Math.abs(received.getTime() - ctx.now().getTime()) > 7 * 86_400_000 ? ctx.now() : received;
  const merchantKey = parsed.merchant ? normalizeMerchant(parsed.merchant) : "-";
  // A UPI reference identifies the payment exactly; otherwise amount + direction + merchant in a 10-minute bucket.
  const dedupeKey = parsed.upiRef
    ? `ref:${parsed.upiRef}`
    : `amt:${parsed.amountMinor}:${parsed.direction}:${merchantKey}:${Math.floor(occurredAt.getTime() / DEDUPE_WINDOW_MS)}`;
  const id = sha256(`${hid}|${dedupeKey}`).slice(0, 32);
  const ref = ctx.db.doc(`${paths.col(hid, "spendCaptures")}/${id}`);

  // A payment already entered by hand (same amount within ±30 min) is flagged, not dropped.
  const near = await ctx.db.collection(paths.col(hid, "transactions"))
    .where("occurredAt", ">=", Timestamp.fromMillis(occurredAt.getTime() - 30 * 60_000))
    .where("occurredAt", "<=", Timestamp.fromMillis(occurredAt.getTime() + 30 * 60_000)).limit(20).get();
  const possibleDuplicateOf = near.docs.find((d) => d.data().amountMinor === parsed.amountMinor
    && d.data().type === (parsed.direction === "credit" ? "income" : "expense"))?.id ?? null;

  const doc = {
    householdId: hid, source: input.source, status: "pending",
    amountMinor: parsed.amountMinor, currency: parsed.currency, direction: parsed.direction,
    merchant: parsed.merchant, method: parsed.method, accountLast4: parsed.accountLast4,
    refLast4: parsed.upiRef ? parsed.upiRef.slice(-4) : null,
    suggestedCategory: await suggestCategory(ctx, hid, parsed.merchant, parsed.direction),
    possibleDuplicateOf, transactionId: null,
    occurredAt: Timestamp.fromDate(occurredAt), capturedBy: actor.uid, createdAt: ts(ctx.now()),
  };
  try {
    await ref.create(doc);
  } catch (e) {
    if ((e as { code?: number }).code === 6) return { status: "duplicate" as const, id };
    throw e;
  }
  return { status: "captured" as const, id, capture: { id, ...doc, occurredAt: occurredAt.toISOString(), createdAt: ctx.now().toISOString() } };
}

export async function listCaptures(ctx: Ctx, hid: string, actor: Actor, status: "pending" | "confirmed" | "dismissed" = "pending") {
  await requireCapability(ctx, hid, actor.uid, "finance.read");
  const snap = await ctx.db.collection(paths.col(hid, "spendCaptures")).where("status", "==", status).orderBy("occurredAt", "desc").limit(100).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, ...x, occurredAt: x.occurredAt.toDate().toISOString(), createdAt: x.createdAt?.toDate?.().toISOString?.() ?? null };
  });
}

export const ConfirmInput = z.object({
  category: z.string().trim().min(1).max(60).optional(),
  amountMinor: z.number().int().positive().optional(),
  description: z.string().max(200).optional(),
  paymentMethod: z.enum(["cash", "upi", "card", "bank_transfer", "wallet", "other"]).optional(),
  /** Remember this category for the merchant (default true). */
  remember: z.boolean().optional(),
});

/** Books the capture as a transaction (idempotent per capture) and learns the merchant's category. */
export async function confirmCapture(ctx: Ctx, hid: string, actor: Actor, captureId: string, input: z.infer<typeof ConfirmInput>) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  const ref = ctx.db.doc(`${paths.col(hid, "spendCaptures")}/${captureId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Capture");
  const c = snap.data()!;
  if (c.status === "confirmed") return { status: "confirmed", transactionId: c.transactionId };
  if (c.status !== "pending") throw new AppError(409, "not_pending", "This item was already dismissed");
  const category = input.category ?? c.suggestedCategory ?? "Other";
  const { id: transactionId } = await recordExpense(ctx, hid, actor, {
    type: c.direction === "credit" ? "income" : "expense",
    amountMinor: input.amountMinor ?? c.amountMinor, currency: c.currency, category,
    description: input.description ?? (c.merchant ? `${c.direction === "credit" ? "From" : "To"} ${c.merchant}` : "Captured payment"),
    paymentMethod: input.paymentMethod ?? c.method, occurredAt: c.occurredAt.toDate().toISOString(),
  }, `capture:${captureId}`) as { id: string };
  await ref.update({ status: "confirmed", transactionId, confirmedBy: actor.uid, confirmedAt: ts(ctx.now()), category });
  if (c.merchant && c.direction === "debit" && input.remember !== false) {
    await ctx.db.doc(`${paths.col(hid, "spendRules")}/${sha256(normalizeMerchant(c.merchant)).slice(0, 32)}`)
      .set({ merchant: c.merchant, category, updatedBy: actor.uid, updatedAt: ts(ctx.now()) }, { merge: true });
  }
  await audit(ctx, hid, actor, "finance.capture_confirmed", { type: "transaction", id: transactionId }, { source: c.source, amountMinor: input.amountMinor ?? c.amountMinor, category });
  return { status: "confirmed", transactionId };
}

export async function dismissCapture(ctx: Ctx, hid: string, actor: Actor, captureId: string) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  const ref = ctx.db.doc(`${paths.col(hid, "spendCaptures")}/${captureId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Capture");
  if (snap.data()!.status !== "pending") return { status: snap.data()!.status };
  // Dismissed items expire after 30 days (TTL on expiresAt) so the dedupe key still blocks re-capture meanwhile.
  await ref.update({ status: "dismissed", dismissedBy: actor.uid, dismissedAt: ts(ctx.now()), expiresAt: Timestamp.fromMillis(ctx.now().getTime() + 30 * 86_400_000) });
  return { status: "dismissed" };
}

// ---------------------------------------------------------------- routes

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function mountSpendRoutes(app: Express, ctx: Ctx, wrap: Wrap) {
  const actor = (req: Request): Actor => ({ uid: req.user!.uid, kind: "user" });
  const p = (req: Request, k: string) => { const v = String(req.params[k] ?? ""); if (!ID.test(v)) throw invalid(`Invalid ${k}`); return v; };
  const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => {
    const r = s.safeParse(v ?? {});
    if (!r.success) throw invalid("Invalid request", r.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })));
    return r.data;
  };
  app.post("/v1/households/:hid/spend/captures", wrap(async (req, res) => {
    const r = await captureSpend(ctx, p(req, "hid"), actor(req), parse(CaptureInput, req.body));
    res.status(r.status === "captured" ? 201 : 200).json(r);
  }));
  app.get("/v1/households/:hid/spend/captures", wrap(async (req, res) => {
    const status = z.enum(["pending", "confirmed", "dismissed"]).catch("pending").parse(req.query.status);
    res.json({ items: await listCaptures(ctx, p(req, "hid"), actor(req), status) });
  }));
  app.post("/v1/households/:hid/spend/captures/:cid/confirm", wrap(async (req, res) => {
    res.json(await confirmCapture(ctx, p(req, "hid"), actor(req), p(req, "cid"), parse(ConfirmInput, req.body)));
  }));
  app.post("/v1/households/:hid/spend/captures/:cid/dismiss", wrap(async (req, res) => {
    res.json(await dismissCapture(ctx, p(req, "hid"), actor(req), p(req, "cid")));
  }));
}
