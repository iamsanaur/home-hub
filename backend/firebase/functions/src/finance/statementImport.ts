/**
 * UPI / bank statement import.
 *
 * The phone reads the statement PDF on the device and sends only the parsed rows (never the PDF or its raw text).
 * This module deduplicates them against everything HomeHub already knows and files the new ones in the same
 * "To review" inbox as automatic captures — nothing is booked until a finance-permitted adult confirms it.
 *
 * Deduplication, strongest first:
 *  1. Same UPI reference (UTR / RRN) → exactly the same payment. Uses the same document id as automatic capture,
 *     so a payment first seen in a bank SMS and later in a statement is one record, whatever its status
 *     (pending, confirmed or dismissed — a dismissed payment is not resurrected by a statement).
 *  2. Same payment twice inside one file → kept once.
 *  3. No reference match but the same amount and direction at (nearly) the same time as something already in the
 *     inbox or already entered by hand → flagged "possible duplicate", never silently dropped.
 */
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { Actor, Ctx, paths, requireCapability, sha256, ts } from "../services/base";
import { normalizeMerchant, suggestCategory } from "./spendCapture";

/** Per request. The gateway rejects bodies over 64 KB, so the phone sends longer statements in several requests. */
export const MAX_ROWS = 150;
const TIMED_WINDOW_MS = 30 * 60_000;
const DATE_ONLY_WINDOW_MS = 12 * 3_600_000;

export const StatementRow = z.object({
  /** ISO instant with offset. For rows that only have a date the phone sends local midday and timeKnown=false. */
  occurredAt: z.string().datetime({ offset: true }),
  timeKnown: z.boolean().default(false),
  amountMinor: z.number().int().positive().max(100_000_000_00),
  direction: z.enum(["debit", "credit"]),
  merchant: z.string().trim().max(120).nullable().optional(),
  upiRef: z.string().regex(/^\d{12}$/).nullable().optional(),
  accountLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
  method: z.enum(["upi", "card", "bank_transfer", "wallet", "other"]).default("upi"),
});

export const StatementImportInput = z.object({
  sourceApp: z.enum(["phonepe", "gpay", "paytm", "bank", "other"]),
  rows: z.array(StatementRow).min(1).max(MAX_ROWS),
  /** Preview only: report what would happen, write nothing. */
  dryRun: z.boolean().default(false),
});

export type RowStatus = "new" | "already_captured" | "possible_duplicate" | "duplicate_in_file" | "invalid";
export interface RowResult { index: number; status: RowStatus; existingStatus?: "pending" | "confirmed" | "dismissed"; suggestedCategory?: string }

const dedupeKey = (r: z.infer<typeof StatementRow>) => r.upiRef
  ? `ref:${r.upiRef}`
  // No reference: amount + direction + merchant + the exact minute (or the day when there's no time) — only ever matches itself.
  : `stmt:${r.amountMinor}:${r.direction}:${r.merchant ? normalizeMerchant(r.merchant) : "-"}:${r.timeKnown ? r.occurredAt.slice(0, 16) : r.occurredAt.slice(0, 10)}`;

export async function importStatement(ctx: Ctx, hid: string, actor: Actor, input: z.infer<typeof StatementImportInput>) {
  await requireCapability(ctx, hid, actor.uid, "finance.write");
  const now = ctx.now();
  const rows = input.rows;
  const results: RowResult[] = rows.map((_, index) => ({ index, status: "new" as RowStatus }));

  const when = rows.map((r) => new Date(r.occurredAt).getTime());
  rows.forEach((_, i) => { if (when[i] > now.getTime() + 86_400_000 || when[i] < now.getTime() - 5 * 365 * 86_400_000) results[i].status = "invalid"; });

  // 1 + 2. Exact: same document id as automatic capture; also repeats inside this file.
  const ids = rows.map((r) => sha256(`${hid}|${dedupeKey(r)}`).slice(0, 32));
  const col = paths.col(hid, "spendCaptures");
  const refs = ids.map((id) => ctx.db.doc(`${col}/${id}`));
  const existing = refs.length ? await ctx.db.getAll(...refs) : [];
  const seen = new Set<string>();
  rows.forEach((_, i) => {
    if (results[i].status === "invalid") return;
    if (existing[i].exists) { results[i].status = "already_captured"; results[i].existingStatus = existing[i].data()!.status; return; }
    if (seen.has(ids[i])) { results[i].status = "duplicate_in_file"; return; }
    seen.add(ids[i]);
  });

  // 3. Fuzzy: same amount + direction near the same time, among captures and manually entered transactions.
  const open = results.map((r, i) => (r.status === "new" ? i : -1)).filter((i) => i >= 0);
  const possible = new Set<number>();
  if (open.length) {
    const lo = Timestamp.fromMillis(Math.min(...open.map((i) => when[i])) - DATE_ONLY_WINDOW_MS);
    const hi = Timestamp.fromMillis(Math.max(...open.map((i) => when[i])) + DATE_ONLY_WINDOW_MS);
    const [caps, txns] = await Promise.all([
      ctx.db.collection(col).where("occurredAt", ">=", lo).where("occurredAt", "<=", hi).limit(2000).get(),
      ctx.db.collection(paths.col(hid, "transactions")).where("occurredAt", ">=", lo).where("occurredAt", "<=", hi).limit(2000).get(),
    ]);
    const known = [
      ...caps.docs.map((d) => ({ at: d.data().occurredAt.toMillis() as number, amount: d.data().amountMinor as number, dir: d.data().direction as string })),
      ...txns.docs.map((d) => ({ at: d.data().occurredAt.toMillis() as number, amount: d.data().amountMinor as number, dir: d.data().type === "income" ? "credit" : "debit" })),
    ];
    for (const i of open) {
      const win = rows[i].timeKnown ? TIMED_WINDOW_MS : DATE_ONLY_WINDOW_MS;
      if (known.some((k) => k.amount === rows[i].amountMinor && k.dir === rows[i].direction && Math.abs(k.at - when[i]) <= win)) { results[i].status = "possible_duplicate"; possible.add(i); }
    }
  }

  const importable = results.filter((r) => r.status === "new" || r.status === "possible_duplicate");
  const summary = {
    found: rows.length,
    new: results.filter((r) => r.status === "new").length,
    alreadyCaptured: results.filter((r) => r.status === "already_captured").length,
    possibleDuplicate: possible.size,
    duplicateInFile: results.filter((r) => r.status === "duplicate_in_file").length,
    invalid: results.filter((r) => r.status === "invalid").length,
  };

  // Suggested categories (one lookup per distinct merchant).
  const cat = new Map<string, string>();
  for (const r of importable) {
    const row = rows[r.index]; const key = `${row.direction}|${row.merchant ?? ""}`;
    if (!cat.has(key)) cat.set(key, await suggestCategory(ctx, hid, row.merchant ?? null, row.direction));
    r.suggestedCategory = cat.get(key);
  }
  if (input.dryRun) return { dryRun: true, summary, results };

  // Write: new captures, flagged when a possible duplicate was found. A batch is at most 150 writes.
  const batch = ctx.db.batch();
  for (const r of importable) {
    const row = rows[r.index];
    batch.create(refs[r.index], {
      householdId: hid, source: "statement_import", importApp: input.sourceApp, status: "pending",
      amountMinor: row.amountMinor, currency: "INR", direction: row.direction,
      merchant: row.merchant ?? null, method: row.method, accountLast4: row.accountLast4 ?? null,
      refLast4: row.upiRef ? row.upiRef.slice(-4) : null,
      suggestedCategory: r.suggestedCategory ?? "Other",
      possibleDuplicateOf: possible.has(r.index) ? "statement" : null, transactionId: null,
      occurredAt: Timestamp.fromMillis(when[r.index]), capturedBy: actor.uid, createdAt: ts(now),
    });
  }
  if (importable.length) await batch.commit();
  return { dryRun: false, summary: { ...summary, imported: importable.length }, results };
}
