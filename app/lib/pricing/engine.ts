/**
 * Pricing engine.
 *
 * Pure functions, no I/O, no clock, no database. Everything it needs arrives as
 * arguments, which is what makes it exhaustively testable — and it needs to be,
 * because pricing defects do not announce themselves. A wrong product title is
 * obvious on sight; a multiplier that is 2% low silently erodes margin across
 * every order until someone reconciles a quarter.
 *
 * Order of operations matters and is deliberate:
 *   cost -> FX -> shipping -> multiplier+fee -> VAT -> rounding -> margin check
 *
 * Rounding happens on the GROSS price because gross is what the customer sees;
 * charm pricing on an ex-VAT figure produces ugly gross prices. The margin
 * check happens AFTER rounding because rounding can move the price below cost.
 */

import {
  addBp,
  applyBp,
  convertCurrency,
  removeBp,
  roundTo,
  type RoundingStrategy,
} from "../money.js";

export type VatHandling = "ADD_VAT" | "PRICE_IS_GROSS";

export interface PriceTierInput {
  minCostMinor: number;
  /** Inclusive upper bound. `null` means unbounded. */
  maxCostMinor: number | null;
  multiplierBp: number;
  fixedFeeMinor: number;
}

export interface PricingRuleInput {
  multiplierBp: number;
  fixedFeeMinor: number;
  rounding: RoundingStrategy;
  compareAtMultiplierBp: number | null;
  minMarginMinor: number;
  includeShipping: boolean;
  vatHandling: VatHandling;
  /** Cost-banded overrides. The base rule applies when none match. */
  tiers?: PriceTierInput[];
}

export interface MarketInput {
  currencyCode: string;
  /** Basis points. 2100 == 21%. */
  vatRateBp: number;
}

export interface PriceInput {
  costMinor: number;
  costCurrency: string;
  shippingMinor?: number;
  market: MarketInput;
  rule: PricingRuleInput;
  /**
   * Basis-point rate converting `costCurrency` into `market.currencyCode`.
   * Required when the currencies differ. There is deliberately no default:
   * a missing rate must fail loudly, never silently price at parity.
   */
  fxRateBp?: number | null;
}

export interface PriceBreakdown {
  /** Landed cost in the market's currency, after FX and shipping. */
  landedCostMinor: number;
  costAfterFxMinor: number;
  shippingAppliedMinor: number;
  multiplierBpApplied: number;
  fixedFeeAppliedMinor: number;
  tierApplied: PriceTierInput | null;
  netBeforeVatMinor: number;
  grossBeforeRoundingMinor: number;
  vatRateBp: number;
  /** Ex-VAT revenue actually realised at the final price. */
  realisedNetMinor: number;
  marginMinor: number;
}

export type PricingFailureCode =
  | "INVALID_COST"
  | "MISSING_FX_RATE"
  | "MIN_MARGIN_VIOLATION";

export type PriceResult =
  | {
      ok: true;
      priceMinor: number;
      compareAtMinor: number | null;
      currency: string;
      breakdown: PriceBreakdown;
      warnings: string[];
    }
  | {
      ok: false;
      code: PricingFailureCode;
      message: string;
      /** Present when a price was computable but rejected, so the UI can show it. */
      priceMinor: number | null;
      breakdown: PriceBreakdown | null;
    };

/**
 * Compute a selling price from a supplier cost.
 *
 * Returns a discriminated union rather than throwing, because every failure
 * here is an expected data condition (a missing FX rate, a margin floor) that
 * the caller must surface to the merchant. TypeScript forces the `ok` check, so
 * a failure cannot be mistaken for a price.
 */
export function calculatePrice(input: PriceInput): PriceResult {
  const { costMinor, costCurrency, market, rule } = input;
  const shippingMinor = input.shippingMinor ?? 0;
  const warnings: string[] = [];

  if (!Number.isInteger(costMinor) || costMinor < 0) {
    return {
      ok: false,
      code: "INVALID_COST",
      message: `Cost must be a non-negative integer in minor units, received ${costMinor}`,
      priceMinor: null,
      breakdown: null,
    };
  }

  // --- 1. Currency conversion -----------------------------------------------
  const sameCurrency = costCurrency === market.currencyCode;
  if (!sameCurrency && (input.fxRateBp == null || input.fxRateBp <= 0)) {
    return {
      ok: false,
      code: "MISSING_FX_RATE",
      message:
        `No FX rate available for ${costCurrency} -> ${market.currencyCode}. ` +
        "Refusing to price at parity; refresh exchange rates and retry.",
      priceMinor: null,
      breakdown: null,
    };
  }

  const costAfterFxMinor = sameCurrency
    ? costMinor
    : convertCurrency(costMinor, input.fxRateBp as number);
  const shippingAfterFxMinor = sameCurrency
    ? shippingMinor
    : convertCurrency(shippingMinor, input.fxRateBp as number);

  // --- 2. Landed cost -------------------------------------------------------
  const shippingAppliedMinor = rule.includeShipping ? shippingAfterFxMinor : 0;
  const landedCostMinor = costAfterFxMinor + shippingAppliedMinor;

  // --- 3. Tier selection ----------------------------------------------------
  const tierApplied = selectTier(landedCostMinor, rule.tiers);
  const multiplierBpApplied = tierApplied?.multiplierBp ?? rule.multiplierBp;
  const fixedFeeAppliedMinor = tierApplied?.fixedFeeMinor ?? rule.fixedFeeMinor;

  // --- 4. Markup ------------------------------------------------------------
  const netBeforeVatMinor =
    applyBp(landedCostMinor, multiplierBpApplied) + fixedFeeAppliedMinor;

  // --- 5. VAT ---------------------------------------------------------------
  // ADD_VAT:        the marked-up figure is ex-VAT, so VAT goes on top.
  // PRICE_IS_GROSS: the marked-up figure already represents the shelf price.
  const grossBeforeRoundingMinor =
    rule.vatHandling === "ADD_VAT"
      ? addBp(netBeforeVatMinor, market.vatRateBp)
      : netBeforeVatMinor;

  // --- 6. Rounding (on the gross, because gross is what the customer sees) ---
  const priceMinor = roundTo(grossBeforeRoundingMinor, rule.rounding);

  // --- 7. Margin, measured against what is actually realised ----------------
  // The merchant remits VAT to the state regardless of how the rule was
  // configured, so ex-VAT revenue is always backed out of the final price.
  const realisedNetMinor =
    market.vatRateBp > 0 ? removeBp(priceMinor, market.vatRateBp) : priceMinor;
  const marginMinor = realisedNetMinor - landedCostMinor;

  const breakdown: PriceBreakdown = {
    landedCostMinor,
    costAfterFxMinor,
    shippingAppliedMinor,
    multiplierBpApplied,
    fixedFeeAppliedMinor,
    tierApplied,
    netBeforeVatMinor,
    grossBeforeRoundingMinor,
    vatRateBp: market.vatRateBp,
    realisedNetMinor,
    marginMinor,
  };

  if (marginMinor < rule.minMarginMinor) {
    return {
      ok: false,
      code: "MIN_MARGIN_VIOLATION",
      message:
        `Margin ${marginMinor} is below the configured minimum ${rule.minMarginMinor} ` +
        `(landed cost ${landedCostMinor}, realised net ${realisedNetMinor}).`,
      priceMinor,
      breakdown,
    };
  }

  // --- 8. Compare-at --------------------------------------------------------
  let compareAtMinor: number | null = null;
  if (rule.compareAtMultiplierBp != null) {
    const raw = applyBp(priceMinor, rule.compareAtMultiplierBp);
    const rounded = roundTo(raw, rule.rounding);
    if (rounded > priceMinor) {
      compareAtMinor = rounded;
    } else {
      // A compare-at at or below the selling price reads as a price increase.
      // Drop it rather than display something that undermines the offer.
      warnings.push(
        `Compare-at price ${rounded} was not above the selling price ${priceMinor}; omitted.`,
      );
    }
  }

  if (rule.rounding !== "NONE" && priceMinor < grossBeforeRoundingMinor) {
    warnings.push(
      `Rounding reduced the price from ${grossBeforeRoundingMinor} to ${priceMinor}.`,
    );
  }

  return { ok: true, priceMinor, compareAtMinor, currency: market.currencyCode, breakdown, warnings };
}

/**
 * Pick the cost band that applies. Tiers are overrides on top of the base rule,
 * so "no tier matched" is a normal outcome, not an error. The first match wins;
 * overlapping tiers are a configuration problem surfaced in the UI, not here.
 */
function selectTier(
  landedCostMinor: number,
  tiers: PriceTierInput[] | undefined,
): PriceTierInput | null {
  if (!tiers || tiers.length === 0) return null;
  for (const tier of tiers) {
    const aboveFloor = landedCostMinor >= tier.minCostMinor;
    const belowCeiling = tier.maxCostMinor == null || landedCostMinor <= tier.maxCostMinor;
    if (aboveFloor && belowCeiling) return tier;
  }
  return null;
}
