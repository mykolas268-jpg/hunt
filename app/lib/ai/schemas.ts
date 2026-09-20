/**
 * Output contracts for AI-generated content.
 *
 * These schemas are the enforcement mechanism, not the prompt. Asking a model
 * for "a title under 70 characters" is a request; a `max(70)` that rejects the
 * response is a guarantee. Anything that must be true of the output is encoded
 * here, and the generation job retries or fails rather than writing a record
 * that violates it.
 */

import { z } from "zod";

/** Shopify truncates around 70 characters in search results. */
export const MAX_TITLE_LENGTH = 70;
export const MAX_SEO_TITLE_LENGTH = 60;
export const MAX_SEO_DESCRIPTION_LENGTH = 155;
export const BULLET_COUNT = 5;

export const listingOutputSchema = z.object({
  title: z
    .string()
    .min(10)
    .max(MAX_TITLE_LENGTH)
    .describe("Benefit-led product title, under 70 characters, no ALL CAPS, no keyword stuffing."),

  descriptionHtml: z
    .string()
    .min(120)
    .max(4000)
    .describe(
      "Product description as simple HTML using only <p>, <ul>, <li>, <strong>, <br>. " +
        "Two to four short paragraphs, benefit-led, written for a buyer not a search engine.",
    ),

  bullets: z
    .array(z.string().min(10).max(120))
    .length(BULLET_COUNT)
    .describe("Exactly five benefit-led bullet points, each a complete phrase under 120 characters."),

  seoTitle: z.string().min(10).max(MAX_SEO_TITLE_LENGTH),
  seoDescription: z.string().min(50).max(MAX_SEO_DESCRIPTION_LENGTH),

  tags: z
    .array(z.string().min(2).max(40))
    .min(3)
    .max(12)
    .describe("Lowercase search tags. No brand names, no competitor names."),

  /**
   * Specification claims the copy relies on, each with the supplier text it
   * came from. Verified against the source before the listing is saved.
   */
  claims: z
    .array(
      z.object({
        claim: z.string().min(3).max(200),
        evidence: z.string().min(3).max(400),
      }),
    )
    .max(20)
    .default([]),
});

export type ListingOutput = z.infer<typeof listingOutputSchema>;

/**
 * GPSR compliance fields.
 *
 * Every field is nullable by design. An empty warnings field is a gap the
 * merchant must fill; an invented one is a false regulatory declaration made in
 * their name. `evidence` exists so "did the model make this up?" is a
 * mechanical check rather than a judgement call.
 */
export const complianceOutputSchema = z.object({
  manufacturerName: z.string().max(200).nullable(),
  manufacturerAddress: z.string().max(400).nullable(),
  manufacturerEmail: z.string().max(200).nullable(),

  warnings: z.string().max(2000).nullable().describe("Safety warnings in the target language."),
  safetyInstructions: z.string().max(2000).nullable(),
  careInstructions: z.string().max(2000).nullable(),
  ageRestriction: z.string().max(120).nullable(),

  productIdentifiers: z
    .array(z.object({ kind: z.string().max(40), value: z.string().max(120) }))
    .max(10)
    .default([]),

  /**
   * Verbatim supplier text supporting each populated field, keyed by field
   * name. A field with no evidence entry is treated as fabricated and dropped.
   */
  evidence: z.record(z.string(), z.string().max(600)).default({}),

  /** Fields the model could not support from the source. Surfaced to the merchant. */
  missingFields: z.array(z.string().max(60)).max(20).default([]),
});

export type ComplianceOutput = z.infer<typeof complianceOutputSchema>;

/** Compliance fields that carry legal weight and must be evidence-backed. */
export const EVIDENCE_REQUIRED_FIELDS = [
  "manufacturerName",
  "manufacturerAddress",
  "manufacturerEmail",
  "warnings",
  "safetyInstructions",
  "ageRestriction",
] as const;

export type EvidenceRequiredField = (typeof EVIDENCE_REQUIRED_FIELDS)[number];
