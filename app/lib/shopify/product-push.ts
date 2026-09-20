/**
 * Build and execute the Shopify product write.
 *
 * `productSet` creates or updates a product with its full option matrix and
 * variant list in one call, which matters when a supplier product has sixty
 * variants: the alternative is productCreate plus paginated
 * productVariantsBulkCreate, and a partial failure halfway through leaves the
 * merchant with half a product and no clear way back.
 *
 * The input builder is a pure function so the mapping — the part that is
 * fiddly and easy to get subtly wrong — is testable without a store.
 */

import { toDecimalString } from "../money.js";
import type { NormalizedOption } from "../../adapters/types.js";
import { assertNoUserErrors, type ShopifyGraphQLClient } from "./graphql-client.server.js";

export const PRODUCT_SET_MUTATION = /* GraphQL */ `
  mutation ProductSet($input: ProductSetInput!) {
    productSet(input: $input) {
      product {
        id
        handle
        status
        variants(first: 250) {
          nodes {
            id
            sku
            selectedOptions { name value }
            inventoryItem { id }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

export interface PushVariantInput {
  supplierVariantId: string;
  sku: string | null;
  optionValues: Record<string, string>;
  priceMinor: number;
  compareAtMinor: number | null;
  stockQty: number;
  weightGrams: number | null;
}

export interface BuildProductSetArgs {
  /** Existing Shopify product GID, when updating rather than creating. */
  shopifyProductId?: string | null;
  title: string;
  descriptionHtml: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  tags: string[];
  options: NormalizedOption[];
  variants: PushVariantInput[];
  imageUrls: string[];
  /** Shopify location GID for inventory. */
  locationId: string | null;
  productType?: string | null;
}

export interface ProductSetInput {
  id?: string;
  title: string;
  descriptionHtml?: string;
  status: "DRAFT";
  tags?: string[];
  productType?: string;
  seo?: { title?: string; description?: string };
  productOptions: Array<{ name: string; values: Array<{ name: string }> }>;
  variants: Array<Record<string, unknown>>;
  files?: Array<{ originalSource: string; contentType: "IMAGE" }>;
}

/** Shopify rejects products with more than three option dimensions. */
export const MAX_OPTION_DIMENSIONS = 3;
/** Practical ceiling per productSet call. */
export const MAX_VARIANTS = 250;

export class ProductPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductPushError";
  }
}

/**
 * Map normalized supplier data onto a `ProductSetInput`.
 *
 * Status is hard-coded to DRAFT and is not a parameter. Publishing to a live
 * storefront is the merchant's decision, made in Shopify, and an import tool
 * that can publish is one bug away from putting untranslated machine-generated
 * copy in front of real customers.
 */
export function buildProductSetInput(args: BuildProductSetArgs): ProductSetInput {
  if (args.variants.length === 0) {
    throw new ProductPushError("Cannot push a product with no variants.");
  }
  if (args.variants.length > MAX_VARIANTS) {
    throw new ProductPushError(
      `Product has ${args.variants.length} variants; Shopify accepts at most ${MAX_VARIANTS} per call.`,
    );
  }
  if (args.options.length > MAX_OPTION_DIMENSIONS) {
    throw new ProductPushError(
      `Product has ${args.options.length} option dimensions; Shopify accepts at most ${MAX_OPTION_DIMENSIONS}. ` +
        "Collapse or drop a dimension before pushing.",
    );
  }

  // Shopify requires every variant to name a value for every declared option.
  // A supplier matrix missing a combination would otherwise be rejected with
  // an opaque userError, so it is caught here with a message that says which.
  for (const variant of args.variants) {
    for (const option of args.options) {
      if (!variant.optionValues[option.name]) {
        throw new ProductPushError(
          `Variant ${variant.supplierVariantId} has no value for option "${option.name}".`,
        );
      }
    }
  }

  const input: ProductSetInput = {
    title: args.title,
    status: "DRAFT",
    productOptions:
      args.options.length > 0
        ? args.options.map((option) => ({
            name: option.name,
            values: option.values.map((value) => ({ name: value })),
          }))
        : // A product with no supplier options still needs one dimension.
          [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: args.variants.map((variant) => buildVariant(variant, args)),
  };

  if (args.shopifyProductId) input.id = args.shopifyProductId;
  if (args.descriptionHtml) input.descriptionHtml = args.descriptionHtml;
  if (args.tags.length > 0) input.tags = args.tags;
  if (args.productType) input.productType = args.productType;

  if (args.seoTitle || args.seoDescription) {
    input.seo = {};
    if (args.seoTitle) input.seo.title = args.seoTitle;
    if (args.seoDescription) input.seo.description = args.seoDescription;
  }

  if (args.imageUrls.length > 0) {
    input.files = args.imageUrls.map((url) => ({
      originalSource: url,
      contentType: "IMAGE" as const,
    }));
  }

  return input;
}

function buildVariant(
  variant: PushVariantInput,
  args: BuildProductSetArgs,
): Record<string, unknown> {
  const optionValues =
    args.options.length > 0
      ? args.options.map((option) => ({
          optionName: option.name,
          name: variant.optionValues[option.name] as string,
        }))
      : [{ optionName: "Title", name: "Default Title" }];

  const payload: Record<string, unknown> = {
    optionValues,
    price: toDecimalString(variant.priceMinor),
  };

  if (variant.sku) payload.sku = variant.sku;

  // A compare-at at or below the price reads as a price increase in the
  // storefront, so it is omitted rather than sent.
  if (variant.compareAtMinor != null && variant.compareAtMinor > variant.priceMinor) {
    payload.compareAtPrice = toDecimalString(variant.compareAtMinor);
  }

  const inventoryItem: Record<string, unknown> = { tracked: true };
  if (variant.weightGrams != null) {
    inventoryItem.measurement = {
      weight: { value: variant.weightGrams, unit: "GRAMS" },
    };
  }
  payload.inventoryItem = inventoryItem;

  // Without a location there is nowhere to record stock. Sending quantities
  // anyway produces a userError, so they are simply omitted and the merchant
  // is prompted to pick a location.
  if (args.locationId) {
    payload.inventoryQuantities = [
      {
        locationId: args.locationId,
        name: "available",
        quantity: Math.max(0, variant.stockQty),
      },
    ];
  }

  return payload;
}

export interface PushResult {
  shopifyProductId: string;
  handle: string;
  variantMappings: Array<{
    supplierVariantId: string;
    shopifyVariantId: string;
    shopifyInventoryItemId: string | null;
  }>;
  unmatchedVariants: string[];
}

interface ProductSetResponse {
  productSet: {
    product: {
      id: string;
      handle: string;
      status: string;
      variants: {
        nodes: Array<{
          id: string;
          sku: string | null;
          selectedOptions: Array<{ name: string; value: string }>;
          inventoryItem: { id: string } | null;
        }>;
      };
    } | null;
    userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>;
  };
}

/**
 * Execute the push and map Shopify's variant IDs back to supplier variants.
 *
 * The mapping is what makes monitoring possible later: without it there is no
 * way to know which Shopify variant to reprice when a supplier cost moves.
 */
export async function pushProduct(
  client: ShopifyGraphQLClient,
  args: BuildProductSetArgs,
): Promise<PushResult> {
  const input = buildProductSetInput(args);
  const response = await client.request<ProductSetResponse>(PRODUCT_SET_MUTATION, { input });

  // Shopify reports business-rule failures inside an HTTP 200. Skipping this
  // check is how a push that created nothing reports success.
  assertNoUserErrors(response.productSet, "productSet");

  const product = response.productSet.product;
  if (!product) {
    throw new ProductPushError("productSet returned no product and no userErrors.");
  }

  return {
    shopifyProductId: product.id,
    handle: product.handle,
    ...matchVariants(args, product.variants.nodes),
  };
}

/**
 * Match returned Shopify variants back to supplier variants.
 *
 * Matching is by option-value combination rather than by SKU, because supplier
 * SKUs are frequently absent or duplicated, whereas the option combination is
 * unique by construction — Shopify will not accept two variants sharing one.
 */
function matchVariants(
  args: BuildProductSetArgs,
  nodes: ProductSetResponse["productSet"]["product"] extends null
    ? never
    : Array<{
        id: string;
        sku: string | null;
        selectedOptions: Array<{ name: string; value: string }>;
        inventoryItem: { id: string } | null;
      }>,
): { variantMappings: PushResult["variantMappings"]; unmatchedVariants: string[] } {
  const byKey = new Map<string, (typeof nodes)[number]>();
  for (const node of nodes) {
    byKey.set(optionKey(Object.fromEntries(node.selectedOptions.map((o) => [o.name, o.value]))), node);
  }

  const variantMappings: PushResult["variantMappings"] = [];
  const unmatchedVariants: string[] = [];

  for (const variant of args.variants) {
    const key =
      args.options.length > 0
        ? optionKey(variant.optionValues)
        : optionKey({ Title: "Default Title" });
    const node = byKey.get(key);

    if (!node) {
      unmatchedVariants.push(variant.supplierVariantId);
      continue;
    }

    variantMappings.push({
      supplierVariantId: variant.supplierVariantId,
      shopifyVariantId: node.id,
      shopifyInventoryItemId: node.inventoryItem?.id ?? null,
    });
  }

  return { variantMappings, unmatchedVariants };
}

/** Order-independent key for an option-value combination. */
function optionKey(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join("|");
}
