import { describe, expect, it } from "vitest";
import { calculatePrice, type MarketInput, type PriceInput, type PricingRuleInput } from "./engine.js";

const DE: MarketInput = { currencyCode: "EUR", vatRateBp: 1900 };
const HU: MarketInput = { currencyCode: "EUR", vatRateBp: 2700 };
const NO_VAT: MarketInput = { currencyCode: "EUR", vatRateBp: 0 };

const baseRule: PricingRuleInput = {
  multiplierBp: 30000, // 3.0x
  fixedFeeMinor: 0,
  rounding: "NONE",
  compareAtMultiplierBp: null,
  minMarginMinor: 0,
  includeShipping: false,
  vatHandling: "ADD_VAT",
};

function price(overrides: Partial<PriceInput> = {}) {
  return calculatePrice({
    costMinor: 1000,
    costCurrency: "EUR",
    market: DE,
    rule: baseRule,
    ...overrides,
  });
}

function rule(overrides: Partial<PricingRuleInput>): PricingRuleInput {
  return { ...baseRule, ...overrides };
}

/** Narrowing helper so tests read cleanly. */
function ok(result: ReturnType<typeof calculatePrice>) {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result;
}

describe("core markup", () => {
  it("applies a 3x multiplier then VAT", () => {
    // 1000 * 3.0 = 3000 net, + 19% VAT = 3570
    expect(ok(price()).priceMinor).toBe(3570);
  });

  it("applies a fixed fee after the multiplier", () => {
    // (1000 * 2.0) + 500 = 2500 net, + 19% = 2975
    expect(ok(price({ rule: rule({ multiplierBp: 20000, fixedFeeMinor: 500 }) })).priceMinor).toBe(2975);
  });

  it("handles a 1x multiplier with no fee", () => {
    expect(ok(price({ rule: rule({ multiplierBp: 10000 }) })).priceMinor).toBe(1190);
  });

  it("prices a one-minor-unit cost without collapsing to zero", () => {
    const result = ok(price({ costMinor: 1 }));
    expect(result.priceMinor).toBe(4); // 1*3 = 3, +19% = 3.57 -> 4
    expect(result.breakdown.landedCostMinor).toBe(1);
  });

  it("prices a zero cost as the fee alone", () => {
    const result = ok(price({ costMinor: 0, rule: rule({ fixedFeeMinor: 1000 }) }));
    expect(result.breakdown.netBeforeVatMinor).toBe(1000);
    expect(result.priceMinor).toBe(1190);
  });

  it("rejects a negative cost", () => {
    const result = price({ costMinor: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_COST");
  });

  it("rejects a fractional cost", () => {
    const result = price({ costMinor: 10.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_COST");
  });
});

describe("VAT", () => {
  it("adds 19% (DE)", () => expect(ok(price()).priceMinor).toBe(3570));

  it("adds 27% (HU, the EU maximum)", () => {
    expect(ok(price({ market: HU })).priceMinor).toBe(3810);
  });

  it("adds nothing at 0%", () => {
    expect(ok(price({ market: NO_VAT })).priceMinor).toBe(3000);
  });

  it("treats the marked-up figure as gross under PRICE_IS_GROSS", () => {
    const result = ok(price({ rule: rule({ vatHandling: "PRICE_IS_GROSS" }) }));
    expect(result.priceMinor).toBe(3000);
    // VAT is still owed to the state, so realised net is backed out of the price.
    expect(result.breakdown.realisedNetMinor).toBe(2521);
  });

  it("backs VAT out of the final price for margin purposes", () => {
    const result = ok(price());
    expect(result.breakdown.realisedNetMinor).toBe(3000);
    expect(result.breakdown.marginMinor).toBe(2000);
  });
});

describe("rounding", () => {
  it("rounds a gross price up to .99", () => {
    // 1000 * 3.0 = 3000, +19% = 3570 -> 35.99
    expect(ok(price({ rule: rule({ rounding: "END_99" }) })).priceMinor).toBe(3599);
  });

  it("rounds to .95", () => {
    expect(ok(price({ rule: rule({ rounding: "END_95" }) })).priceMinor).toBe(3595);
  });

  it("rounds to the nearest whole unit", () => {
    expect(ok(price({ rule: rule({ rounding: "NEAREST" }) })).priceMinor).toBe(3600);
  });

  it("rounds the GROSS, not the net", () => {
    // Rounding the net (3000 -> 3099) then adding VAT would give 3688.
    // Rounding the gross gives a clean 35.99 shelf price.
    const result = ok(price({ rule: rule({ rounding: "END_99" }) }));
    expect(result.priceMinor).toBe(3599);
    expect(result.priceMinor % 100).toBe(99);
  });

  it("warns when rounding reduces the price", () => {
    // Gross lands exactly on a whole unit, so END_99 drops it by one minor unit.
    const result = ok(
      calculatePrice({
        costMinor: 1000,
        costCurrency: "EUR",
        market: NO_VAT,
        rule: rule({ multiplierBp: 30000, rounding: "END_99" }),
      }),
    );
    expect(result.priceMinor).toBe(2999);
    expect(result.warnings.some((w) => w.includes("Rounding reduced"))).toBe(true);
  });
});

describe("currency conversion", () => {
  it("refuses to price without an FX rate", () => {
    const result = price({ costCurrency: "USD" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MISSING_FX_RATE");
      expect(result.message).toContain("Refusing to price at parity");
    }
  });

  it("refuses a zero or negative FX rate", () => {
    expect(price({ costCurrency: "USD", fxRateBp: 0 }).ok).toBe(false);
    expect(price({ costCurrency: "USD", fxRateBp: -1 }).ok).toBe(false);
  });

  it("converts USD to EUR before marking up", () => {
    // 1000 USD-cents * 0.92 = 920 EUR-cents, * 3.0 = 2760, +19% = 3284
    const result = ok(price({ costCurrency: "USD", fxRateBp: 9200 }));
    expect(result.breakdown.costAfterFxMinor).toBe(920);
    expect(result.priceMinor).toBe(3284);
  });

  it("skips conversion when currencies match", () => {
    const result = ok(price({ costCurrency: "EUR", fxRateBp: 9200 }));
    expect(result.breakdown.costAfterFxMinor).toBe(1000);
  });
});

describe("shipping", () => {
  it("ignores shipping when the rule excludes it", () => {
    expect(ok(price({ shippingMinor: 500 })).breakdown.landedCostMinor).toBe(1000);
  });

  it("includes shipping in landed cost when the rule enables it", () => {
    const result = ok(price({ shippingMinor: 500, rule: rule({ includeShipping: true }) }));
    expect(result.breakdown.landedCostMinor).toBe(1500);
    expect(result.priceMinor).toBe(5355); // 1500*3 = 4500, +19%
  });

  it("converts shipping through FX as well", () => {
    const result = ok(
      price({ costCurrency: "USD", fxRateBp: 9200, shippingMinor: 500, rule: rule({ includeShipping: true }) }),
    );
    expect(result.breakdown.shippingAppliedMinor).toBe(460);
    expect(result.breakdown.landedCostMinor).toBe(1380);
  });
});

describe("cost-banded tiers", () => {
  const tiers = [
    { minCostMinor: 0, maxCostMinor: 999, multiplierBp: 40000, fixedFeeMinor: 200 },
    { minCostMinor: 1000, maxCostMinor: 4999, multiplierBp: 25000, fixedFeeMinor: 100 },
    { minCostMinor: 5000, maxCostMinor: null, multiplierBp: 15000, fixedFeeMinor: 0 },
  ];

  it("applies the low band", () => {
    const result = ok(price({ costMinor: 500, rule: rule({ tiers }) }));
    expect(result.breakdown.multiplierBpApplied).toBe(40000);
    expect(result.breakdown.netBeforeVatMinor).toBe(2200);
  });

  it("applies the middle band at its lower edge", () => {
    const result = ok(price({ costMinor: 1000, rule: rule({ tiers }) }));
    expect(result.breakdown.multiplierBpApplied).toBe(25000);
    expect(result.breakdown.netBeforeVatMinor).toBe(2600);
  });

  it("applies the middle band at its upper edge", () => {
    expect(ok(price({ costMinor: 4999, rule: rule({ tiers }) })).breakdown.multiplierBpApplied).toBe(25000);
  });

  it("applies the unbounded top band", () => {
    expect(ok(price({ costMinor: 50000, rule: rule({ tiers }) })).breakdown.multiplierBpApplied).toBe(15000);
  });

  it("falls back to the base rule when no tier matches", () => {
    const gapped = [{ minCostMinor: 90000, maxCostMinor: null, multiplierBp: 11000, fixedFeeMinor: 0 }];
    const result = ok(price({ costMinor: 1000, rule: rule({ tiers: gapped }) }));
    expect(result.breakdown.tierApplied).toBeNull();
    expect(result.breakdown.multiplierBpApplied).toBe(30000);
  });

  it("selects tiers on landed cost, not raw cost", () => {
    const result = ok(
      price({ costMinor: 900, shippingMinor: 200, rule: rule({ tiers, includeShipping: true }) }),
    );
    expect(result.breakdown.landedCostMinor).toBe(1100);
    expect(result.breakdown.multiplierBpApplied).toBe(25000);
  });
});

describe("minimum margin", () => {
  it("passes when margin clears the floor", () => {
    expect(price({ rule: rule({ minMarginMinor: 1000 }) }).ok).toBe(true);
  });

  it("fails when margin is below the floor", () => {
    const result = price({ rule: rule({ minMarginMinor: 5000 }) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MIN_MARGIN_VIOLATION");
  });

  it("still returns the computed price on violation so the UI can show it", () => {
    const result = price({ rule: rule({ minMarginMinor: 5000 }) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.priceMinor).toBe(3570);
      expect(result.breakdown?.marginMinor).toBe(2000);
    }
  });

  it("catches a below-cost price caused by rounding, not by markup", () => {
    // Markup alone clears cost; END_99 rounding pushes it back under the floor.
    const result = calculatePrice({
      costMinor: 1000,
      costCurrency: "EUR",
      market: NO_VAT,
      rule: rule({ multiplierBp: 10000, rounding: "END_99", minMarginMinor: 0 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MIN_MARGIN_VIOLATION");
      expect(result.priceMinor).toBe(999);
    }
  });

  it("measures margin against landed cost including shipping", () => {
    const result = price({
      shippingMinor: 500,
      rule: rule({ multiplierBp: 12000, includeShipping: true, minMarginMinor: 0, vatHandling: "PRICE_IS_GROSS" }),
    });
    // 1500 landed, *1.2 = 1800 gross, realised net 1513 -> margin only 13
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.breakdown.marginMinor).toBe(13);
  });
});

describe("compare-at price", () => {
  it("computes a compare-at above the selling price", () => {
    const result = ok(price({ rule: rule({ compareAtMultiplierBp: 15000 }) }));
    expect(result.compareAtMinor).toBe(5355);
    expect(result.compareAtMinor!).toBeGreaterThan(result.priceMinor);
  });

  it("omits a compare-at that is not above the price", () => {
    const result = ok(price({ rule: rule({ compareAtMultiplierBp: 10000 }) }));
    expect(result.compareAtMinor).toBeNull();
    expect(result.warnings.some((w) => w.includes("not above the selling price"))).toBe(true);
  });

  it("omits a compare-at below the price entirely", () => {
    const result = ok(price({ rule: rule({ compareAtMultiplierBp: 8000 }) }));
    expect(result.compareAtMinor).toBeNull();
  });

  it("applies the same rounding to compare-at", () => {
    const result = ok(price({ rule: rule({ rounding: "END_99", compareAtMultiplierBp: 15000 }) }));
    expect(result.compareAtMinor! % 100).toBe(99);
  });

  it("omits compare-at when not configured", () => {
    expect(ok(price()).compareAtMinor).toBeNull();
  });
});

describe("invariants across the input space", () => {
  it("never prices below cost when a zero margin floor is set", () => {
    for (let cost = 1; cost <= 3000; cost += 7) {
      for (const rounding of ["NONE", "END_99", "END_95", "NEAREST"] as const) {
        const result = calculatePrice({
          costMinor: cost,
          costCurrency: "EUR",
          market: DE,
          rule: rule({ multiplierBp: 20000, rounding, minMarginMinor: 0 }),
        });
        if (result.ok) {
          expect(result.breakdown.realisedNetMinor).toBeGreaterThanOrEqual(cost);
        } else {
          expect(result.code).toBe("MIN_MARGIN_VIOLATION");
        }
      }
    }
  });

  it("always returns integer minor units", () => {
    for (let cost = 1; cost <= 1000; cost += 13) {
      const result = calculatePrice({
        costMinor: cost,
        costCurrency: "USD",
        market: HU,
        rule: rule({ multiplierBp: 27350, fixedFeeMinor: 199, rounding: "END_99" }),
        fxRateBp: 9137,
      });
      if (result.ok) {
        expect(Number.isInteger(result.priceMinor)).toBe(true);
        expect(Number.isInteger(result.breakdown.landedCostMinor)).toBe(true);
      }
    }
  });

  it("is deterministic", () => {
    const input: PriceInput = {
      costMinor: 1337,
      costCurrency: "USD",
      market: DE,
      rule: rule({ rounding: "END_99", compareAtMultiplierBp: 14000 }),
      fxRateBp: 9213,
    };
    expect(calculatePrice(input)).toEqual(calculatePrice(input));
  });
});
