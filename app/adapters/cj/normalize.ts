/**
 * Translate CJ payloads into supplier-agnostic shapes.
 *
 * The genuinely hard part of importing is not the HTTP call — it is rebuilding
 * a coherent option matrix. CJ describes a variant with a flat `variantKey`
 * like "Red-XL"; Shopify needs named option dimensions with ordered value
 * lists, plus each variant's position within them. Getting this wrong produces
 * products with options called "Option 1" and unsellable variant combinations,
 * which is the single most visible way an import tool looks amateur.
 */

import type { NormalizedOption, NormalizedProduct, NormalizedVariant } from "../types.js";
import { SupplierError } from "../types.js";
import type { CjProduct, CjVariant } from "./schemas.js";

/** CJ joins option values with a hyphen. Observed variants use "-" or "/". */
const KEY_SEPARATOR = /\s*[-/]\s*/;

/**
 * Convert a decimal currency amount to integer minor units.
 *
 * Routed through `toFixed` first because binary floating point makes
 * `12.34 * 100` evaluate to 1233.9999999999998, which truncates to the wrong
 * cent. This is the only place in the codebase where a float is permitted, and
 * it exists solely to stop being one.
 */
export function toMinorUnits(value: number): number {
  if (!Number.isFinite(value)) {
    throw new SupplierError("MALFORMED_RESPONSE", `Price is not a finite number: ${value}`);
  }
  if (value < 0) {
    throw new SupplierError("MALFORMED_RESPONSE", `Price is negative: ${value}`);
  }
  return Math.round(Number.parseFloat(value.toFixed(4)) * 100);
}

function toGrams(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * Split a variant key into its option values.
 *
 * Returns an empty array for a key that carries no information, so callers can
 * distinguish "single-variant product" from "two-dimension product".
 */
export function splitVariantKey(key: string | null | undefined): string[] {
  if (!key) return [];
  return key
    .split(KEY_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Derive option dimension names.
 *
 * CJ does not reliably name its dimensions, so this infers what it can and
 * falls back to positional labels. The fallback is deliberately "Option 1"
 * rather than a guess like "Color": a wrong name is worse than a neutral one,
 * because the merchant can rename a neutral label but may never notice a
 * plausible-looking wrong one.
 */
export function deriveOptionNames(variants: CjVariant[], dimensionCount: number): string[] {
  if (dimensionCount === 0) return [];

  // `variantStandard` sometimes carries "Color:Red;Size:XL" style metadata.
  for (const variant of variants) {
    const standard = variant.variantStandard;
    if (!standard || !standard.includes(":")) continue;

    const names = standard
      .split(";")
      .map((pair) => pair.split(":")[0]?.trim())
      .filter((name): name is string => Boolean(name));

    if (names.length === dimensionCount) return names;
  }

  return Array.from({ length: dimensionCount }, (_, i) => `Option ${i + 1}`);
}

/**
 * Rebuild the option matrix from a flat list of variants.
 *
 * Variants whose key has fewer segments than the widest one are padded rather
 * than dropped. A supplier that returns a ragged matrix is common, and silently
 * discarding those variants loses sellable inventory.
 */
export function buildOptions(variants: CjVariant[]): {
  options: NormalizedOption[];
  valuesByVariant: Map<string, Record<string, string>>;
} {
  const splitKeys = new Map<string, string[]>();
  let dimensionCount = 0;

  for (const variant of variants) {
    const parts = splitVariantKey(variant.variantKey ?? variant.variantNameEn ?? variant.variantName);
    splitKeys.set(variant.vid, parts);
    dimensionCount = Math.max(dimensionCount, parts.length);
  }

  if (dimensionCount === 0) {
    return { options: [], valuesByVariant: new Map() };
  }

  const names = deriveOptionNames(variants, dimensionCount);
  // Insertion-ordered sets preserve the supplier's own value ordering, which is
  // usually meaningful (S, M, L rather than L, M, S).
  const valueSets: Array<Set<string>> = names.map(() => new Set<string>());
  const valuesByVariant = new Map<string, Record<string, string>>();

  for (const variant of variants) {
    const parts = splitKeys.get(variant.vid) ?? [];
    const record: Record<string, string> = {};

    for (let i = 0; i < dimensionCount; i++) {
      const name = names[i] as string;
      const value = parts[i]?.trim() || "Default";
      record[name] = value;
      (valueSets[i] as Set<string>).add(value);
    }
    valuesByVariant.set(variant.vid, record);
  }

  const options: NormalizedOption[] = names.map((name, i) => ({
    name,
    values: Array.from(valueSets[i] as Set<string>),
  }));

  return { options, valuesByVariant };
}

export interface NormalizeOptions {
  /** Currency CJ quotes in. CJ prices in USD unless the account says otherwise. */
  costCurrency?: string;
  sourceUrl?: string | null;
}

/**
 * Turn a validated CJ product into a `NormalizedProduct`.
 *
 * Throws `SupplierError` rather than returning a partial product: a product
 * with no variants or no price cannot be sold, and failing here produces a
 * clear job failure instead of a broken listing the merchant has to discover.
 */
export function normalizeProduct(
  cj: CjProduct,
  options: NormalizeOptions = {},
): NormalizedProduct {
  const costCurrency = options.costCurrency ?? "USD";
  const cjVariants = cj.variants ?? [];

  if (cjVariants.length === 0) {
    throw new SupplierError(
      "MALFORMED_RESPONSE",
      `CJ product ${cj.pid} has no variants; nothing sellable to import.`,
    );
  }

  const seen = new Set<string>();
  for (const variant of cjVariants) {
    if (seen.has(variant.vid)) {
      throw new SupplierError(
        "MALFORMED_RESPONSE",
        `CJ product ${cj.pid} returned duplicate variant id ${variant.vid}.`,
      );
    }
    seen.add(variant.vid);
  }

  const { options: normalizedOptions, valuesByVariant } = buildOptions(cjVariants);

  const variants: NormalizedVariant[] = cjVariants.map((variant) => ({
    supplierVariantId: variant.vid,
    sku: variant.variantSku?.trim() || null,
    optionValues: valuesByVariant.get(variant.vid) ?? {},
    costMinor: toMinorUnits(variant.variantSellPrice),
    costCurrency,
    // CJ's product endpoint does not carry per-warehouse stock; the stock
    // endpoint fills this in. Zero here means "unknown", not "out of stock",
    // so the import job must not publish availability from this value alone.
    stockQty: 0,
    weightGrams: toGrams(variant.variantWeight) ?? toGrams(cj.productWeight),
    imageUrl: variant.variantImage?.trim() || null,
  }));

  const imageUrls = dedupe(
    [cj.productImage, ...(cj.productImageSet ?? [])]
      .map((url) => url?.trim())
      .filter((url): url is string => Boolean(url)),
  );

  // Prefer the English title: machine-translated English is poor, but it is
  // what the AI stage is designed to rewrite, and the Chinese original is not.
  const title = (cj.productNameEn || cj.productName || "").trim();
  if (!title) {
    throw new SupplierError("MALFORMED_RESPONSE", `CJ product ${cj.pid} has no usable title.`);
  }

  return {
    provider: "CJ",
    supplierProductId: cj.pid,
    title,
    descriptionHtml: cj.description?.trim() || null,
    categoryPath: cj.categoryName?.trim() || null,
    weightGrams: toGrams(cj.productWeight),
    imageUrls,
    options: normalizedOptions,
    variants,
    sourceUrl: options.sourceUrl ?? null,
    raw: cj,
  };
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
