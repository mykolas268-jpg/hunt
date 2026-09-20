/**
 * Exchange rates from the ECB daily reference feed.
 *
 * The ECB feed is free, needs no API key, publishes on European banking days,
 * and is the rate EU tax authorities recognise — which matters more here than
 * precision to the fifth decimal. It is quoted with EUR as the base.
 *
 * Rates are stored in basis points as integers. A missing rate is never
 * defaulted to parity: pricing fails loudly instead, because a silent 1.0
 * would sell USD-cost goods at EUR prices and lose roughly 8% on every order
 * without anything appearing wrong.
 */

const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export interface ParsedFxRate {
  quoteCurrency: string;
  rateBp: number;
}

export interface ParsedFxFeed {
  asOfDate: string; // YYYY-MM-DD
  rates: ParsedFxRate[];
}

export class FxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxError";
  }
}

/**
 * Parse the ECB daily XML.
 *
 * Deliberately regex-based rather than pulling in an XML parser: the document
 * is a fixed, flat, machine-generated format of about 40 self-closing
 * elements, and a dependency that must be kept patched is a poor trade for it.
 * If the ECB ever changes the format, the extraction returns nothing and the
 * caller raises — it cannot silently produce wrong numbers.
 */
export function parseEcbFeed(xml: string): ParsedFxFeed {
  const dateMatch = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/);
  if (!dateMatch?.[1]) {
    throw new FxError("ECB feed contained no dated Cube element; the format may have changed.");
  }

  const rates: ParsedFxRate[] = [];
  const pattern = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;

  for (const match of xml.matchAll(pattern)) {
    const currency = match[1] as string;
    const rate = Number.parseFloat(match[2] as string);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rates.push({ quoteCurrency: currency, rateBp: Math.round(rate * 10_000) });
  }

  if (rates.length === 0) {
    throw new FxError("ECB feed contained no usable rates; the format may have changed.");
  }

  return { asOfDate: dateMatch[1], rates };
}

export async function fetchEcbFeed(fetchImpl: typeof fetch = globalThis.fetch): Promise<ParsedFxFeed> {
  const response = await fetchImpl(ECB_DAILY_URL);
  if (!response.ok) {
    throw new FxError(`ECB feed returned ${response.status}`);
  }
  return parseEcbFeed(await response.text());
}

export interface RateLookup {
  /** EUR-based rates in basis points, as published. */
  eurRates: Map<string, number>;
}

/**
 * Resolve a rate for any currency pair from EUR-based reference rates.
 *
 * Handles the three cases: a EUR leg in either direction, and a cross rate
 * triangulated through EUR. Returns null rather than a fallback — the caller
 * must decide what to do about a gap, and the pricing engine refuses to price.
 */
export function resolveRateBp(
  baseCurrency: string,
  quoteCurrency: string,
  lookup: RateLookup,
): number | null {
  if (baseCurrency === quoteCurrency) return 10_000;

  const { eurRates } = lookup;

  if (baseCurrency === "EUR") {
    return eurRates.get(quoteCurrency) ?? null;
  }

  if (quoteCurrency === "EUR") {
    const eurToBase = eurRates.get(baseCurrency);
    if (!eurToBase) return null;
    return Math.round((10_000 * 10_000) / eurToBase);
  }

  const eurToBase = eurRates.get(baseCurrency);
  const eurToQuote = eurRates.get(quoteCurrency);
  if (!eurToBase || !eurToQuote) return null;

  return Math.round((eurToQuote * 10_000) / eurToBase);
}
