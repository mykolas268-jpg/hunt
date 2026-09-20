/**
 * Import one supplier product into the merchant's catalogue.
 *
 * Idempotent on (supplierAccountId, supplierProductId): re-importing updates
 * in place. Merchants re-import constantly — to pick up a supplier change, or
 * because they double-clicked — and duplicate products are both a support
 * burden and a real risk of the merchant selling the wrong row.
 */

import type { PrismaClient } from "@prisma/client";
import { normalizeProduct } from "../../app/adapters/cj/normalize.js";
import type { NormalizedProduct } from "../../app/adapters/types.js";
import { SupplierError } from "../../app/adapters/types.js";
import { withRateLimit, ensureBucket } from "../../app/lib/ratelimit/token-bucket.server.js";
import { markSupplierInvalid, resolveSupplier } from "../../app/lib/supplier.server.js";
import type { JobPayload } from "../../app/lib/queue/jobs.js";

export async function importProduct(
  prisma: PrismaClient,
  payload: JobPayload<"import.product">,
): Promise<{ supplierProductId: string; variantCount: number }> {
  const { shopId, supplierAccountId, supplierProductId } = payload;

  const { credentials, client } = await resolveSupplier(prisma, supplierAccountId);
  await ensureBucket(prisma, supplierAccountId);

  let normalized: NormalizedProduct;
  try {
    // Both calls are metered: the merchant's supplier budget is shared across
    // every worker, so each request takes a token.
    const raw = await withRateLimit(prisma, supplierAccountId, () =>
      client.getProduct(supplierProductId, credentials.accessToken),
    );
    normalized = normalizeProduct(raw, {
      sourceUrl: `https://www.cjdropshipping.com/product/-p-${supplierProductId}.html`,
    });

    const stock = await withRateLimit(prisma, supplierAccountId, () =>
      client.getVariantStock(
        normalized.variants.map((v) => v.supplierVariantId),
        credentials.accessToken,
      ),
    );

    // CJ reports availability per warehouse, so a variant's true stock is the
    // sum of its rows rather than any single one.
    const stockByVid = new Map<string, number>();
    for (const row of stock) {
      const qty = Math.max(0, Math.round(Number(row.storageNum ?? 0)));
      stockByVid.set(row.vid, (stockByVid.get(row.vid) ?? 0) + qty);
    }
    for (const variant of normalized.variants) {
      variant.stockQty = stockByVid.get(variant.supplierVariantId) ?? 0;
    }
  } catch (error) {
    if (error instanceof SupplierError && error.code === "TOKEN_EXPIRED") {
      await markSupplierInvalid(prisma, supplierAccountId, error.message);
    }
    throw error;
  }

  await prisma.$transaction(async (tx) => {
    const product = await tx.supplierProduct.upsert({
      where: {
        supplierAccountId_supplierProductId: { supplierAccountId, supplierProductId },
      },
      create: {
        shopId,
        supplierAccountId,
        supplierProductId,
        titleRaw: normalized.title,
        descriptionRaw: normalized.descriptionHtml,
        categoryPath: normalized.categoryPath,
        weightGrams: normalized.weightGrams,
        imageUrls: normalized.imageUrls,
        sourceUrl: normalized.sourceUrl,
        rawPayload: normalized.raw as object,
      },
      update: {
        titleRaw: normalized.title,
        descriptionRaw: normalized.descriptionHtml,
        categoryPath: normalized.categoryPath,
        weightGrams: normalized.weightGrams,
        imageUrls: normalized.imageUrls,
        rawPayload: normalized.raw as object,
        lastFetchedAt: new Date(),
      },
    });

    const seenVids = new Set<string>();
    for (const variant of normalized.variants) {
      seenVids.add(variant.supplierVariantId);
      await tx.supplierVariant.upsert({
        where: {
          supplierProductId_supplierVariantId: {
            supplierProductId: product.id,
            supplierVariantId: variant.supplierVariantId,
          },
        },
        create: {
          supplierProductId: product.id,
          supplierVariantId: variant.supplierVariantId,
          sku: variant.sku,
          optionValues: variant.optionValues,
          costMinor: variant.costMinor,
          costCurrency: variant.costCurrency,
          stockQty: variant.stockQty,
          weightGrams: variant.weightGrams,
          imageUrl: variant.imageUrl,
        },
        update: {
          sku: variant.sku,
          optionValues: variant.optionValues,
          costMinor: variant.costMinor,
          costCurrency: variant.costCurrency,
          stockQty: variant.stockQty,
          weightGrams: variant.weightGrams,
          imageUrl: variant.imageUrl,
          lastSeenAt: new Date(),
          discontinuedAt: null,
        },
      });
    }

    // Variants the supplier stopped returning are marked, never deleted: the
    // merchant may still have open orders referencing them.
    await tx.supplierVariant.updateMany({
      where: {
        supplierProductId: product.id,
        supplierVariantId: { notIn: Array.from(seenVids) },
        discontinuedAt: null,
      },
      data: { discontinuedAt: new Date() },
    });

    await tx.product.upsert({
      where: { shopId_supplierProductId: { shopId, supplierProductId: product.id } },
      create: { shopId, supplierProductId: product.id, status: "DRAFT" },
      update: {},
    });
  });

  return { supplierProductId, variantCount: normalized.variants.length };
}
