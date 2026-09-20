import type { PrismaClient } from "@prisma/client";
import { fetchEcbFeed } from "../../app/lib/pricing/fx.js";

/**
 * Pull the ECB daily reference rates.
 *
 * The feed publishes on European banking days only. Weekend and holiday runs
 * re-upsert the most recent publication rather than writing a gap, so a lookup
 * on a Sunday finds Friday's rate instead of nothing.
 */
export async function refreshFxRates(
  prisma: PrismaClient,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ asOfDate: string; count: number }> {
  const feed = await fetchEcbFeed(fetchImpl);
  const asOfDate = new Date(`${feed.asOfDate}T00:00:00Z`);

  for (const rate of feed.rates) {
    await prisma.fxRate.upsert({
      where: {
        baseCurrency_quoteCurrency_asOfDate: {
          baseCurrency: "EUR",
          quoteCurrency: rate.quoteCurrency,
          asOfDate,
        },
      },
      create: {
        baseCurrency: "EUR",
        quoteCurrency: rate.quoteCurrency,
        rateBp: rate.rateBp,
        asOfDate,
      },
      update: { rateBp: rate.rateBp },
    });
  }

  return { asOfDate: feed.asOfDate, count: feed.rates.length };
}

/** Most recent EUR-based rates at or before `asOf`. */
export async function loadLatestRates(
  prisma: PrismaClient,
  asOf: Date = new Date(),
): Promise<Map<string, number>> {
  const rows = await prisma.fxRate.findMany({
    where: { baseCurrency: "EUR", asOfDate: { lte: asOf } },
    orderBy: { asOfDate: "desc" },
    take: 200,
  });

  const rates = new Map<string, number>();
  // Rows arrive newest-first, so the first sighting of a currency wins and
  // older publications never overwrite a fresher rate.
  for (const row of rows) {
    if (!rates.has(row.quoteCurrency)) rates.set(row.quoteCurrency, row.rateBp);
  }
  return rates;
}
