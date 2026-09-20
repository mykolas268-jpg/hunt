import { describe, expect, it, vi } from "vitest";
import type { NormalizedOption } from "../../adapters/types.js";
import type { ShopifyGraphQLClient } from "./graphql-client.server.js";
import {
  buildProductSetInput,
  ProductPushError,
  pushProduct,
  type BuildProductSetArgs,
  type PushVariantInput,
} from "./product-push.js";

const OPTIONS: NormalizedOption[] = [
  { name: "Color", values: ["Red", "Blue"] },
  { name: "Size", values: ["S", "M"] },
];

function variant(overrides: Partial<PushVariantInput> = {}): PushVariantInput {
  return {
    supplierVariantId: "V1",
    sku: "SKU-1",
    optionValues: { Color: "Red", Size: "S" },
    priceMinor: 3599,
    compareAtMinor: null,
    stockQty: 12,
    weightGrams: 240,
    ...overrides,
  };
}

function args(overrides: Partial<BuildProductSetArgs> = {}): BuildProductSetArgs {
  return {
    title: "Relaxed Cotton Blouse",
    descriptionHtml: "<p>Soft everyday blouse.</p>",
    seoTitle: "Cotton Blouse",
    seoDescription: "Soft breathable cotton blouse for everyday wear.",
    tags: ["blouse", "cotton"],
    options: OPTIONS,
    variants: [variant()],
    imageUrls: ["https://cdn.example.com/a.jpg"],
    locationId: "gid://shopify/Location/1",
    ...overrides,
  };
}

describe("buildProductSetInput", () => {
  it("always creates as DRAFT", () => {
    // Publishing is the merchant's decision, made in Shopify. An import tool
    // that can publish is one bug from putting machine-translated copy live.
    expect(buildProductSetInput(args()).status).toBe("DRAFT");
  });

  it("maps option dimensions and values", () => {
    expect(buildProductSetInput(args()).productOptions).toEqual([
      { name: "Color", values: [{ name: "Red" }, { name: "Blue" }] },
      { name: "Size", values: [{ name: "S" }, { name: "M" }] },
    ]);
  });

  it("renders prices as decimal strings, not numbers", () => {
    const built = buildProductSetInput(args());
    expect(built.variants[0]?.price).toBe("35.99");
    expect(typeof built.variants[0]?.price).toBe("string");
  });

  it("includes a compare-at above the price", () => {
    const built = buildProductSetInput(args({ variants: [variant({ compareAtMinor: 5399 })] }));
    expect(built.variants[0]?.compareAtPrice).toBe("53.99");
  });

  it("omits a compare-at at or below the price", () => {
    // A compare-at under the price reads as a price increase in the storefront.
    expect(
      buildProductSetInput(args({ variants: [variant({ compareAtMinor: 3599 })] })).variants[0],
    ).not.toHaveProperty("compareAtPrice");
    expect(
      buildProductSetInput(args({ variants: [variant({ compareAtMinor: 1000 })] })).variants[0],
    ).not.toHaveProperty("compareAtPrice");
  });

  it("sets inventory quantities at the given location", () => {
    const built = buildProductSetInput(args());
    expect(built.variants[0]?.inventoryQuantities).toEqual([
      { locationId: "gid://shopify/Location/1", name: "available", quantity: 12 },
    ]);
  });

  it("omits inventory quantities when no location is configured", () => {
    // Sending quantities with no location produces an opaque userError.
    const built = buildProductSetInput(args({ locationId: null }));
    expect(built.variants[0]).not.toHaveProperty("inventoryQuantities");
  });

  it("never sends a negative quantity", () => {
    const built = buildProductSetInput(args({ variants: [variant({ stockQty: -5 })] }));
    expect((built.variants[0]?.inventoryQuantities as any[])[0].quantity).toBe(0);
  });

  it("carries weight onto the inventory item", () => {
    expect(buildProductSetInput(args()).variants[0]?.inventoryItem).toEqual({
      tracked: true,
      measurement: { weight: { value: 240, unit: "GRAMS" } },
    });
  });

  it("includes the existing product id when updating", () => {
    expect(
      buildProductSetInput(args({ shopifyProductId: "gid://shopify/Product/9" })).id,
    ).toBe("gid://shopify/Product/9");
  });

  it("omits the id when creating", () => {
    expect(buildProductSetInput(args())).not.toHaveProperty("id");
  });

  it("maps SEO fields", () => {
    expect(buildProductSetInput(args()).seo).toEqual({
      title: "Cotton Blouse",
      description: "Soft breathable cotton blouse for everyday wear.",
    });
  });

  it("omits seo entirely when neither field is set", () => {
    expect(buildProductSetInput(args({ seoTitle: null, seoDescription: null }))).not.toHaveProperty("seo");
  });

  it("maps images to file inputs", () => {
    expect(buildProductSetInput(args()).files).toEqual([
      { originalSource: "https://cdn.example.com/a.jpg", contentType: "IMAGE" },
    ]);
  });

  it("synthesises a Title option for a product with no dimensions", () => {
    // Shopify requires at least one option dimension.
    const built = buildProductSetInput(
      args({ options: [], variants: [variant({ optionValues: {} })] }),
    );
    expect(built.productOptions).toEqual([{ name: "Title", values: [{ name: "Default Title" }] }]);
    expect(built.variants[0]?.optionValues).toEqual([
      { optionName: "Title", name: "Default Title" },
    ]);
  });

  it("rejects a product with no variants", () => {
    expect(() => buildProductSetInput(args({ variants: [] }))).toThrow(ProductPushError);
  });

  it("rejects more than three option dimensions with a usable message", () => {
    const four = ["A", "B", "C", "D"].map((n) => ({ name: n, values: ["x"] }));
    expect(() =>
      buildProductSetInput(args({
        options: four,
        variants: [variant({ optionValues: { A: "x", B: "x", C: "x", D: "x" } })],
      })),
    ).toThrow(/at most 3/);
  });

  it("rejects more than 250 variants", () => {
    const many = Array.from({ length: 251 }, (_, i) =>
      variant({ supplierVariantId: `V${i}`, optionValues: { Color: "Red", Size: `S${i}` } }),
    );
    expect(() => buildProductSetInput(args({ variants: many }))).toThrow(/at most 250/);
  });

  it("names the variant and option when a combination is incomplete", () => {
    // Shopify would reject this with an opaque error; saying which variant and
    // which option is the difference between a fixable report and a shrug.
    expect(() =>
      buildProductSetInput(args({
        variants: [variant({ supplierVariantId: "V42", optionValues: { Color: "Red" } })],
      })),
    ).toThrow(/Variant V42 has no value for option "Size"/);
  });
});

describe("pushProduct", () => {
  function fakeClient(response: unknown): ShopifyGraphQLClient {
    return { request: vi.fn().mockResolvedValue(response) } as unknown as ShopifyGraphQLClient;
  }

  const twoVariants = [
    variant({ supplierVariantId: "VA", optionValues: { Color: "Red", Size: "S" } }),
    variant({ supplierVariantId: "VB", optionValues: { Color: "Blue", Size: "M" } }),
  ];

  const okResponse = {
    productSet: {
      product: {
        id: "gid://shopify/Product/1",
        handle: "relaxed-cotton-blouse",
        status: "DRAFT",
        variants: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/11",
              sku: "SKU-1",
              selectedOptions: [{ name: "Color", value: "Red" }, { name: "Size", value: "S" }],
              inventoryItem: { id: "gid://shopify/InventoryItem/21" },
            },
            {
              id: "gid://shopify/ProductVariant/12",
              sku: "SKU-1",
              selectedOptions: [{ name: "Size", value: "M" }, { name: "Color", value: "Blue" }],
              inventoryItem: { id: "gid://shopify/InventoryItem/22" },
            },
          ],
        },
      },
      userErrors: [],
    },
  };

  it("returns the product and maps variants back to supplier ids", async () => {
    const result = await pushProduct(fakeClient(okResponse), args({ variants: twoVariants }));

    expect(result.shopifyProductId).toBe("gid://shopify/Product/1");
    expect(result.variantMappings).toEqual([
      { supplierVariantId: "VA", shopifyVariantId: "gid://shopify/ProductVariant/11", shopifyInventoryItemId: "gid://shopify/InventoryItem/21" },
      { supplierVariantId: "VB", shopifyVariantId: "gid://shopify/ProductVariant/12", shopifyInventoryItemId: "gid://shopify/InventoryItem/22" },
    ]);
    expect(result.unmatchedVariants).toEqual([]);
  });

  it("matches on option combination regardless of field order", async () => {
    // Shopify returns selectedOptions in its own order; the second variant
    // above lists Size before Color.
    const result = await pushProduct(fakeClient(okResponse), args({ variants: twoVariants }));
    expect(result.variantMappings[1]?.supplierVariantId).toBe("VB");
  });

  it("matches on options rather than SKU, since supplier SKUs repeat", async () => {
    // Both returned variants share SKU-1. SKU matching would collapse them.
    const result = await pushProduct(fakeClient(okResponse), args({ variants: twoVariants }));
    expect(new Set(result.variantMappings.map((m) => m.shopifyVariantId)).size).toBe(2);
  });

  it("reports variants Shopify did not return instead of silently dropping them", async () => {
    const withExtra = [...twoVariants, variant({ supplierVariantId: "VC", optionValues: { Color: "Red", Size: "M" } })];
    const result = await pushProduct(fakeClient(okResponse), args({ variants: withExtra }));
    expect(result.unmatchedVariants).toEqual(["VC"]);
  });

  it("throws on userErrors delivered inside an HTTP 200", async () => {
    const failing = {
      productSet: {
        product: null,
        userErrors: [{ field: ["input", "variants"], message: "Option value does not exist", code: "INVALID" }],
      },
    };
    await expect(pushProduct(fakeClient(failing), args())).rejects.toThrow(/Option value does not exist/);
  });

  it("throws when Shopify returns neither a product nor an error", async () => {
    await expect(
      pushProduct(fakeClient({ productSet: { product: null, userErrors: [] } }), args()),
    ).rejects.toThrow(/no product and no userErrors/);
  });

  it("sends the built input as the mutation variable", async () => {
    const client = fakeClient(okResponse);
    await pushProduct(client, args({ variants: twoVariants }));

    const [, variables] = (client.request as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, any];
    expect(variables.input.status).toBe("DRAFT");
    expect(variables.input.variants).toHaveLength(2);
  });
});
