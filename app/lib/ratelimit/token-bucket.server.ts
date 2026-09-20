/**
 * Distributed token bucket for supplier rate limiting.
 *
 * The supplier caps us at roughly one request per second PER MERCHANT ACCOUNT,
 * and we run multiple worker processes. An in-memory limiter would let each
 * process spend the same budget independently, so the bucket lives in Postgres.
 *
 * Correctness rests on each claim being a single atomic UPDATE whose WHERE
 * clause tests the balance. Concurrent workers serialise on the row inside that
 * one statement, so two of them can never observe the same token and both spend
 * it. Read the balance and write it back separately — even across two awaits in
 * the same function — and this becomes a read-modify-write race that passes
 * every single-threaded test and over-grants in production.
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
  // A single UPDATE, not an interactive transaction.
  //
  // The obvious implementation is SELECT ... FOR UPDATE inside a transaction,
  // and it is correct — but it holds a connection for the whole round trip.
  // With many workers contending for one merchant's bucket, that exhausts the
  // Prisma connection pool and callers start failing on the transaction's
  // maxWait rather than being rate limited. The failure is load-dependent, so
  // it surfaces as an intermittent error under exactly the concurrency this
  // module exists to handle.
  //
  // One UPDATE with the refill computed inline is atomic on its own. Postgres
  // takes the row lock for the duration of the statement and, at READ
  // COMMITTED, re-evaluates the WHERE clause against the committed row after
  // acquiring it — so a concurrent claimant sees the decremented balance and
  // cannot spend a token that is already gone. Same guarantee, no transaction,
  // no pool pressure.
  const granted = await prisma.$queryRaw<Array<{ tokensRemaining: number }>>`
    UPDATE "RateBucket" AS b
    SET tokens = LEAST(
          b.capacity,
          b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - b."lastRefillAt"))) * b."refillPerSecond"
        ) - 1,
        "lastRefillAt" = ${now}::timestamptz
    WHERE b."supplierAccountId" = ${supplierAccountId}
      AND LEAST(
            b.capacity,
            b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - b."lastRefillAt"))) * b."refillPerSecond"
          ) >= 1
    RETURNING b.tokens AS "tokensRemaining"
  `;

  if (granted[0]) {
    return { granted: true, retryAfterMs: 0, tokensRemaining: granted[0].tokensRemaining };
  }

  // Refused. Persist the partial refill anyway so elapsed time is not lost and
  // the next caller sees an accurate balance.
  const refused = await prisma.$queryRaw<Array<{ tokensRemaining: number; refillPerSecond: number }>>`
    UPDATE "RateBucket" AS b
    SET tokens = LEAST(
          b.capacity,
          b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - b."lastRefillAt"))) * b."refillPerSecond"
        ),
        "lastRefillAt" = ${now}::timestamptz
    WHERE b."supplierAccountId" = ${supplierAccountId}
    RETURNING b.tokens AS "tokensRemaining", b."refillPerSecond" AS "refillPerSecond"
  `;

  const state = refused[0];
  if (!state) {
    throw new Error(
      `No rate bucket for supplier account ${supplierAccountId}. Call ensureBucket() on connect.`,
    );
  }

  const deficit = 1 - state.tokensRemaining;
  const retryAfterMs = Math.ceil((deficit / state.refillPerSecond) * 1000);
  return { granted: false, retryAfterMs, tokensRemaining: state.tokensRemaining };
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
