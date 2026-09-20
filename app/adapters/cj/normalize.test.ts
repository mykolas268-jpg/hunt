import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SupplierError } from "../types.js";
import { buildOptions, deriveOptionNames, normalizeProduct, splitVariantKey, toMinorUnits } from "./normalize.js";
import { cjProductResponse, type CjProduct, type CjVariant } from "./schemas.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../spikes/fixtures/cj-product-24-variants.json", import.meta.url), "utf8"),
);

function variant(overrides: Partial<CjVariant> = {}): CjVariant {
  return { vid: "V1", variantSellPrice: 10, variantKey: "Red-S", ...overrides } as CjVariant;
}

function product(overrides: Partial<CjProduct> = {}): CjProduct {
  return {
    pid: "P1",
    productNameEn: "Test Product",
    variants: [variant()],
    ...overrides,
  } as CjProduct;
}

describe("schema validation", () => {
  it("parses the fixture envelope", () => {
    const parsed = cjProductResponse.parse(fixture);
    expect(parsed.code).toBe(200);
    expect(parsed.data?.variants).toHaveLength(24);
  });

  it("accepts prices as strings or numbers", () => {
    expect(cjProductResponse.parse({
      code: 200,
      data: { pid: "P1", productNameEn: "x", variants: [{ vid: "V1", variantSellPrice: "12.34" }] },
    }).data?.variants?.[0]?.variantSellPrice).toBe(12.34);
  });

  it("tolerates unknown fields the supplier adds without warning", () => {
    const parsed = cjProductResponse.parse({
      code: 200,
      data: { pid: "P1", productNameEn: "x", brandNewField: true, variants: [{ vid: "V1", variantSellPrice: 1 }] },
    });
    expect(parsed.data?.pid).toBe("P1");
  });

  it("rejects a variant with no id", () => {
    expect(() =>
      cjProductResponse.parse({ code: 200, data: { pid: "P1", variants: [{ variantSellPrice: 1 }] } }),
    ).toThrow();
  });

  it("rejects a non-numeric price rather than coercing it to zero", () => {
    expect(() =>
      cjProductResponse.parse({ code: 200, data: { pid: "P1", variants: [{ vid: "V1", variantSellPrice: "free" }] } }),
    ).toThrow();
  });
});

describe("toMinorUnits", () => {
  it("avoids the binary float trap", () => {
    // 12.34 * 100 evaluates to 1233.9999999999998 in IEEE 754.
    expect(toMinorUnits(12.34)).toBe(1234);
    expect(toMinorUnits(1.1)).toBe(110);
    expect(toMinorUnits(0.07)).toBe(7);
  });
  it("handles whole numbers and zero", () => {
    expect(toMinorUnits(10)).toBe(1000);
    expect(toMinorUnits(0)).toBe(0);
  });
  it("rejects negative and non-finite prices", () => {
    expect(() => toMinorUnits(-1)).toThrow(SupplierError);
    expect(() => toMinorUnits(Number.NaN)).toThrow(SupplierError);
  });
});

describe("splitVariantKey", () => {
  it("splits on hyphen", () => expect(splitVariantKey("Red-XL")).toEqual(["Red", "XL"]));
  it("splits on slash", () => expect(splitVariantKey("Red/XL")).toEqual(["Red", "XL"]));
  it("trims whitespace", () => expect(splitVariantKey(" Red - XL ")).toEqual(["Red", "XL"]));
  it("handles a single dimension", () => expect(splitVariantKey("Red")).toEqual(["Red"]));
  it("returns empty for absent keys", () => {
    expect(splitVariantKey(null)).toEqual([]);
    expect(splitVariantKey("")).toEqual([]);
  });
});

describe("deriveOptionNames", () => {
  it("reads names from variantStandard when present", () => {
    const names = deriveOptionNames([variant({ variantStandard: "Color:Red;Size:XL" })], 2);
    expect(names).toEqual(["Color", "Size"]);
  });

  it("falls back to neutral positional labels", () => {
    // A wrong-but-plausible name like "Color" may never be noticed; a neutral
    // one is visibly a placeholder the merchant will fix.
    expect(deriveOptionNames([variant()], 2)).toEqual(["Option 1", "Option 2"]);
  });

  it("ignores metadata whose arity does not match", () => {
    const names = deriveOptionNames([variant({ variantStandard: "Color:Red" })], 2);
    expect(names).toEqual(["Option 1", "Option 2"]);
  });
});

describe("buildOptions", () => {
  it("reconstructs a two-dimension matrix", () => {
    const { options } = buildOptions([
      variant({ vid: "A", variantKey: "Red-S", variantStandard: "Color:Red;Size:S" }),
      variant({ vid: "B", variantKey: "Red-M", variantStandard: "Color:Red;Size:M" }),
      variant({ vid: "C", variantKey: "Blue-S", variantStandard: "Color:Blue;Size:S" }),
    ]);
    expect(options).toEqual([
      { name: "Color", values: ["Red", "Blue"] },
      { name: "Size", values: ["S", "M"] },
    ]);
  });

  it("preserves the supplier's value ordering", () => {
    // S, M, L is meaningful; alphabetising it to L, M, S is not.
    const { options } = buildOptions([
      variant({ vid: "A", variantKey: "S" }),
      variant({ vid: "B", variantKey: "M" }),
      variant({ vid: "C", variantKey: "L" }),
    ]);
    expect(options[0]?.values).toEqual(["S", "M", "L"]);
  });

  it("pads a ragged matrix instead of dropping variants", () => {
    const { options, valuesByVariant } = buildOptions([
      variant({ vid: "A", variantKey: "Red-S" }),
      variant({ vid: "B", variantKey: "Blue" }),
    ]);
    expect(options).toHaveLength(2);
    // Dropping B would lose sellable inventory.
    expect(valuesByVariant.get("B")).toEqual({ "Option 1": "Blue", "Option 2": "Default" });
  });

  it("returns no options for a keyless single variant", () => {
    const { options } = buildOptions([variant({ variantKey: null, variantNameEn: null, variantName: null })]);
    expect(options).toEqual([]);
  });
});

describe("normalizeProduct", () => {
  it("normalizes the 24-variant fixture end to end", () => {
    const parsed = cjProductResponse.parse(fixture);
    const result = normalizeProduct(parsed.data as CjProduct);

    expect(result.provider).toBe("CJ");
    expect(result.supplierProductId).toBe("PID-DEMO-1");
    expect(result.variants).toHaveLength(24);
    expect(result.options).toEqual([
      { name: "Color", values: ["Red", "Blue", "Black", "Beige"] },
      { name: "Size", values: ["S", "M", "L", "XL", "XXL", "3XL"] },
    ]);
    // 4 colours x 6 sizes must account for every variant exactly once.
    const combos = new Set(result.variants.map((v) => JSON.stringify(v.optionValues)));
    expect(combos.size).toBe(24);
  });

  it("prefers the English title over the untranslated original", () => {
    const parsed = cjProductResponse.parse(fixture);
    const result = normalizeProduct(parsed.data as CjProduct);
    expect(result.title).toContain("Women Shirt");
  });

  it("converts prices to integer minor units", () => {
    const result = normalizeProduct(product({ variants: [variant({ variantSellPrice: 7.63 })] }));
    expect(result.variants[0]?.costMinor).toBe(763);
    expect(Number.isInteger(result.variants[0]?.costMinor)).toBe(true);
  });

  it("defaults cost currency to USD and honours an override", () => {
    expect(normalizeProduct(product()).variants[0]?.costCurrency).toBe("USD");
    expect(normalizeProduct(product(), { costCurrency: "EUR" }).variants[0]?.costCurrency).toBe("EUR");
  });

  it("reports unknown stock as zero, not as availability", () => {
    // The product endpoint carries no stock; publishing 0 as "out of stock"
    // would be wrong, so the import job must call the stock endpoint.
    expect(normalizeProduct(product()).variants[0]?.stockQty).toBe(0);
  });

  it("falls back to product weight when a variant has none", () => {
    const result = normalizeProduct(
      product({ productWeight: 500, variants: [variant({ variantWeight: null })] }),
    );
    expect(result.variants[0]?.weightGrams).toBe(500);
  });

  it("deduplicates images while preserving order", () => {
    const result = normalizeProduct(
      product({ productImage: "a.jpg", productImageSet: ["a.jpg", "b.jpg"] }),
    );
    expect(result.imageUrls).toEqual(["a.jpg", "b.jpg"]);
  });

  it("retains the raw payload for debugging schema drift", () => {
    const input = product();
    expect(normalizeProduct(input).raw).toBe(input);
  });

  it("rejects a product with no variants", () => {
    expect(() => normalizeProduct(product({ variants: [] }))).toThrow(/no variants/);
  });

  it("rejects duplicate variant ids", () => {
    expect(() =>
      normalizeProduct(product({ variants: [variant({ vid: "X" }), variant({ vid: "X" })] })),
    ).toThrow(/duplicate variant id/);
  });

  it("rejects a product with no usable title", () => {
    expect(() =>
      normalizeProduct(product({ productNameEn: null, productName: null })),
    ).toThrow(/no usable title/);
  });
});
