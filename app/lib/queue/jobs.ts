/**
 * Job catalogue.
 *
 * Payloads are Zod schemas rather than TypeScript interfaces because a job
 * payload crosses a process boundary and sits in a database between enqueue and
 * execution. Types vanish at runtime; a deploy that changes a payload shape
 * leaves older rows in the queue that no longer match. Parsing on the way out
 * turns that into a clean validation failure instead of an undefined-property
 * crash halfway through the work.
 */

import { z } from "zod";

export const JOB_NAMES = {
  importProduct: "import.product",
  generateListing: "listing.generate",
  draftCompliance: "compliance.draft",
  pushProduct: "product.push",
  monitorSync: "monitor.sync",
  fxRefresh: "fx.refresh",
  shopRedact: "shop.redact",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const importProductPayload = z.object({
  shopId: z.string().min(1),
  supplierAccountId: z.string().min(1),
  supplierProductId: z.string().min(1),
});

export const generateListingPayload = z.object({
  shopId: z.string().min(1),
  productId: z.string().min(1),
  marketId: z.string().min(1),
  tone: z.enum(["professional", "friendly", "premium", "playful"]).default("professional"),
  audienceNote: z.string().max(500).nullable().default(null),
});

export const draftCompliancePayload = z.object({
  shopId: z.string().min(1),
  productId: z.string().min(1),
  marketId: z.string().min(1),
});

export const pushProductPayload = z.object({
  shopId: z.string().min(1),
  productId: z.string().min(1),
  marketId: z.string().min(1),
});

export const monitorSyncPayload = z.object({
  shopId: z.string().min(1),
});

export const fxRefreshPayload = z.object({});

export const shopRedactPayload = z.object({
  shopDomain: z.string().min(1),
});

export const JOB_SCHEMAS = {
  [JOB_NAMES.importProduct]: importProductPayload,
  [JOB_NAMES.generateListing]: generateListingPayload,
  [JOB_NAMES.draftCompliance]: draftCompliancePayload,
  [JOB_NAMES.pushProduct]: pushProductPayload,
  [JOB_NAMES.monitorSync]: monitorSyncPayload,
  [JOB_NAMES.fxRefresh]: fxRefreshPayload,
  [JOB_NAMES.shopRedact]: shopRedactPayload,
} as const;

export type JobPayload<N extends JobName> = z.infer<(typeof JOB_SCHEMAS)[N]>;

/** Parse a payload coming off the queue. Throws on shape drift. */
export function parseJobPayload<N extends JobName>(name: N, raw: unknown): JobPayload<N> {
  const schema = JOB_SCHEMAS[name];
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid payload for job "${name}": ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data as JobPayload<N>;
}
