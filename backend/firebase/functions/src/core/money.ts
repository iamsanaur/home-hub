/**
 * Money is always an integer count of the currency's minor unit (paise, cents, …)
 * plus an ISO 4217 code. Floating-point arithmetic is never used for amounts.
 */
export interface Money {
  amountMinor: number;
  currency: string;
}

const MAX_MINOR = Number.MAX_SAFE_INTEGER;

/** ISO 4217 minor-unit exponents that differ from the default of 2. */
const EXPONENT_OVERRIDES: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, UGX: 0, XAF: 0, XOF: 0, PYG: 0, RWF: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, LYD: 3, IQD: 3,
};

export class MoneyError extends Error {}

export function currencyExponent(currency: string): number {
  assertCurrency(currency);
  return EXPONENT_OVERRIDES[currency] ?? 2;
}

export function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) throw new MoneyError(`Invalid currency code: ${currency}`);
}

export function assertMinor(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`Amount must be an integer number of minor units, got ${amountMinor}`);
  }
  if (Math.abs(amountMinor) > MAX_MINOR) throw new MoneyError("Amount out of range");
}

export function money(amountMinor: number, currency: string): Money {
  assertMinor(amountMinor);
  assertCurrency(currency);
  return { amountMinor, currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(items: Money[], currency: string): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

/**
 * Multiply by a rational quantity (numerator/denominator) using integer maths with
 * banker's rounding (round half to even). Used for quantity × unit price.
 */
export function multiplyRational(m: Money, numerator: number, denominator = 1): Money {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new MoneyError("multiplyRational requires integer numerator and positive integer denominator");
  }
  const product = BigInt(m.amountMinor) * BigInt(numerator);
  const d = BigInt(denominator);
  let q = product / d;
  const r = product % d;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice > d || (twice === d && q % 2n !== 0n)) q += product < 0n ? -1n : 1n;
  return money(Number(q), m.currency);
}

/**
 * Multiply by a decimal quantity such as 1.5 kg. The quantity is converted to a
 * rational with up to 3 decimal places so the arithmetic stays exact.
 */
export function multiplyQuantity(m: Money, quantity: number): Money {
  if (!Number.isFinite(quantity) || quantity < 0) throw new MoneyError("Invalid quantity");
  const scaled = Math.round(quantity * 1000);
  return multiplyRational(m, scaled, 1000);
}

/** Split an amount into n parts that sum exactly to the original (largest remainder). */
export function allocate(m: Money, ratios: number[]): Money[] {
  if (ratios.length === 0 || ratios.some((r) => !Number.isSafeInteger(r) || r < 0)) {
    throw new MoneyError("Ratios must be non-negative integers");
  }
  const total = ratios.reduce((a, b) => a + b, 0);
  if (total === 0) throw new MoneyError("Ratios must not all be zero");
  const shares = ratios.map((r) => Math.floor((m.amountMinor * r) / total));
  let remainder = m.amountMinor - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % shares.length) {
    if (ratios[i] > 0) {
      shares[i] += 1;
      remainder -= 1;
    }
  }
  return shares.map((s) => money(s, m.currency));
}

/** Parse a user-entered decimal string ("1,234.50") into minor units without floats. */
export function parseDecimal(input: string, currency: string): Money {
  const exp = currencyExponent(currency);
  const cleaned = input.trim().replace(/[\s,_]/g, "");
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) throw new MoneyError(`Not a valid amount: "${input}"`);
  const [, sign, whole, frac = ""] = match;
  if (frac.length > exp) throw new MoneyError(`Too many decimal places for ${currency}`);
  const minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, "0") || "0");
  const value = Number(sign ? -minor : minor);
  return money(value, currency);
}

/** Format for display. Formatting only — never feed the result back into arithmetic. */
export function format(m: Money, locale = "en"): string {
  const exp = currencyExponent(m.currency);
  const negative = m.amountMinor < 0;
  const abs = BigInt(Math.abs(m.amountMinor));
  const base = 10n ** BigInt(exp);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(exp, "0");
  // Intl handles grouping/symbols; we pass a string decimal so no float rounding occurs.
  const decimal = exp > 0 ? `${whole}.${frac}` : `${whole}`;
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  });
  const text = formatter.format(decimal as unknown as number);
  return negative ? `-${text}` : text;
}

/** Percentage of a / b in basis points (integer, 10000 = 100%). */
export function ratioBasisPoints(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Number((BigInt(part) * 10000n) / BigInt(whole));
}
