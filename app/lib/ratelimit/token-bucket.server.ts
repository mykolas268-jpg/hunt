/**
 * Distributed token bucket for supplier rate limiting.
 *
 * The supplier caps us at roughly one request per second PER MERCHANT ACCOUNT,
 * and we run multiple worker processes. An in-memory limiter would let each
 * process spend the same budget independently, so the bucket lives in Postgres
 * and every claim takes a row lock.
 *
 * `SELECT ... FOR UPDATE` inside a transaction is what makes this correct:
 * concurrent workers serialise on the row, so two of them can never observe the
 * same token and both spend it. Without the lock this is a read-modify-write
 * race that looks fine in single-threaded tests and fails in production.
 */

import type { PrismaClient } from "@prisma/client";

export interface BucketConfig {
  /** Maximum tokens the bucket can hold. Controls burst size. */
  capacity: number;
  /** Tokens added per second. For a 1 QPS supplier limit, 1. */
  refillPerSecond: number;
}

export const DEFAULT_BUCKET: BucketConfig = { capacity: 1, refillPerSecond: 1 };

export class RateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Rate limited; retry in ${retryAfterMs}ms`);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface AcquireResult {
  granted: boolean;
  /** Milliseconds until a token is expected to be available. */
  retryAfterMs: number;
  tokensRemaining: number;
}

interface BucketRow {
  id: string;
  tokens: number;
  capacity: number;
  refillPerSecond: number;
  lastRefillAt: Date;
}

/** Create the bucket for an account if it does not exist yet. Idempotent. */
export async function ensureBucket(
  prisma: PrismaClient,
  supplierAccountId: string,
  config: BucketConfig = DEFAULT_BUCKET,
): Promise<void> {
  await prisma.rateBucket.upsert({
    where: { supplierAccountId },
    create: {
      supplierAccountId,
      tokens: config.capacity,
      capacity: config.capacity,
      refillPerSecond: config.refillPerSecond,
      lastRefillAt: new Date(),
    },
    update: {},
  });
}

/**
 * Attempt to take one token. Returns immediately without waiting.
 *
 * Refill is computed lazily from elapsed time rather than by a background
 * timer, so there is no scheduler to keep alive and no drift between processes.
 */
export async function tryAcquire(
  prisma: PrismaClient,
  supplierAccountId: string,
  now: Date = new Date(),
): Promise<AcquireResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<BucketRow[]>`
      SELECT id, tokens, capacity, "refillPerSecond", "lastRefillAt"
      FROM "RateBucket"
      WHERE "supplierAccountId" = ${supplierAccountId}
      FOR UPDATE
    `;

    const bucket = rows[0];
    if (!bucket) {
      throw new Error(
        `No rate bucket for supplier account ${supplierAccountId}. Call ensureBucket() on connect.`,
      );
    }

    const elapsedSeconds = Math.max(0, (now.getTime() - bucket.lastRefillAt.getTime()) / 1000);
    const refilled = Math.min(
      bucket.capacity,
      bucket.tokens + elapsedSeconds * bucket.refillPerSecond,
    );

    if (refilled >= 1) {
      const remaining = refilled - 1;
      await tx.rateBucket.update({
        where: { id: bucket.id },
        data: { tokens: remaining, lastRefillAt: now },
      });
      return { granted: true, retryAfterMs: 0, tokensRemaining: remaining };
    }

    // Persist the partial refill even on refusal, so the elapsed time is not
    // lost and the next caller sees an accurate balance.
    await tx.rateBucket.update({
      where: { id: bucket.id },
      data: { tokens: refilled, lastRefillAt: now },
    });

    const deficit = 1 - refilled;
    const retryAfterMs = Math.ceil((deficit / bucket.refillPerSecond) * 1000);
    return { granted: false, retryAfterMs, tokensRemaining: refilled };
  });
}

export interface AcquireOptions {
  /** Give up after this long. Default 30s — longer than any single job should wait. */
  maxWaitMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Take a token, waiting if necessary.
 *
 * Throws `RateLimitedError` rather than waiting forever: a job that blocks
 * indefinitely on a limiter holds a worker slot hostage and is indistinguishable
 * from a hang. The queue's own retry is the right place to wait longer.
 */
export async function acquire(
  prisma: PrismaClient,
  supplierAccountId: string,
  options: AcquireOptions = {},
): Promise<void> {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const result = await tryAcquire(prisma, supplierAccountId);
    if (result.granted) return;

    const remainingBudget = deadline - Date.now();
    if (remainingBudget <= 0) throw new RateLimitedError(result.retryAfterMs);

    // Small jitter so workers released at the same moment do not re-collide.
    const jitter = Math.floor(Math.random() * 50);
    await sleep(Math.min(result.retryAfterMs + jitter, remainingBudget));
  }
}

/** Run `fn` under the account's rate limit. */
export async function withRateLimit<T>(
  prisma: PrismaClient,
  supplierAccountId: string,
  fn: () => Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  await acquire(prisma, supplierAccountId, options);
  return fn();
}
