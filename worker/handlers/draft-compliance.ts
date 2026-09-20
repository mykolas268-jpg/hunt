/**
 * Draft GPSR compliance fields for one product in one market.
 *
 * Output always lands unreviewed, with per-field provenance recorded. A
 * regulatory declaration that nobody looked at is the liability this whole
 * feature is built to avoid creating.
 */

import type { Completeness, PrismaClient } from "@prisma/client";
import { AiClient, totalUsage } from "../../app/lib/ai/client.server.js";
import { countryName, languageName } from "../../app/lib/locales.js";
import type { JobPayload } from "../../app/lib/queue/jobs.js";
import { buildSourceText } from "./generate-listing.js";

/** Fields GPSR expects an online listing to carry. */
const REQUIRED_FOR_COMPLETENESS = [
  "manufacturerName",
  "manufacturerAddress",
  "warnings",
  "safetyInstructions",
] as const;

export function scoreCompleteness(record: Record<string, unknown>): Completeness {
  const present = REQUIRED_FOR_COMPLETENESS.filter((field) => {
    const value = record[field];
    return value != null && value !== "";
  }).length;

  if (present === 0) return "EMPTY";
  if (present === REQUIRED_FOR_COMPLETENESS.length) return "COMPLETE";
  return "PARTIAL";
}

export async function draftCompliance(
  prisma: PrismaClient,
  payload: JobPayload<"compliance.draft">,
  ai: AiClient = new AiClient(),
): Promise<{ recordId: string; completeness: Completeness; droppedFields: string[] }> {
  const { shopId, productId, marketId } = payload;

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { supplierProduct: true },
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

  const result = await ai.generateCompliance(
    {
      supplierTitle: supplier.titleRaw,
      supplierDescription: supplier.descriptionRaw,
      categoryPath: supplier.categoryPath,
      languageName: languageName(market.languageCode),
      countryName: countryName(market.countryCode),
    },
    sourceText,
  );

  const usage = totalUsage(result.usage);
  await prisma.aiGeneration.create({
    data: {
      shopId, kind: "COMPLIANCE", model: usage.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, costMicros: usage.costMicros,
      latencyMs: usage.latencyMs, promptVersion: result.promptVersion,
      success: result.ok, errorCode: result.ok ? null : result.code,
    },
  });

  if (!result.ok) {
    throw new Error(`Compliance drafting failed: ${result.message}`);
  }

  const output = result.output;
  const completeness = scoreCompleteness(output as unknown as Record<string, unknown>);

  // Every populated field is marked AI_DRAFT. Nothing here is merchant-entered
  // until a human edits it, and nothing is reviewed until a human says so.
  const fieldProvenance: Record<string, string> = {};
  for (const [field, value] of Object.entries(output)) {
    if (field === "evidence" || field === "missingFields") continue;
    if (value != null && value !== "" && !(Array.isArray(value) && value.length === 0)) {
      fieldProvenance[field] = "AI_DRAFT";
    }
  }

  const data = {
    manufacturerName: output.manufacturerName,
    manufacturerAddress: output.manufacturerAddress,
    manufacturerEmail: output.manufacturerEmail,
    warnings: output.warnings,
    safetyInstructions: output.safetyInstructions,
    careInstructions: output.careInstructions,
    ageRestriction: output.ageRestriction,
    productIdentifiers: output.productIdentifiers,
    fieldProvenance,
    completeness,
    responsiblePersonId: market.responsiblePersonId,
    // Always unreviewed. A fresh draft has by definition not been checked.
    merchantReviewedAt: null,
    merchantReviewedBy: null,
  };

  const record = await prisma.complianceRecord.upsert({
    where: { productId_marketId: { productId, marketId } },
    create: { productId, marketId, ...data },
    update: data,
  });

  return { recordId: record.id, completeness, droppedFields: result.droppedFields };
}
