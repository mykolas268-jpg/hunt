/**
 * Worker process.
 *
 * Deployed as a separate Railway service from the same repository. It shares
 * the database with the web app but not the process: a long-running queue
 * consumer cannot live inside a request-scoped server, which is the reason
 * Vercel was ruled out in ADR-003.
 */

import { PrismaClient } from "@prisma/client";
import { getQueue } from "../app/lib/queue/client.server.js";
import { JOB_NAMES } from "../app/lib/queue/jobs.js";
import { importProduct } from "./handlers/import-product.js";
import { refreshFxRates } from "./handlers/fx-refresh.js";
import { monitorSync } from "./handlers/monitor-sync.js";
import { generateListing } from "./handlers/generate-listing.js";
import { draftCompliance } from "./handlers/draft-compliance.js";
import { pushProductToShopify } from "./handlers/push-product.js";

const prisma = new PrismaClient();
const queue = getQueue();

async function main(): Promise<void> {
  await queue.start();

  await queue.work(JOB_NAMES.importProduct, async (payload) => {
    const result = await importProduct(prisma, payload);
    console.log(`[import] ${result.supplierProductId}: ${result.variantCount} variants`);
  });

  await queue.work(JOB_NAMES.generateListing, async (payload) => {
    const result = await generateListing(prisma, payload);
    console.log(`[listing] product ${payload.productId} / market ${payload.marketId}: ${result.status}`);
  });

  await queue.work(JOB_NAMES.draftCompliance, async (payload) => {
    const result = await draftCompliance(prisma, payload);
    console.log(
      `[compliance] product ${payload.productId}: ${result.completeness}` +
        (result.droppedFields.length > 0
          ? ` (dropped unevidenced: ${result.droppedFields.join(", ")})`
          : ""),
    );
  });

  await queue.work(JOB_NAMES.pushProduct, async (payload) => {
    const result = await pushProductToShopify(prisma, payload);
    console.log(
      `[push] product ${payload.productId} -> ${result.shopifyProductId}` +
        (result.pricingFailures.length > 0
          ? ` (${result.pricingFailures.length} variant(s) could not be priced)`
          : ""),
    );
  });

  await queue.work(JOB_NAMES.monitorSync, async (payload) => {
    const result = await monitorSync(prisma, payload);
    console.log(
      `[monitor] shop ${payload.shopId}: ${result.productsChecked} products, ` +
        `${result.eventsCreated} events${result.skipped ? ` (skipped: ${result.skipped})` : ""}`,
    );
  });

  await queue.work(JOB_NAMES.fxRefresh, async () => {
    const result = await refreshFxRates(prisma);
    console.log(`[fx] ${result.count} rates as of ${result.asOfDate}`);
  });

  await queue.work(JOB_NAMES.shopRedact, async (payload) => {
    // Cascade deletes from Shop remove every child row, which is why the
    // schema declares onDelete: Cascade all the way down.
    const deleted = await prisma.shop.deleteMany({ where: { shopDomain: payload.shopDomain } });
    console.log(`[redact] ${payload.shopDomain}: ${deleted.count} shop record(s) erased`);
  });

  // ECB publishes mid-afternoon CET; 16:30 UTC is comfortably after.
  await queue.schedule(JOB_NAMES.fxRefresh, "30 16 * * 1-5", {});

  console.log("[worker] ready");
}

/**
 * Finish in-flight jobs before exiting. Railway sends SIGTERM on deploy, and a
 * hard exit mid-job leaves a half-written import the merchant has to notice.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, draining`);
  try {
    await queue.stop();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error("[worker] shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((error) => {
  console.error("[worker] failed to start", error);
  process.exit(1);
});
