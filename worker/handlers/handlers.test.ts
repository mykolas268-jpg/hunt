import { describe, expect, it } from "vitest";
import { buildSourceText, summariseOptions } from "./generate-listing.js";
import { scoreCompleteness } from "./draft-compliance.js";
import { deriveOptions } from "./push-product.js";

describe("buildSourceText", () => {
  it("includes everything the model was shown", () => {
    // A claim quoting the category would be rejected as fabricated if the
    // category were omitted from the evidence haystack.
    const text = buildSourceText({
      title: "Cotton Blouse",
      description: "95% cotton",
      categoryPath: "Women Clothing > Blouses",
    });
    expect(text).toContain("Cotton Blouse");
    expect(text).toContain("Women Clothing > Blouses");
    expect(text).toContain("95% cotton");
  });

  it("skips absent parts without leaving blank lines", () => {
    expect(buildSourceText({ title: "T", description: null, categoryPath: null })).toBe("T");
  });
});

describe("summariseOptions", () => {
  it("summarises a multi-dimension matrix", () => {
    expect(
      summariseOptions([
        { optionValues: { Color: "Red", Size: "S" } },
        { optionValues: { Color: "Blue", Size: "M" } },
      ]),
    ).toBe("Color: Red, Blue; Size: S, M");
  });

  it("deduplicates repeated values", () => {
    expect(
      summariseOptions([
        { optionValues: { Color: "Red" } },
        { optionValues: { Color: "Red" } },
      ]),
    ).toBe("Color: Red");
  });

  it("describes a product with no options", () => {
    expect(summariseOptions([{ optionValues: {} }])).toBe("(single variant)");
  });

  it("tolerates malformed stored values", () => {
    expect(summariseOptions([{ optionValues: null }, { optionValues: "junk" }])).toBe("(single variant)");
  });
});

describe("scoreCompleteness", () => {
  it("reports EMPTY when nothing is supported", () => {
    expect(scoreCompleteness({
      manufacturerName: null, manufacturerAddress: null, warnings: null, safetyInstructions: null,
    })).toBe("EMPTY");
  });

  it("reports PARTIAL when some fields are present", () => {
    expect(scoreCompleteness({
      manufacturerName: "Ningbo Textile Co", manufacturerAddress: null,
      warnings: null, safetyInstructions: null,
    })).toBe("PARTIAL");
  });

  it("reports COMPLETE only when every required field is present", () => {
    expect(scoreCompleteness({
      manufacturerName: "A", manufacturerAddress: "B",
      warnings: "C", safetyInstructions: "D",
    })).toBe("COMPLETE");
  });

  it("treats an empty string as absent", () => {
    expect(scoreCompleteness({
      manufacturerName: "", manufacturerAddress: "", warnings: "", safetyInstructions: "",
    })).toBe("EMPTY");
  });
});

describe("deriveOptions", () => {
  it("rebuilds dimensions from stored variants", () => {
    expect(
      deriveOptions([
        { optionValues: { Color: "Red", Size: "S" } },
        { optionValues: { Color: "Red", Size: "M" } },
        { optionValues: { Color: "Blue", Size: "S" } },
      ]),
    ).toEqual([
      { name: "Color", values: ["Red", "Blue"] },
      { name: "Size", values: ["S", "M"] },
    ]);
  });

  it("preserves the supplier's value ordering", () => {
    // S, M, L is meaningful; alphabetising it to L, M, S is not.
    expect(
      deriveOptions([
        { optionValues: { Size: "S" } },
        { optionValues: { Size: "M" } },
        { optionValues: { Size: "L" } },
      ])[0]?.values,
    ).toEqual(["S", "M", "L"]);
  });

  it("returns nothing for variants with no options", () => {
    expect(deriveOptions([{ optionValues: {} }])).toEqual([]);
  });

  it("skips malformed rows rather than throwing", () => {
    expect(deriveOptions([{ optionValues: null }, { optionValues: { Color: "Red" } }])).toEqual([
      { name: "Color", values: ["Red"] },
    ]);
  });
});
