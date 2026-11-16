import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Ctx } from "./services/base";

let ctx: Ctx | null = null;

/** Lazily initialised Admin SDK context (trusted server environments only). */
export function adminCtx(): Ctx {
  if (ctx) return ctx;
  if (getApps().length === 0) initializeApp();
  const db = getFirestore();
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() may only be called once per instance
  }
  ctx = { db, now: () => new Date() };
  return ctx;
}
