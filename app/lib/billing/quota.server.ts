/**
 * Generation quota.
 *
 * Checked BEFORE the Claude call, never after. Checking afterwards means you
 * have already paid for work you cannot bill, which is the wrong way round for
 * the one cost that scales with usage.
 *
 * A credit is one listing generation for one market, including its compliance
 * draft. Metering per product rather than per generation would hand the worst
 * unit economics to the merchants who use the most markets — exactly the ones
 * you want to keep.
 */

import type { PrismaClient } from "@prisma/client";

export interface PlanLimits {
  handle: string;
  creditsPerPeriod: number;
  maxMarkets: number;
  maxMonitoredProducts: number;
  /** Overage is allowed on the upper tiers only. */
  allowOverage: boolean;
}

export const PLANS: Record<string, PlanLimits> = {
  starter: { handle: "starter", creditsPerPeriod: 120, maxMarkets: 1, maxMonitoredProducts: 100, allowOverage: false },
  growth: { handle: "growth", creditsPerPeriod: 240, maxMarkets: 3, maxMonitoredProducts: 500, allowOverage: true },
  scale: { handle: "scale", creditsPerPeriod: 500, maxMarkets: 99, maxMonitoredProducts: 2000, allowOverage: true },
};

/** Applied before a plan is chosen, so a trial cannot be used to bulk-generate. */
export const TRIAL_PLAN: PlanLimits = {
  handle: "trial",
  creditsPerPeriod: 30,
  maxMarkets: 1,
  maxMonitoredProducts: 50,
  allowOverage: false,
};

export function resolvePlan(planHandle: string | null | undefined): PlanLimits {
  if (!planHandle) return TRIAL_PLAN;
  return PLANS[planHandle.toLowerCase()] ?? TRIAL_PLAN;
}

export interface QuotaStatus {
  plan: PlanLimits;
  used: number;
  remaining: number;
  periodStart: Date;
  allowed: boolean;
  /** True when the call proceeds but will be billed as overage. */
  isOverage: boolean;
  reason: string | null;
}

/**
 * Billing periods run from the day of the month the shop installed, matching
 * how Shopify bills, so a merchant's allowance resets when they are charged
 * rather than on an arbitrary calendar boundary.
 */
export function currentPeriodStart(installedAt: Date, now: Date = new Date()): Date {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), installedAt.getUTCDate(), 0, 0, 0, 0),
  );
  if (start.getTime() > now.getTime()) start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}

/**
 * Count successful generations this period and decide whether another is
 * allowed.
 *
 * Only successful generations count. A merchant should not lose a credit
 * because the model refused or the supplier data was unusable — that cost is
 * yours to absorb, and charging for it produces exactly the support
 * conversation you do not want.
 */
export async function checkQuota(
  prisma: PrismaClient,
  shopId: string,
  now: Date = new Date(),
): Promise<QuotaStatus> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) {
    throw new Error(`No shop ${shopId}`);
  }

  const plan = resolvePlan(shop.planHandle);
  const periodStart = currentPeriodStart(shop.installedAt, now);

  const used = await prisma.aiGeneration.count({
    where: { shopId, kind: "LISTING", success: true, createdAt: { gte: periodStart } },
  });

  const remaining = Math.max(0, plan.creditsPerPeriod - used);

  if (remaining > 0) {
    return { plan, used, remaining, periodStart, allowed: true, isOverage: false, reason: null };
  }

  if (plan.allowOverage) {
    return {
      plan, used, remaining: 0, periodStart,
      allowed: true, isOverage: true,
      reason: `Allowance of ${plan.creditsPerPeriod} used; further generations bill as overage.`,
    };
  }

  return {
    plan, used, remaining: 0, periodStart,
    allowed: false, isOverage: false,
    reason:
      `Monthly allowance of ${plan.creditsPerPeriod} generations is used. ` +
      "Upgrade to continue, or wait for the period to reset.",
  };
}

/** Enforce the market cap declared by the plan. */
export async function checkMarketLimit(
  prisma: PrismaClient,
  shopId: string,
): Promise<{ allowed: boolean; reason: string | null }> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`No shop ${shopId}`);

  const plan = resolvePlan(shop.planHandle);
  const markets = await prisma.market.count({ where: { shopId } });

  return markets >= plan.maxMarkets
    ? {
        allowed: false,
        reason: `The ${plan.handle} plan allows ${plan.maxMarkets} market(s). Upgrade to add another.`,
      }
    : { allowed: true, reason: null };
}
