/**
 * Zod schemas for CJ Dropshipping API v2 responses.
 *
 * ⚠️ UNVERIFIED AGAINST THE LIVE API.
 *
 * The CJ developer documentation was not reachable from the environment these
 * schemas were written in, so the field names below reflect the documented v2
 * shape as best understood — not a payload observed from the real service.
 *
 * Build-plan Task 0 (the CJ spike) exists to correct this. Capture real
 * payloads into `spikes/fixtures/`, run the adapter tests against them, and fix
 * whatever diverges. Do not ship to a merchant before that has happened.
 *
 * Every object is `.passthrough()`: unknown fields are tolerated because
 * suppliers add fields without warning, but missing REQUIRED fields fail loudly
 * rather than silently producing a product with no price.
 */

import { z } from "zod";

/** CJ wraps every response in this envelope. `code` 200 means success. */
export const cjEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z
    .object({
      code: z.number(),
      result: z.boolean().optional(),
      message: z.string().optional().nullable(),
      data: data.nullable(),
      requestId: z.string().optional().nullable(),
    })
    .passthrough();

export const cjAuthData = z
  .object({
    accessToken: z.string().min(1),
    accessTokenExpiryDate: z.string().min(1),
    refreshToken: z.string().min(1).nullable().optional(),
    refreshTokenExpiryDate: z.string().nullable().optional(),
  })
  .passthrough();

export type CjAuthData = z.infer<typeof cjAuthData>;

/**
 * A number that CJ may send as a JSON string ("12.34") or a number (12.34).
 * Mixed types across the same field are common in this API.
 */
const looseNumber = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not a number: ${String(v)}` });
    return z.NEVER;
  }
  return n;
});

const optionalLooseNumber = looseNumber.nullable().optional();

export const cjVariant = z
  .object({
    vid: z.string().min(1),
    pid: z.string().optional().nullable(),
    variantName: z.string().optional().nullable(),
    variantNameEn: z.string().optional().nullable(),
    variantSku: z.string().optional().nullable(),
    variantImage: z.string().optional().nullable(),
    /** Option values joined by a separator, e.g. "Red-XL". */
    variantKey: z.string().optional().nullable(),
    variantSellPrice: looseNumber,
    variantWeight: optionalLooseNumber,
    variantStandard: z.string().optional().nullable(),
  })
  .passthrough();

export type CjVariant = z.infer<typeof cjVariant>;

export const cjProduct = z
  .object({
    pid: z.string().min(1),
    productName: z.string().optional().nullable(),
    productNameEn: z.string().optional().nullable(),
    productSku: z.string().optional().nullable(),
    productImage: z.string().optional().nullable(),
    productImageSet: z.array(z.string()).optional().nullable(),
    productWeight: optionalLooseNumber,
    categoryName: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    sellPrice: optionalLooseNumber,
    variants: z.array(cjVariant).optional().nullable(),
  })
  .passthrough();

export type CjProduct = z.infer<typeof cjProduct>;

export const cjStockRow = z
  .object({
    vid: z.string().min(1),
    /** CJ reports availability per warehouse; totals are summed downstream. */
    storageNum: optionalLooseNumber,
    countryCode: z.string().optional().nullable(),
  })
  .passthrough();

export const cjAuthResponse = cjEnvelope(cjAuthData);
export const cjProductResponse = cjEnvelope(cjProduct);
export const cjStockResponse = cjEnvelope(z.array(cjStockRow));
