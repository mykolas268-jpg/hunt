/**
 * Price the variants and push the product to Shopify as a draft.
 *
 * Pricing happens here rather than at import, because a price depends on the
 * market (VAT, currency) and on FX rates that move daily. Computing it once at
 * import would freeze a number that is wrong within a week.
 */

import type { PrismaClient } from "@prisma/client";
import type { NormalizedOption } from "../../app/adapters/types.js";
import { resolveRateBp } from "../../app/lib/pricing/fx.js";
import {
  calculatePrice,
  type PricingRuleInput,
  type PriceResult,
} from "../../app/lib/pricing/engine.js";
import { pushProduct, type PushVariantInput } from "../../app/lib/shopify/product-push.js";
import { ShopifyGraphQLClient } from "../../app/lib/shopify/graphql-client.server.js";
import type { JobPayload } from "../../app/lib/queue/jobs.js";
import { loadLatestRates } from "./fx-refresh.js";

export interface PricingFailure {
  supplierVariantId: string;
  code: string;
  message: string;
}

/**
 * Rebuild the option matrix from stored variants.
 *
 * Stored as a per-variant map rather than a product-level list, because the
 * supplier is the source of truth and a variant can be discontinued
 * independently — which may remove a value from a dimension entirely.
 */
export function deriveOptions(
  variants: Array<{ optionValues: unknown }>,
): NormalizedOption[] {
  const byOption = new Map<string, string[]>();

  for (const variant of variants) {
    const values = variant.optionValues as Record<string, string> | null;
    if (!values || typeof values !== "object") continue;

    for (const [name, value] of Object.entries(values)) {
      const list = byOption.get(name) ?? [];
      // Insertion order is the supplier's order, which is usually meaningful
      // (S, M, L rather than alphabetical).
      if (!list.includes(String(value))) list.push(String(value));
      byOption.set(name, list);
    }
  }

  return Array.from(byOption.entries()).map(([name, values]) => ({ name, values }));
}

export async function pushProductToShopify(
  prisma: PrismaClient,
  payload: JobPayload<"product.push">,
  clientFactory?: (shop: string, token: string) => ShopifyGraphQLClient,
): Promise<{ shopifyProductId: string; pricingFailures: PricingFailure[]; unmatched: string[] }> {
  const { shopId, productId, marketId } = payload;

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      supplierProduct: { include: { variants: true } },
      pricingRule: { include: { tiers: true } },
      listings: { where: { marketId } },
    },
  });
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });

  if (!product || !market || !shop) {
    throw new Error(`Missing product ${productId}, market ${marketId} or shop ${shopId}`);
  }

  const listing = product.listings[0];
  if (!listing || listing.status === "PENDING" || listing.status === "FAILED") {
    throw new Error(`Listing for product ${productId} in market ${marketId} is not ready to push.`);
  }

  const rule: PricingRuleInput = product.pricingRule
    ? {
        multiplierBp: product.pricingRule.multiplierBp,
        fixedFeeMinor: product.pricingRule.fixedFeeMinor,
        rounding: product.pricingRule.rounding,
        compareAtMultiplierBp: product.pricingRule.compareAtMultiplierBp,
        minMarginMinor: product.pricingRule.minMarginMinor,
        includeShipping: product.pricingRule.includeShipping,
        vatHandling: product.pricingRule.vatHandling,
        tiers: product.pricingRule.tiers.map((tier) => ({
          minCostMinor: tier.minCostMinor,
          maxCostMinor: tier.maxCostMinor,
          multiplierBp: tier.multiplierBp,
          fixedFeeMinor: tier.fixedFeeMinor,
        })),
      }
    : // A shop with no rule yet gets a conservative default rather than an
      // error, so the first push is not blocked on configuration.
      {
        multiplierBp: 25000, fixedFeeMinor: 0, rounding: "END_99",
        compareAtMultiplierBp: null, minMarginMinor: 0,
        includeShipping: false, vatHandling: "ADD_VAT",
      };

  const eurRates = await loadLatestRates(prisma);
  const active = product.supplierProduct.variants.filter((v) => !v.discontinuedAt);
  if (active.length === 0) {
    throw new Error(`Product ${productId} has no active supplier variants to push.`);
  }

  const pricingFailures: PricingFailure[] = [];
  const pushVariants: PushVariantInput[] = [];

  for (const variant of active) {
    const fxRateBp = resolveRateBp(variant.costCurrency, market.currencyCode, { eurRates });

    const priced: PriceResult = calculatePrice({
      costMinor: variant.costMinor,
      costCurrency: variant.costCurrency,
      market: { currencyCode: market.currencyCode, vatRateBp: market.vatRateBp },
      rule,
      fxRateBp,
    });

    if (!priced.ok) {
      // A variant that cannot be priced is skipped and reported, never pushed
      // at a guessed price. The merchant decides what to do about it.
      pricingFailures.push({
        supplierVariantId: variant.supplierVariantId,
        code: priced.code,
        message: priced.message,
      });
      continue;
    }

    pushVariants.push({
      supplierVariantId: variant.supplierVariantId,
      sku: variant.sku,
      optionValues: (variant.optionValues as Record<string, string>) ?? {},
      priceMinor: priced.priceMinor,
      compareAtMinor: priced.compareAtMinor,
      stockQty: variant.stockQty,
      weightGrams: variant.weightGrams,
    });
  }

  if (pushVariants.length === 0) {
    throw new Error(
      `No variant of product ${productId} could be priced: ${pricingFailures.map((f) => f.message).join("; ")}`,
    );
  }

  const session = await prisma.session.findFirst({ where: { shop: shop.shopDomain } });
  if (!session) {
    throw new Error(`No Shopify session for ${shop.shopDomain}; the app may have been uninstalled.`);
  }

  const client =
    clientFactory?.(shop.shopDomain, session.accessToken) ??
    new ShopifyGraphQLClient({ shop: shop.shopDomain, accessToken: session.accessToken });

  await prisma.product.update({ where: { id: productId }, data: { status: "PUSHING" } });

  try {
    const result = await pushProduct(client, {
      shopifyProductId: product.shopifyProductId,
      title: listing.title ?? product.supplierProduct.titleRaw,
      descriptionHtml: listing.descriptionHtml,
      seoTitle: listing.seoTitle,
      seoDescription: listing.seoDescription,
      tags: listing.tags,
      options: deriveOptions(active),
      variants: pushVariants,
      imageUrls: product.supplierProduct.imageUrls,
      locationId: null,
      productType: product.supplierProduct.categoryPath,
    });

    const variantIdBySupplierId = new Map(
      active.map((v) => [v.supplierVariantId, v.id] as const),
    );

    for (const mapping of result.variantMappings) {
      const supplierVariantRowId = variantIdBySupplierId.get(mapping.supplierVariantId);
      if (!supplierVariantRowId) continue;

      const priced = pushVariants.find((v) => v.supplierVariantId === mapping.supplierVariantId);
      await prisma.productVariantMap.upsert({
        where: {
          productId_supplierVariantId: { productId, supplierVariantId: supplierVariantRowId },
        },
        create: {
          productId,
          supplierVariantId: supplierVariantRowId,
          shopifyVariantId: mapping.shopifyVariantId,
          shopifyInventoryItemId: mapping.shopifyInventoryItemId,
          lastKnownCostMinor: active.find((v) => v.id === supplierVariantRowId)?.costMinor ?? null,
          lastPushedPriceMinor: priced?.priceMinor ?? null,
          lastKnownStock: priced?.stockQty ?? null,
        },
        update: {
          shopifyVariantId: mapping.shopifyVariantId,
          shopifyInventoryItemId: mapping.shopifyInventoryItemId,
          lastKnownCostMinor: active.find((v) => v.id === supplierVariantRowId)?.costMinor ?? null,
          lastPushedPriceMinor: priced?.priceMinor ?? null,
          lastKnownStock: priced?.stockQty ?? null,
        },
      });
    }

    await prisma.product.update({
      where: { id: productId },
      data: {
        shopifyProductId: result.shopifyProductId,
        status: "SYNCED",
        lastPushedAt: new Date(),
        lastError: null,
      },
    });
    await prisma.listing.update({ where: { id: listing.id }, data: { status: "PUBLISHED" } });

    return {
      shopifyProductId: result.shopifyProductId,
      pricingFailures,
      unmatched: result.unmatchedVariants,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.product.update({
      where: { id: productId },
      data: { status: "ERROR", lastError: message.slice(0, 1000) },
    });
    throw error;
  }
}
