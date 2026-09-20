import { describe, expect, it } from "vitest";
import { screenListing, stripUnevidencedFields, type ScreenableListing } from "./guardrails.js";

const SOURCE =
  "Women Shirt Loose Casual Long Sleeve Blouse. Material: 95% cotton 5% elastane. " +
  "Weight 240g. Machine washable at 30 degrees. Made in China by Ningbo Textile Co, " +
  "12 Industrial Road, Ningbo. Contact: support@ningbotextile.example.";

function listing(overrides: Partial<ScreenableListing> = {}): ScreenableListing {
  return {
    title: "Relaxed Cotton Blouse for Everyday Comfort",
    descriptionHtml: "<p>A soft cotton blouse that moves with you through a long day.</p>",
    bullets: [
      "Breathable cotton blend keeps you cool",
      "Relaxed cut that flatters every shape",
      "Machine washable for easy care",
      "Long sleeves for cooler evenings",
      "Pairs easily with jeans or tailoring",
    ],
    seoTitle: "Relaxed Cotton Blouse",
    seoDescription: "A soft, breathable cotton blouse cut for comfort and easy everyday wear.",
    tags: ["blouse", "cotton", "womens top"],
    claims: [],
    ...overrides,
  };
}

describe("clean copy", () => {
  it("passes a compliant listing", () => {
    expect(screenListing(listing(), SOURCE)).toEqual([]);
  });
});

describe("medical claims", () => {
  const cases: Array<[string, string]> = [
    ["cures", "This shirt cures back pain"],
    ["treats", "Treats eczema naturally"],
    ["heals", "Helps heal irritated skin"],
    ["prevents disease", "Prevents infection all day"],
    ["regulatory approval", "FDA approved fabric"],
    ["medical grade", "Medical grade cotton"],
    ["antibacterial", "Antibacterial finish"],
    ["clinically proven", "Clinically proven comfort"],
    ["symptom relief", "Relieves pain instantly"],
    ["detox", "Detoxifying fibres"],
    ["immunity", "Boosts immunity while you wear it"],
  ];

  it.each(cases)("flags %s", (_label, text) => {
    const violations = screenListing(listing({ title: text }), SOURCE);
    expect(violations.some((v) => v.kind === "MEDICAL_CLAIM")).toBe(true);
  });

  it("flags non-English medical claims", () => {
    expect(
      screenListing(listing({ seoDescription: "Dieses Produkt heilt Rückenschmerzen dauerhaft." }), SOURCE)
        .some((v) => v.kind === "MEDICAL_CLAIM"),
    ).toBe(true);
  });

  it("screens every field, not just the title", () => {
    const violations = screenListing(
      listing({ bullets: ["Antibacterial coating", "b", "c", "d", "e"] }),
      SOURCE,
    );
    expect(violations.find((v) => v.kind === "MEDICAL_CLAIM")?.field).toBe("bullets[0]");
  });
});

describe("trademarks", () => {
  it("flags a brand in the title", () => {
    expect(
      screenListing(listing({ title: "Case for iPhone 15 Pro Max" }), SOURCE)
        .some((v) => v.kind === "TRADEMARK"),
    ).toBe(true);
  });

  it("flags a brand in tags", () => {
    expect(
      screenListing(listing({ tags: ["blouse", "nike", "cotton"] }), SOURCE)
        .some((v) => v.kind === "TRADEMARK"),
    ).toBe(true);
  });

  it("respects word boundaries", () => {
    // "applesauce" must not trip the Apple rule.
    expect(
      screenListing(listing({ title: "Applesauce Storage Jar with Lid" }), SOURCE)
        .some((v) => v.kind === "TRADEMARK"),
    ).toBe(false);
  });

  it("allows brands the merchant is authorised to sell", () => {
    expect(
      screenListing(listing({ title: "Official Nike Running Sock" }), SOURCE, {
        allowedTrademarks: ["nike"],
      }).some((v) => v.kind === "TRADEMARK"),
    ).toBe(false);
  });

  it("accepts shop-specific additions to the deny-list", () => {
    expect(
      screenListing(listing({ title: "Acme Widget Holder" }), SOURCE, { extraTrademarks: ["acme"] })
        .some((v) => v.kind === "TRADEMARK"),
    ).toBe(true);
  });
});

describe("unverifiable absolutes", () => {
  it.each([
    ["100% guaranteed waterproof"],
    ["The best in the world"],
    ["#1 best selling blouse"],
    ["Lifetime warranty included"],
    ["Unbreakable stitching"],
    ["Risk-free purchase"],
    ["Money-back guarantee"],
  ])("flags %s", (text) => {
    expect(
      screenListing(listing({ seoDescription: `${text} for everyday comfort and easy wear.` }), SOURCE)
        .some((v) => v.kind === "UNVERIFIABLE_ABSOLUTE"),
    ).toBe(true);
  });
});

describe("HTML safety", () => {
  it("rejects a script tag", () => {
    const violations = screenListing(
      listing({ descriptionHtml: "<p>Nice</p><script>alert(1)</script>" }),
      SOURCE,
    );
    expect(violations.some((v) => v.kind === "FORMATTING")).toBe(true);
  });

  it("rejects an inline event handler", () => {
    expect(
      screenListing(listing({ descriptionHtml: '<p onclick="steal()">Nice shirt here</p>' }), SOURCE)
        .some((v) => v.kind === "FORMATTING"),
    ).toBe(true);
  });

  it("rejects tags outside the allow-list", () => {
    expect(
      screenListing(listing({ descriptionHtml: "<p>Text</p><iframe src=x></iframe>" }), SOURCE)
        .some((v) => v.match.includes("iframe")),
    ).toBe(true);
  });

  it("permits the allowed formatting tags", () => {
    expect(
      screenListing(
        listing({ descriptionHtml: "<p>Soft <strong>cotton</strong></p><ul><li>Light</li></ul>" }),
        SOURCE,
      ),
    ).toEqual([]);
  });
});

describe("claim evidence", () => {
  it("accepts a claim quoting the supplier data", () => {
    expect(
      screenListing(
        listing({ claims: [{ claim: "95% cotton", evidence: "Material: 95% cotton 5% elastane" }] }),
        SOURCE,
      ),
    ).toEqual([]);
  });

  it("tolerates whitespace and case differences in the quote", () => {
    expect(
      screenListing(
        listing({ claims: [{ claim: "cotton blend", evidence: "material:  95% COTTON 5% elastane" }] }),
        SOURCE,
      ),
    ).toEqual([]);
  });

  it("rejects an invented specification", () => {
    // The model claiming waterproofing the source never mentioned is the exact
    // failure this check exists for.
    const violations = screenListing(
      listing({ claims: [{ claim: "Fully waterproof", evidence: "Waterproof rating IPX7" }] }),
      SOURCE,
    );
    expect(violations.some((v) => v.kind === "UNSUPPORTED_CLAIM")).toBe(true);
  });

  it("reports every violation rather than stopping at the first", () => {
    const violations = screenListing(
      listing({
        title: "Nike medical grade shirt",
        claims: [{ claim: "waterproof", evidence: "not in source" }],
      }),
      SOURCE,
    );
    const kinds = new Set(violations.map((v) => v.kind));
    expect(kinds.has("TRADEMARK")).toBe(true);
    expect(kinds.has("MEDICAL_CLAIM")).toBe(true);
    expect(kinds.has("UNSUPPORTED_CLAIM")).toBe(true);
  });
});

describe("stripUnevidencedFields", () => {
  const REQUIRED = ["manufacturerName", "manufacturerAddress", "warnings"] as const;

  it("keeps fields whose evidence is in the source", () => {
    const { cleaned, dropped } = stripUnevidencedFields(
      {
        manufacturerName: "Ningbo Textile Co",
        manufacturerAddress: null,
        warnings: null,
        evidence: { manufacturerName: "Made in China by Ningbo Textile Co" },
      },
      REQUIRED,
      SOURCE,
    );
    expect(cleaned.manufacturerName).toBe("Ningbo Textile Co");
    expect(dropped).toEqual([]);
  });

  it("drops a fabricated manufacturer address", () => {
    // A plausible invented address is a false regulatory declaration that may
    // never be questioned. Nulling it makes the gap visible instead.
    const { cleaned, dropped } = stripUnevidencedFields(
      {
        manufacturerName: null,
        manufacturerAddress: "42 Fictional Street, Berlin, Germany",
        warnings: null,
        evidence: { manufacturerAddress: "42 Fictional Street, Berlin" },
      },
      REQUIRED,
      SOURCE,
    );
    expect(cleaned.manufacturerAddress).toBeNull();
    expect(dropped).toEqual(["manufacturerAddress"]);
  });

  it("drops a populated field with no evidence entry at all", () => {
    const { cleaned, dropped } = stripUnevidencedFields(
      { manufacturerName: null, manufacturerAddress: null, warnings: "Keep away from fire", evidence: {} },
      REQUIRED,
      SOURCE,
    );
    expect(cleaned.warnings).toBeNull();
    expect(dropped).toEqual(["warnings"]);
  });

  it("leaves already-null fields alone", () => {
    const { dropped } = stripUnevidencedFields(
      { manufacturerName: null, manufacturerAddress: null, warnings: null, evidence: {} },
      REQUIRED,
      SOURCE,
    );
    expect(dropped).toEqual([]);
  });
});
