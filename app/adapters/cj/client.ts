/**
 * CJ Dropshipping HTTP client.
 *
 * Rate limiting is deliberately NOT handled here. The token bucket is keyed on
 * the merchant's supplier account and lives in Postgres because several worker
 * processes share the budget; a limiter inside this client would only know
 * about its own process. Callers wrap invocations in `withRateLimit`.
 *
 * ⚠️ Endpoint paths and response shapes are unverified against the live API.
 * See the warning in `schemas.ts` and build-plan Task 0.
 */

import { z } from "zod";
import type { SupplierCredentials } from "../types.js";
import { SupplierError } from "../types.js";
import { cjAuthResponse, cjProductResponse, cjStockResponse } from "./schemas.js";

export const CJ_BASE_URL = "https://developers.cjdropshipping.com/api2.0/v1";

/** CJ application-level codes, which arrive inside an HTTP 200 envelope. */
const CJ_OK = 200;

export interface CjClientOptions {
  baseUrl?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Injected for tests so backoff does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CjClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: CjClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? CJ_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /**
   * Exchange email + API key for tokens.
   *
   * CJ's access tokens are long-lived (documented as ~180 days), so this runs
   * at connect time and on scheduled refresh — never in the request path.
   */
  async authenticate(email: string, apiKey: string): Promise<SupplierCredentials> {
    const parsed = await this.request(
      "/authentication/getAccessToken",
      cjAuthResponse,
      { method: "POST", body: { email, password: apiKey } },
    );

    const data = parsed.data;
    if (!data) {
      throw new SupplierError("AUTH_FAILED", "CJ returned no credentials", { retryable: false });
    }
    return toCredentials(data);
  }

  async refresh(refreshToken: string): Promise<SupplierCredentials> {
    const parsed = await this.request(
      "/authentication/refreshAccessToken",
      cjAuthResponse,
      { method: "POST", body: { refreshToken } },
    );
    const data = parsed.data;
    if (!data) {
      throw new SupplierError("AUTH_FAILED", "CJ refused to refresh the token", { retryable: false });
    }
    return toCredentials(data);
  }

  async getProduct(pid: string, accessToken: string) {
    const parsed = await this.request(
      `/product/query?pid=${encodeURIComponent(pid)}`,
      cjProductResponse,
      { method: "GET", accessToken },
    );
    if (!parsed.data) {
      throw new SupplierError("NOT_FOUND", `CJ has no product ${pid}`, { retryable: false });
    }
    return parsed.data;
  }

  async getVariantStock(vids: string[], accessToken: string) {
    if (vids.length === 0) return [];
    const parsed = await this.request(
      `/product/stock/queryByVid?vid=${encodeURIComponent(vids.join(","))}`,
      cjStockResponse,
      { method: "GET", accessToken },
    );
    return parsed.data ?? [];
  }

  /**
   * Issue a request, validate the envelope, and retry transient failures.
   *
   * Retries cover 429, 5xx and network faults. A 4xx other than 429 is a bug in
   * our request or a genuinely missing resource — retrying it just burns the
   * merchant's rate budget on a call that will never succeed.
   */
  private async request<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    init: { method: "GET" | "POST"; body?: unknown; accessToken?: string },
  ): Promise<z.infer<T>> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter, so concurrent workers recovering
        // from the same outage do not resynchronise into another thundering herd.
        const backoff = Math.min(2 ** attempt * 500, 8_000);
        await this.sleep(backoff + Math.floor(Math.random() * 250));
      }

      try {
        return await this.attempt(path, schema, init);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof SupplierError ? error.retryable : true;
        if (!retryable) throw error;
      }
    }

    if (lastError instanceof SupplierError) throw lastError;
    throw new SupplierError("UPSTREAM_ERROR", `CJ request to ${path} failed after retries`, {
      cause: lastError,
    });
  }

  private async attempt<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    init: { method: "GET" | "POST"; body?: unknown; accessToken?: string },
  ): Promise<z.infer<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (init.accessToken) headers["CJ-Access-Token"] = init.accessToken;

      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new SupplierError("UPSTREAM_ERROR", "Network failure calling CJ", {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
      throw new SupplierError("RATE_LIMITED", "CJ rate limit exceeded", {
        retryable: true,
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new SupplierError("TOKEN_EXPIRED", "CJ rejected the access token", { retryable: false });
    }

    if (response.status >= 500) {
      throw new SupplierError("UPSTREAM_ERROR", `CJ returned ${response.status}`, { retryable: true });
    }

    if (!response.ok) {
      throw new SupplierError("UPSTREAM_ERROR", `CJ returned ${response.status}`, { retryable: false });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new SupplierError("MALFORMED_RESPONSE", "CJ returned a non-JSON body", {
        retryable: false,
        cause: error,
      });
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Do not retry: the shape will not change on a second call, and a loud
      // failure here is how schema drift gets noticed instead of silently
      // producing products with missing fields.
      throw new SupplierError(
        "MALFORMED_RESPONSE",
        `CJ response did not match the expected schema: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        { retryable: false, cause: parsed.error },
      );
    }

    const envelope = parsed.data as { code: number; message?: string | null };
    if (envelope.code !== CJ_OK) {
      throw mapApplicationCode(envelope.code, envelope.message ?? "CJ reported an error");
    }

    return parsed.data;
  }
}

/** CJ signals failure inside an HTTP 200 body, so codes are mapped explicitly. */
function mapApplicationCode(code: number, message: string): SupplierError {
  if (code === 401 || code === 403) {
    return new SupplierError("TOKEN_EXPIRED", message, { retryable: false });
  }
  if (code === 404) {
    return new SupplierError("NOT_FOUND", message, { retryable: false });
  }
  if (code === 429) {
    return new SupplierError("RATE_LIMITED", message, { retryable: true, retryAfterMs: 1000 });
  }
  return new SupplierError("UPSTREAM_ERROR", `CJ error ${code}: ${message}`, { retryable: code >= 500 });
}

function toCredentials(data: {
  accessToken: string;
  accessTokenExpiryDate: string;
  refreshToken?: string | null;
  refreshTokenExpiryDate?: string | null;
}): SupplierCredentials {
  return {
    accessToken: data.accessToken,
    accessTokenExpiresAt: parseExpiry(data.accessTokenExpiryDate),
    refreshToken: data.refreshToken ?? null,
    refreshTokenExpiresAt: data.refreshTokenExpiryDate
      ? parseExpiry(data.refreshTokenExpiryDate)
      : null,
  };
}

/**
 * CJ returns expiry as "YYYY-MM-DDTHH:mm:ss" without a zone. Treating a naive
 * timestamp as local time would make expiry wrong by the server's UTC offset,
 * so it is pinned to UTC explicitly.
 */
function parseExpiry(value: string): Date {
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new SupplierError("MALFORMED_RESPONSE", `Unparseable token expiry: ${value}`, {
      retryable: false,
    });
  }
  return date;
}
