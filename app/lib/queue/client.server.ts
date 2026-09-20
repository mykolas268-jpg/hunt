/**
 * pg-boss queue.
 *
 * Postgres-backed rather than Redis-backed. Throughput here is bounded by the
 * supplier's per-merchant rate limit, not by the queue, so BullMQ's advantage
 * would never be exercised — and neither queue offers per-tenant rate limiting
 * for free, so that work is identical either way. Using the database we already
 * run removes a service, a bill and a failure mode.
 *
 * Everything goes through the `JobQueue` interface so swapping to BullMQ later
 * is a contained change rather than a rewrite.
 */

import PgBoss from "pg-boss";
import { JOB_NAMES, parseJobPayload, type JobName, type JobPayload } from "./jobs.js";

export interface JobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue<N extends JobName>(name: N, payload: JobPayload<N>, options?: EnqueueOptions): Promise<string | null>;
  schedule(name: JobName, cron: string, payload: unknown): Promise<void>;
  work<N extends JobName>(name: N, handler: (payload: JobPayload<N>) => Promise<void>): Promise<void>;
}

export interface EnqueueOptions {
  /**
   * Stable key that makes an enqueue idempotent. pg-boss rejects a second job
   * with the same singleton key while one is still active, which is what stops
   * a double-clicked Import button creating two imports.
   */
  singletonKey?: string;
  retryLimit?: number;
  startAfterSeconds?: number;
}

export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private started = false;

  constructor(connectionString: string) {
    this.boss = new PgBoss({
      connectionString,
      // Failures retry with backoff, then land in the dead-letter queue rather
      // than disappearing. An invisible failed import is worse than a loud one.
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      // Completed jobs are kept briefly so a support question can be answered.
      archiveCompletedAfterSeconds: 60 * 60 * 24 * 3,
    });

    this.boss.on("error", (error) => {
      console.error("[queue] pg-boss error", error);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    for (const name of Object.values(JOB_NAMES)) {
      await this.boss.createQueue(name);
    }
    this.started = true;
  }

  /** Finishes in-flight jobs before exiting, so SIGTERM does not lose work. */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true, timeout: 30_000 });
    this.started = false;
  }

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    // Validate on the way in as well as on the way out: a bad payload caught
    // at enqueue time reports to the merchant immediately, rather than failing
    // silently in a worker minutes later.
    parseJobPayload(name, payload);

    return this.boss.send(name, payload as object, {
      retryLimit: options.retryLimit ?? 3,
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    });
  }

  async schedule(name: JobName, cron: string, payload: unknown): Promise<void> {
    await this.boss.schedule(name, cron, payload as object);
  }

  async work<N extends JobName>(
    name: N,
    handler: (payload: JobPayload<N>) => Promise<void>,
  ): Promise<void> {
    await this.boss.work<unknown>(name, async ([job]) => {
      if (!job) return;
      // Parsing here is what turns a stale payload from a deploy into a clean
      // validation failure instead of a crash mid-work.
      const payload = parseJobPayload(name, job.data);
      await handler(payload);
    });
  }
}

let queueSingleton: PgBossQueue | null = null;

export function getQueue(): PgBossQueue {
  if (!queueSingleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set; the queue cannot start.");
    queueSingleton = new PgBossQueue(url);
  }
  return queueSingleton;
}
