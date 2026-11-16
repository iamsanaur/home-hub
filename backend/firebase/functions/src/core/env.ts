/**
 * Placeholder written to Secret Manager for integrations that aren't set up yet, so functions can
 * deploy before every credential exists (Secret Manager rejects empty values). Treated as absent.
 */
export const UNSET_SECRET = "unset";

/** Reads a secret or env value; empty and the `unset` placeholder both mean "not configured". */
export function secretEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v !== UNSET_SECRET ? v : undefined;
}
