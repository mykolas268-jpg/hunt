/**
 * Detect supplier cost and stock changes — the retention loop.
 *
 * This is the job that makes a monthly subscription defensible. Importing is a
 * one-time action; a merchant who imports thirty products in week one has no
 * reason to open the app again unless something tells them their costs moved.
 *
 * It emits events rather than applying changes. A supplier raising a cost by
 * 40% should not silently reprice a merchant's storefront while they sleep.
 */

import type { PrismaClient, ChangeType } from "@prisma/client";
import { SupplierError } from "../../app/adapters/types.js";
import { ensureBucket, withRateLimit } from "../../app/lib/ratelimit/token-bucket.server.js";
import { markSupplierInvalid, resolveSupplier } from "../../app/lib/supplier.server.js";
import type { JobPayload } from "../../app/lib/queue/jobs.js";

/** Ignore sub-1% cost drift so FX noise does not spam the merchant. */
const COST_CHANGE_THRESHOLD_BP = 100;

export interface MonitorResult {
  productsChecked: number;
  eventsCreated: number;
  skipped: string | null;
}

export async function monitorSync(
  prisma: PrismaClient,
  payload: JobPayload<"monitor.sync">,
): Promise<MonitorResult> {
  const shop = await prisma.shop.findUnique({ where: { id: payload.shopId } });

  // An uninstalled shop still has rows and still has scheduled jobs. Polling
  // its supplier costs spends rate budget and money on a customer who left.
  if (!shop || shop.uninstalledAt) {
    return { productsChecked: 0, eventsCreated: 0, skipped: "shop uninstalled" };
  }

  const account = await prisma.supplierAccount.findFirst({
    where: { shopId: shop.id, status: "ACTIVE" },
  });
  if (!account) {
    return { productsChecked: 0, eventsCreated: 0, skipped: "no active supplier account" };
  }

  const products = await prisma.product.findMany({
    where: { shopId: shop.id, status: { in: ["SYNCED", "READY"] } },
    include: {
      supplierProduct: { include: { variants: true } },
      variantMaps: true,
    },
  });

  if (products.length === 0) {
    return { productsChecked: 0, eventsCreated: 0, skipped: null };
  }

  const { credentials, client } = await resolveSupplier(prisma, account.id);
  await ensureBucket(prisma, account.id);

  let eventsCreated = 0;

  for (const product of products) {
    const variants = product.supplierProduct.variants.filter((v) => !v.discontinuedAt);
    if (variants.length === 0) continue;

    let rows;
    try {
      rows = await withRateLimit(prisma, account.id, () =>
        client.getVariantStock(
          variants.map((v) => v.supplierVariantId),
          credentials.accessToken,
        ),
      );
    } catch (error) {
      if (error instanceof SupplierError && error.code === "TOKEN_EXPIRED") {
        await markSupplierInvalid(prisma, account.id, error.message);
        throw error;
      }
      if (error instanceof SupplierError && error.code === "NOT_FOUND") {
        eventsCreated += await recordEvents(prisma, shop.id, product.id, [
          { supplierVariantId: variants[0]!.id, type: "DISCONTINUED", oldValue: null, newValue: null },
        ]);
        continue;
      }
      // One unreachable product must not abort the whole shop's sweep.
      console.error(`[monitor] product ${product.id} failed`, error);
      continue;
    }

    const stockByVid = new Map<string, number>();
    for (const row of rows) {
      const qty = Math.max(0, Math.round(Number(row.storageNum ?? 0)));
      stockByVid.set(row.vid, (stockByVid.get(row.vid) ?? 0) + qty);
    }

    const mapsByVariant = new Map(product.variantMaps.map((m) => [m.supplierVariantId, m]));
    const pending: PendingEvent[] = [];

    for (const variant of variants) {
      const map = mapsByVariant.get(variant.id);
      const newStock = stockByVid.get(variant.supplierVariantId) ?? 0;
      const knownStock = map?.lastKnownStock ?? variant.stockQty;

      if (knownStock > 0 && newStock === 0) {
        pending.push({
          supplierVariantId: variant.id, type: "STOCK_OUT",
          oldValue: String(knownStock), newValue: "0",
        });
      } else if (knownStock === 0 && newStock > 0) {
        pending.push({
          supplierVariantId: variant.id, type: "STOCK_IN",
          oldValue: "0", newValue: String(newStock),
        });
      }

      const knownCost = map?.lastKnownCostMinor ?? variant.costMinor;
      if (knownCost > 0 && variant.costMinor !== knownCost) {
        const deltaBp = Math.abs(((variant.costMinor - knownCost) * 10_000) / knownCost);
        if (deltaBp >= COST_CHANGE_THRESHOLD_BP) {
          pending.push({
            supplierVariantId: variant.id,
            type: variant.costMinor > knownCost ? "COST_UP" : "COST_DOWN",
            oldValue: String(knownCost),
            newValue: String(variant.costMinor),
          });
        }
      }

      await prisma.supplierVariant.update({
        where: { id: variant.id },
        data: { stockQty: newStock, lastSeenAt: new Date() },
      });
    }

    eventsCreated += await recordEvents(prisma, shop.id, product.id, pending);
  }

  return { productsChecked: products.length, eventsCreated, skipped: null };
}

interface PendingEvent {
  supplierVariantId: string;
  type: ChangeType;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * Persist events, skipping ones already outstanding.
 *
 * Without this, a variant out of stock for a week produces seven identical
 * rows and the merchant stops reading the change list entirely.
 */
async function recordEvents(
  prisma: PrismaClient,
  shopId: string,
  productId: string,
  events: PendingEvent[],
): Promise<number> {
  let created = 0;

  for (const event of events) {
    const existing = await prisma.supplierChangeEvent.findFirst({
      where: {
        productId,
        supplierVariantId: event.supplierVariantId,
        type: event.type,
        status: "NEW",
      },
    });
    if (existing) continue;

    await prisma.supplierChangeEvent.create({
      data: { shopId, productId, ...event },
    });
    created++;
  }

  return created;
}
