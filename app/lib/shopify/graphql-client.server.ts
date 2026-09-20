/**
 * Throttle-aware Shopify Admin GraphQL client.
 *
 * Shopify's GraphQL API is rate-limited by calculated query cost against a
 * leaky bucket. Every response reports the bucket's state in
 * `extensions.cost.throttleStatus`, which means throttling is predictable —
 * and a client that waits for a 429 before slowing down is choosing to be
 * surprised by something the server already told it.
 *
 * So this client reads the reported state and paces itself before sending.
 * Restore rates by plan (points/second): Standard 100, Advanced 200,
 * Plus 1000, Enterprise 2000.
 *
 * The other half of the job is `userErrors`. Shopify returns HTTP 200 with a
 * `userErrors` array for business-rule failures — an invalid variant option, a
 * duplicate handle. Treating a 200 as success is how a push silently creates
 * nothing and reports success to the merchant.
 */

export const DEFAULT_API_VERSION = "2025-07";

export class ShopifyGraphQLError extends Error {
  readonly retryable: boolean;
  readonly userErrors: UserError[];
  readonly query: string;

  constructor(
    message: string,
    options: { retryable?: boolean; userErrors?: UserError[]; query?: string } = {},
  ) {
    super(message);
    this.name = "ShopifyGraphQLError";
    this.retryable = options.retryable ?? false;
    this.userErrors = options.userErrors ?? [];
    this.query = options.query ?? "";
  }
}

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: ThrottleStatus;
    };
  };
}

export interface ShopifyClientOptions {
  shop: string;
  accessToken: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  /**
   * Points kept in reserve. Pacing to exactly zero leaves nothing for a
   * concurrent request from another worker on the same shop.
   */
  reservePoints?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ShopifyGraphQLClient {
  private readonly shop: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly reservePoints: number;

  private throttle: ThrottleStatus | null = null;
  private throttleObservedAt = 0;
  private lastQueryCost = 0;

  /** Serialises requests from this instance so pacing is not raced. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: ShopifyClientOptions) {
    this.shop = options.shop;
    this.accessToken = options.accessToken;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.maxRetries = options.maxRetries ?? 3;
    this.reservePoints = options.reservePoints ?? 50;
  }

  /** Bucket state as last reported by the server. Exposed for tests and metrics. */
  getThrottleStatus(): ThrottleStatus | null {
    return this.throttle;
  }

  /**
   * Execute a query or mutation.
   *
   * Calls are queued so that two concurrent callers on the same instance
   * cannot both decide there is capacity for the same points.
   */
  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const run = this.chain.then(
      () => this.executeWithRetry<T>(query, variables),
      () => this.executeWithRetry<T>(query, variables),
    );
    // Keep the chain alive regardless of outcome; a rejection must not poison
    // every subsequent request on this client.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async executeWithRetry<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(2 ** attempt * 400, 8_000);
        await this.sleep(backoff + Math.floor(Math.random() * 200));
      }

      try {
        return await this.execute<T>(query, variables);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ShopifyGraphQLError ? error.retryable : true;
        if (!retryable) throw error;
      }
    }

    if (lastError instanceof ShopifyGraphQLError) throw lastError;
    throw new ShopifyGraphQLError("Shopify request failed after retries", { query });
  }

  private async execute<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    await this.waitForCapacity();

    const response = await this.fetchImpl(
      `https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    if (response.status === 429) {
      // Shopify signals a drained bucket here. Assume empty so the next pass
      // waits for a real refill rather than immediately retrying.
      if (this.throttle) {
        this.throttle = { ...this.throttle, currentlyAvailable: 0 };
        this.throttleObservedAt = this.now();
      }
      throw new ShopifyGraphQLError("Shopify throttled the request", { retryable: true, query });
    }

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyGraphQLError("Shopify rejected the access token", { retryable: false, query });
    }

    if (response.status >= 500) {
      throw new ShopifyGraphQLError(`Shopify returned ${response.status}`, { retryable: true, query });
    }

    if (!response.ok) {
      throw new ShopifyGraphQLError(`Shopify returned ${response.status}`, { retryable: false, query });
    }

    let body: GraphQLResponse<T>;
    try {
      body = (await response.json()) as GraphQLResponse<T>;
    } catch (error) {
      throw new ShopifyGraphQLError("Shopify returned a non-JSON body", { retryable: true, query });
    }

    this.recordCost(body);

    if (body.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
      throw new ShopifyGraphQLError(
        `GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
        { retryable: throttled, query },
      );
    }

    if (!body.data) {
      throw new ShopifyGraphQLError("Shopify returned no data", { retryable: false, query });
    }

    return body.data;
  }

  private recordCost(body: GraphQLResponse<unknown>): void {
    const cost = body.extensions?.cost;
    if (!cost) return;

    if (cost.throttleStatus) {
      this.throttle = cost.throttleStatus;
      this.throttleObservedAt = this.now();
    }
    // Requested cost is the pessimistic figure and the right basis for pacing.
    this.lastQueryCost = cost.requestedQueryCost ?? cost.actualQueryCost ?? this.lastQueryCost;
  }

  /**
   * Wait until the bucket can be expected to cover the next request.
   *
   * Projects the current balance from the last reported state plus elapsed
   * refill, so no request is sent that the server would reject.
   */
  private async waitForCapacity(): Promise<void> {
    if (!this.throttle) return; // No observation yet; the first request informs us.

    const { currentlyAvailable, restoreRate, maximumAvailable } = this.throttle;
    if (restoreRate <= 0) return;

    const elapsedSeconds = Math.max(0, (this.now() - this.throttleObservedAt) / 1000);
    const projected = Math.min(maximumAvailable, currentlyAvailable + elapsedSeconds * restoreRate);

    const needed = Math.min(
      (this.lastQueryCost || 1) + this.reservePoints,
      maximumAvailable,
    );
    if (projected >= needed) return;

    const waitMs = Math.ceil(((needed - projected) / restoreRate) * 1000);
    await this.sleep(waitMs);
  }
}

/**
 * Throw if a mutation payload carries userErrors.
 *
 * Shopify reports business-rule failures inside an HTTP 200. Without this
 * check, a push that created nothing reports success to the merchant, and the
 * failure surfaces days later as "why is my product not in Shopify".
 */
export function assertNoUserErrors(
  payload: { userErrors?: UserError[] | null } | null | undefined,
  operation: string,
): void {
  const errors = payload?.userErrors ?? [];
  if (errors.length === 0) return;

  const detail = errors
    .map((e) => `${e.field?.join(".") ?? "(root)"}: ${e.message}${e.code ? ` [${e.code}]` : ""}`)
    .join("; ");

  throw new ShopifyGraphQLError(`${operation} failed: ${detail}`, { userErrors: errors });
}
