/**
 * Supplier-agnostic types.
 *
 * Nothing outside `app/adapters/<provider>/` may reference a supplier's field
 * names. The adapter's whole job is translation into these shapes; if a CJ
 * field name leaks into a job handler or a route, adding a second supplier
 * becomes a refactor instead of a new file.
 */

export type SupplierProviderId = "CJ";

export interface SupplierCredentials {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

/** One selectable option dimension, e.g. Colour with values Red/Blue. */
export interface NormalizedOption {
  name: string;
  values: string[];
}

export interface NormalizedVariant {
  supplierVariantId: string;
  sku: string | null;
  /** Option name to value, e.g. { Colour: "Red", Size: "XL" }. */
  optionValues: Record<string, string>;
  costMinor: number;
  costCurrency: string;
  stockQty: number;
  weightGrams: number | null;
  imageUrl: string | null;
}

export interface NormalizedProduct {
  provider: SupplierProviderId;
  supplierProductId: string;
  title: string;
  descriptionHtml: string | null;
  categoryPath: string | null;
  weightGrams: number | null;
  imageUrls: string[];
  options: NormalizedOption[];
  variants: NormalizedVariant[];
  sourceUrl: string | null;
  /** The untouched upstream payload, kept for debugging schema drift. */
  raw: unknown;
}

export interface StockSnapshot {
  supplierVariantId: string;
  stockQty: number;
  costMinor: number;
  costCurrency: string;
}

export interface SupplierContext {
  supplierAccountId: string;
  credentials: SupplierCredentials;
}

export interface SupplierAdapter {
  readonly provider: SupplierProviderId;
  authenticate(email: string, apiKey: string): Promise<SupplierCredentials>;
  refresh(refreshToken: string): Promise<SupplierCredentials>;
  getProduct(supplierProductId: string, ctx: SupplierContext): Promise<NormalizedProduct>;
  getVariantStock(supplierVariantIds: string[], ctx: SupplierContext): Promise<StockSnapshot[]>;
}

/** Thrown for conditions the caller is expected to handle differently. */
export class SupplierError extends Error {
  readonly code:
    | "AUTH_FAILED"
    | "TOKEN_EXPIRED"
    | "RATE_LIMITED"
    | "NOT_FOUND"
    | "MALFORMED_RESPONSE"
    | "UPSTREAM_ERROR";
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  override readonly cause?: unknown;

  constructor(
    code: SupplierError["code"],
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "SupplierError";
    this.code = code;
    // Auth and rate-limit failures are recoverable; a missing product is not.
    this.retryable = options.retryable ?? (code === "RATE_LIMITED" || code === "UPSTREAM_ERROR");
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.cause = options.cause;
  }
}
