/**
 * Integration tests against a real Postgres.
 *
 * These deliberately do not mock the database. The entire correctness argument
 * for this module is that `SELECT ... FOR UPDATE` serialises concurrent
 * claimants — a mock would assert the code I wrote, not the behaviour I need.
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { acquire, ensureBucket, RateLimitedError, tryAcquire, withRateLimit } from "./token-bucket.server.js";

const prisma = new PrismaClient();
let accountId: string;

async function seedAccount(): Promise<string> {
  const shop = await prisma.shop.create({
    data: { shopDomain: `test-${crypto.randomUUID()}.myshopify.com` },
  });
  const account = await prisma.supplierAccount.create({
    data: { shopId: shop.id, email: "t@example.com", apiKeyEnc: "enc" },
  });
  return account.id;
}

beforeEach(async () => {
  accountId = await seedAccount();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: { startsWith: "test-" } } });
  await prisma.$disconnect();
});

describe("ensureBucket", () => {
  it("creates a bucket with full capacity", async () => {
    await ensureBucket(prisma, accountId, { capacity: 5, refillPerSecond: 1 });
    const bucket = await prisma.rateBucket.findUnique({ where: { supplierAccountId: accountId } });
    expect(bucket?.tokens).toBe(5);
    expect(bucket?.capacity).toBe(5);
  });

  it("is idempotent and does not reset a spent bucket", async () => {
    await ensureBucket(prisma, accountId, { capacity: 5, refillPerSecond: 1 });
    await tryAcquire(prisma, accountId);
    await ensureBucket(prisma, accountId, { capacity: 5, refillPerSecond: 1 });
    const bucket = await prisma.rateBucket.findUnique({ where: { supplierAccountId: accountId } });
    expect(bucket?.tokens).toBe(4);
  });
});

describe("tryAcquire", () => {
  it("grants while tokens remain and refuses once spent", async () => {
    await ensureBucket(prisma, accountId, { capacity: 2, refillPerSecond: 1 });
    const now = new Date();
    expect((await tryAcquire(prisma, accountId, now)).granted).toBe(true);
    expect((await tryAcquire(prisma, accountId, now)).granted).toBe(true);

    const third = await tryAcquire(prisma, accountId, now);
    expect(third.granted).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("refills based on elapsed time", async () => {
    await ensureBucket(prisma, accountId, { capacity: 10, refillPerSecond: 1 });
    const start = new Date();
    await prisma.rateBucket.update({
      where: { supplierAccountId: accountId },
      data: { tokens: 0, lastRefillAt: start },
    });

    // Five seconds later, five tokens should be available — and no more.
    const later = new Date(start.getTime() + 5_000);
    let granted = 0;
    for (let i = 0; i < 10; i++) {
      if ((await tryAcquire(prisma, accountId, later)).granted) granted++;
    }
    expect(granted).toBe(5);
  });

  it("never refills beyond capacity", async () => {
    await ensureBucket(prisma, accountId, { capacity: 3, refillPerSecond: 1 });
    const start = new Date();
    await prisma.rateBucket.update({
      where: { supplierAccountId: accountId },
      data: { tokens: 0, lastRefillAt: start },
    });

    // An hour of idle time must not bank an hour of requests.
    const muchLater = new Date(start.getTime() + 3_600_000);
    let granted = 0;
    for (let i = 0; i < 10; i++) {
      if ((await tryAcquire(prisma, accountId, muchLater)).granted) granted++;
    }
    expect(granted).toBe(3);
  });

  it("throws when the bucket does not exist", async () => {
    await expect(tryAcquire(prisma, accountId)).rejects.toThrow(/No rate bucket/);
  });

  it("isolates buckets between accounts", async () => {
    const otherId = await seedAccount();
    await ensureBucket(prisma, accountId, { capacity: 1, refillPerSecond: 1 });
    await ensureBucket(prisma, otherId, { capacity: 1, refillPerSecond: 1 });

    const now = new Date();
    expect((await tryAcquire(prisma, accountId, now)).granted).toBe(true);
    // Spending one merchant's budget must not affect another's.
    expect((await tryAcquire(prisma, otherId, now)).granted).toBe(true);
  });
});

describe("concurrency — the reason this lives in Postgres", () => {
  it("grants exactly one token to ten simultaneous claimants", async () => {
    await ensureBucket(prisma, accountId, { capacity: 1, refillPerSecond: 1 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => tryAcquire(prisma, accountId)),
    );

    // Without FOR UPDATE this is a read-modify-write race and several callers
    // observe the same single token. Exactly one may win.
    expect(results.filter((r) => r.granted)).toHaveLength(1);
  });

  it("holds up at a concurrency that exhausts a connection pool", async () => {
    // The earlier implementation wrapped each claim in a Prisma interactive
    // transaction. Forty concurrent claims exceed the default pool, so callers
    // began failing on the transaction's maxWait instead of being rate
    // limited — an intermittent error under exactly the load this module
    // exists to handle. A single atomic UPDATE has no such ceiling.
    await ensureBucket(prisma, accountId, { capacity: 5, refillPerSecond: 0.0001 });

    const results = await Promise.all(
      Array.from({ length: 40 }, () => tryAcquire(prisma, accountId)),
    );

    expect(results.filter((r) => r.granted)).toHaveLength(5);
    expect(results.every((r) => Number.isFinite(r.tokensRemaining))).toBe(true);
  });

  it("never over-grants across repeated concurrent bursts", async () => {
    await ensureBucket(prisma, accountId, { capacity: 3, refillPerSecond: 0.0001 });

    let granted = 0;
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => tryAcquire(prisma, accountId)),
      );
      granted += results.filter((r) => r.granted).length;
    }
    // Capacity 3 plus a negligible refill rate: 32 attempts, at most 3 wins.
    expect(granted).toBe(3);
  });
});

describe("acquire", () => {
  it("returns once a token is available", async () => {
    await ensureBucket(prisma, accountId, { capacity: 1, refillPerSecond: 1 });
    await expect(acquire(prisma, accountId)).resolves.toBeUndefined();
  });

  it("waits and retries rather than failing immediately", async () => {
    await ensureBucket(prisma, accountId, { capacity: 1, refillPerSecond: 100 });
    await tryAcquire(prisma, accountId);

    const slept: number[] = [];
    await acquire(prisma, accountId, {
      maxWaitMs: 5_000,
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(slept.length).toBeGreaterThan(0);
  });

  it("gives up rather than blocking a worker forever", async () => {
    await ensureBucket(prisma, accountId, { capacity: 1, refillPerSecond: 0.00001 });
    await tryAcquire(prisma, accountId);

    await expect(
      acquire(prisma, accountId, { maxWaitMs: 1, sleep: async () => {} }),
    ).rejects.toThrow(RateLimitedError);
  });
});

describe("withRateLimit", () => {
  it("runs the callback and returns its value", async () => {
    await ensureBucket(prisma, accountId, { capacity: 1, refillPerSecond: 1 });
    await expect(withRateLimit(prisma, accountId, async () => "done")).resolves.toBe("done");
  });

  it("propagates callback errors without swallowing them", async () => {
    await ensureBucket(prisma, accountId, { capacity: 1, refillPerSecond: 1 });
    await expect(
      withRateLimit(prisma, accountId, async () => { throw new Error("upstream 500"); }),
    ).rejects.toThrow("upstream 500");
  });
});
