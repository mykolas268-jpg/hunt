/**
 * Generate a listing for one product in one market.
 *
 * One job per (product, market). Fanning out rather than looping inside a
 * single job means a failure in the Polish listing does not lose the German
 * one, and each retry re-runs only the market that failed.
 */

import type { PrismaClient } from "@prisma/client";
import { AiClient } from "../../app/lib/ai/client.server.js";
import { totalUsage } from "../../app/lib/ai/client.server.js";
import { checkQuota } from "../../app/lib/billing/quota.server.js";
import { countryName, languageName } from "../../app/lib/locales.js";
import type { JobPayload } from "../../app/lib/queue/jobs.js";

export interface GenerateListingResult {
  listingId: string | null;
  status: "GENERATED" | "FAILED" | "BLOCKED";
  reason: string | null;
}

/**
 * Text the guardrails check generated claims against.
 *
 * Everything the model was shown must be here, or an accurate claim quoting
 * the category would be rejected as fabricated.
 */
export function buildSourceText(parts: {
  title: string;
  description: string | null;
  categoryPath: string | null;
}): string {
  return [parts.title, parts.categoryPath, parts.description]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

/** Human-readable summary of the option matrix, for prompt context. */
export function summariseOptions(variants: Array<{ optionValues: unknown }>): string {
  const byOption = new Map<string, Set<string>>();

  for (const variant of variants) {
    const values = variant.optionValues as Record<string, string> | null;
    if (!values || typeof values !== "object") continue;
    for (const [name, value] of Object.entries(values)) {
      if (!byOption.has(name)) byOption.set(name, new Set());
      byOption.get(name)?.add(String(value));
    }
  }

  if (byOption.size === 0) return "(single variant)";
  return Array.from(byOption.entries())
    .map(([name, values]) => `${name}: ${Array.from(values).join(", ")}`)
    .join("; ");
}

export async function generateListing(
  prisma: PrismaClient,
  payload: JobPayload<"listing.generate">,
  ai: AiClient = new AiClient(),
): Promise<GenerateListingResult> {
  const { shopId, productId, marketId, tone, audienceNote } = payload;

  // Quota is checked before the call, not after. Afterwards means paying for
  // work that cannot be billed.
  const quota = await checkQuota(prisma, shopId);
  if (!quota.allowed) {
    await markFailed(prisma, productId, marketId, quota.reason ?? "Quota exceeded");
    return { listingId: null, status: "BLOCKED", reason: quota.reason };
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { supplierProduct: { include: { variants: true } } },
  });
  const market = await prisma.market.findUnique({ where: { id: marketId } });

  if (!product || !market) {
    throw new Error(`Missing product ${productId} or market ${marketId}`);
  }

  const supplier = product.supplierProduct;
  const sourceText = buildSourceText({
    title: supplier.titleRaw,
    description: supplier.descriptionRaw,
    categoryPath: supplier.categoryPath,
  });

  const result = await ai.generateListing(
    {
      supplierTitle: supplier.titleRaw,
      supplierDescription: supplier.descriptionRaw,
      categoryPath: supplier.categoryPath,
      optionSummary: summariseOptions(supplier.variants),
      languageName: languageName(market.languageCode),
      countryName: countryName(market.countryCode),
      tone,
      audienceNote,
    },
    sourceText,
  );

  // The ledger records every attempt, successful or not. Failures cost money
  // too, and unit economics computed only from successes are fiction.
  const usage = totalUsage(result.usage);
  const listing = await prisma.listing.upsert({
    where: { productId_marketId: { productId, marketId } },
    create: { productId, marketId, locale: market.languageCode, status: "PENDING", tonePreset: tone },
    update: {},
  });

  await prisma.aiGeneration.create({
    data: {
      shopId,
      listingId: listing.id,
      kind: "LISTING",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costMicros: usage.costMicros,
      latencyMs: usage.latencyMs,
      promptVersion: result.promptVersion,
      success: result.ok,
      errorCode: result.ok ? null : result.code,
    },
  });

  if (!result.ok) {
    await prisma.listing.update({
      where: { id: listing.id },
      data: { status: "FAILED", lastError: result.message.slice(0, 1000) },
    });
    return { listingId: listing.id, status: "FAILED", reason: result.message };
  }

  await prisma.listing.update({
    where: { id: listing.id },
    data: {
      title: result.output.title,
      descriptionHtml: result.output.descriptionHtml,
      bullets: result.output.bullets,
      seoTitle: result.output.seoTitle,
      seoDescription: result.output.seoDescription,
      tags: result.output.tags,
      status: "GENERATED",
      model: usage.model,
      promptVersion: result.promptVersion,
      generatedAt: new Date(),
      // Regenerating resets the human-edit flag: the edits are gone.
      humanEdited: false,
      approvedAt: null,
      approvedBy: null,
      lastError: null,
    },
  });

  // Marketing copy and the compliance declaration are reviewed separately, so
  // regenerating copy invalidates the compliance review. This is the concrete
  // reason the two live in different tables.
  await prisma.complianceRecord.updateMany({
    where: { productId, marketId },
    data: { merchantReviewedAt: null, merchantReviewedBy: null },
  });

  return { listingId: listing.id, status: "GENERATED", reason: null };
}

async function markFailed(
  prisma: PrismaClient,
  productId: string,
  marketId: string,
  reason: string,
): Promise<void> {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) return;

  await prisma.listing.upsert({
    where: { productId_marketId: { productId, marketId } },
    create: {
      productId, marketId, locale: market.languageCode,
      status: "FAILED", lastError: reason.slice(0, 1000),
    },
    update: { status: "FAILED", lastError: reason.slice(0, 1000) },
  });
}
