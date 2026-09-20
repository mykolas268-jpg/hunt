import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { checkMarketLimit, checkQuota, currentPeriodStart, PLANS, resolvePlan, TRIAL_PLAN } from "./quota.server.js";

const prisma = new PrismaClient();

async function seedShop(planHandle: string | null, installedAt: Date) {
  return prisma.shop.create({
    data: { shopDomain: `quota-${crypto.randomUUID()}.myshopify.com`, planHandle, installedAt },
  });
}

async function addGenerations(shopId: string, count: number, createdAt: Date, success = true) {
  for (let i = 0; i < count; i++) {
    await prisma.aiGeneration.create({
      data: { shopId, kind: "LISTING", model: "claude-opus-5", promptVersion: "listing-v1", success, createdAt },
    });
  }
}

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: { startsWith: "quota-" } } });
  await prisma.$disconnect();
});

describe("resolvePlan", () => {
  it("resolves known plans", () => {
    expect(resolvePlan("growth")).toBe(PLANS.growth);
    expect(resolvePlan("SCALE")).toBe(PLANS.scale);
  });

  it("falls back to the trial plan for unknown or absent handles", () => {
    // A generous fallback would let an unrecognised handle bulk-generate.
    expect(resolvePlan(null)).toBe(TRIAL_PLAN);
    expect(resolvePlan("enterprise-custom")).toBe(TRIAL_PLAN);
  });
});

describe("currentPeriodStart", () => {
  it("anchors to the install day of the month", () => {
    const installed = new Date("2026-01-14T10:00:00Z");
    const start = currentPeriodStart(installed, new Date("2026-09-20T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("rolls back a month when the anchor day has not yet arrived", () => {
    const installed = new Date("2026-01-25T10:00:00Z");
    const start = currentPeriodStart(installed, new Date("2026-09-20T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });
});

describe("checkQuota", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const installed = new Date("2026-01-05T00:00:00Z");

  it("allows generation while credits remain", async () => {
    const shop = await seedShop("growth", installed);
    await addGenerations(shop.id, 10, new Date("2026-09-10T00:00:00Z"));

    const status = await checkQuota(prisma, shop.id, now);
    expect(status.allowed).toBe(true);
    expect(status.used).toBe(10);
    expect(status.remaining).toBe(230);
  });

  it("does not count generations from an earlier period", async () => {
    const shop = await seedShop("growth", installed);
    await addGenerations(shop.id, 50, new Date("2026-08-10T00:00:00Z"));

    expect((await checkQuota(prisma, shop.id, now)).used).toBe(0);
  });

  it("does not charge a credit for a failed generation", async () => {
    // A refusal or unusable supplier data is our cost to absorb, not theirs.
    const shop = await seedShop("growth", installed);
    await addGenerations(shop.id, 5, new Date("2026-09-10T00:00:00Z"), false);

    expect((await checkQuota(prisma, shop.id, now)).used).toBe(0);
  });

  it("blocks a starter shop at its limit rather than billing overage", async () => {
    const shop = await seedShop("starter", installed);
    await addGenerations(shop.id, 120, new Date("2026-09-10T00:00:00Z"));

    const status = await checkQuota(prisma, shop.id, now);
    expect(status.allowed).toBe(false);
    expect(status.isOverage).toBe(false);
    expect(status.reason).toContain("Upgrade to continue");
  });

  it("permits overage on a plan that allows it", async () => {
    const shop = await seedShop("growth", installed);
    await addGenerations(shop.id, 240, new Date("2026-09-10T00:00:00Z"));

    const status = await checkQuota(prisma, shop.id, now);
    expect(status.allowed).toBe(true);
    expect(status.isOverage).toBe(true);
  });

  it("holds a trial shop to the trial allowance", async () => {
    const shop = await seedShop(null, installed);
    await addGenerations(shop.id, 30, new Date("2026-09-10T00:00:00Z"));

    const status = await checkQuota(prisma, shop.id, now);
    expect(status.plan.handle).toBe("trial");
    expect(status.allowed).toBe(false);
  });
});

describe("checkMarketLimit", () => {
  it("permits a market below the plan cap", async () => {
    const shop = await seedShop("growth", new Date("2026-01-05T00:00:00Z"));
    await prisma.market.create({
      data: { shopId: shop.id, countryCode: "DE", languageCode: "de", currencyCode: "EUR", vatRateBp: 1900 },
    });

    expect((await checkMarketLimit(prisma, shop.id)).allowed).toBe(true);
  });

  it("blocks a market at the plan cap", async () => {
    const shop = await seedShop("starter", new Date("2026-01-05T00:00:00Z"));
    await prisma.market.create({
      data: { shopId: shop.id, countryCode: "DE", languageCode: "de", currencyCode: "EUR", vatRateBp: 1900 },
    });

    const result = await checkMarketLimit(prisma, shop.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("allows 1 market");
  });
});
