/**
 * Integer money arithmetic.
 *
 * Every monetary value in this application is an integer count of minor units
 * (cents) paired with an ISO 4217 currency code. There are no floats. A
 * fractional cent is not a real thing, and a rounding error in a pricing engine
 * is invisible until it has been quietly eroding margin for a quarter.
 *
 * Rates and multipliers are expressed in basis points (1 bp = 0.01%), so
 * 20000 bp = 2.0x and 2100 bp = 21%.
 */

export const BP_SCALE = 10_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds safe integer range: ${value}`);
  }
}

/**
 * Multiply a minor-unit amount by a basis-point factor, rounding half away from
 * zero. Half-away-from-zero (rather than JS's `Math.round`, which is
 * half-toward-positive-infinity) keeps behaviour symmetric for negative
 * amounts, which matters for discounts and refunds.
 */
export function applyBp(amountMinor: number, bp: number): number {
  assertSafeInteger(amountMinor, "amountMinor");
  assertSafeInteger(bp, "bp");

  const product = amountMinor * bp;
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError(
      `applyBp overflow: ${amountMinor} * ${bp} exceeds safe integer range`,
    );
  }

  const quotient = product / BP_SCALE;
  return quotient < 0 ? -Math.round(-quotient) : Math.round(quotient);
}

/** Add a percentage expressed in basis points (e.g. VAT at 2100 bp). */
export function addBp(amountMinor: number, bp: number): number {
  return amountMinor + applyBp(amountMinor, bp);
}

/**
 * Remove a percentage expressed in basis points. Inverse of `addBp`.
 *
 * Used to recover the net (ex-VAT) amount from a gross price. Note this is not
 * exactly reversible for every input: integer rounding means
 * `removeBp(addBp(x, bp), bp)` can differ from `x` by one minor unit. That is
 * inherent to integer money, not a defect — but it is why margin checks run
 * against the actual final price rather than an assumed net.
 */
export function removeBp(grossMinor: number, bp: number): number {
  assertSafeInteger(grossMinor, "grossMinor");
  assertSafeInteger(bp, "bp");
  if (bp <= -BP_SCALE) {
    throw new MoneyError(`removeBp would divide by zero or invert sign: ${bp}`);
  }

  const quotient = (grossMinor * BP_SCALE) / (BP_SCALE + bp);
  return quotient < 0 ? -Math.round(-quotient) : Math.round(quotient);
}

/** Convert between currencies using a basis-point rate (quote per 1 base). */
export function convertCurrency(amountMinor: number, rateBp: number): number {
  if (rateBp <= 0) {
    throw new MoneyError(`FX rate must be positive, received ${rateBp}`);
  }
  return applyBp(amountMinor, rateBp);
}

export type RoundingStrategy = "NONE" | "END_99" | "END_95" | "NEAREST";

/**
 * Apply a charm-pricing rounding strategy.
 *
 * END_99 and END_95 round to the nearest whole currency unit ending in .99/.95
 * at or above the input, except when the input is already a whole unit — then
 * it drops to just below it (10.00 becomes 9.99), which is the point of charm
 * pricing.
 *
 * This is deliberately discontinuous: 10.00 rounds DOWN to 9.99 while 10.01
 * rounds UP to 10.99. That discontinuity can push a price below its minimum
 * margin, which is exactly why the pricing engine checks margin AFTER rounding
 * rather than before.
 */
export function roundTo(amountMinor: number, strategy: RoundingStrategy): number {
  assertSafeInteger(amountMinor, "amountMinor");

  switch (strategy) {
    case "NONE":
      return amountMinor;

    case "NEAREST":
      return Math.round(amountMinor / 100) * 100;

    case "END_99":
      return roundToEnding(amountMinor, 99);

    case "END_95":
      return roundToEnding(amountMinor, 95);
  }
}

function roundToEnding(amountMinor: number, ending: number): number {
  if (amountMinor <= 0) return amountMinor;

  const shortfall = 100 - ending;

  // An exact whole unit drops to just below itself: 10.00 -> 9.99. This is the
  // entire point of charm pricing, and it is the one case that moves the price
  // DOWN. Everything else rounds up.
  if (amountMinor % 100 === 0) {
    return amountMinor - shortfall;
  }

  const wholeUnits = Math.ceil(amountMinor / 100);
  const candidate = wholeUnits * 100 - shortfall;

  // The candidate can fall below the input for endings other than .99 —
  // 10.97 cannot become 10.95, so it becomes 11.95.
  return candidate < amountMinor ? candidate + 100 : candidate;
}

/** Format minor units for display/logging. Not for arithmetic. */
export function formatMinor(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${major}.${minor} ${currency}`;
}
