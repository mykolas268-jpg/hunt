import { describe, expect, it, vi } from "vitest";
import { SupplierError } from "../types.js";
import { CjClient } from "./client.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function client(fetchImpl: typeof fetch, maxRetries = 3) {
  return new CjClient({ fetchImpl, maxRetries, sleep: async () => {} });
}

const AUTH_OK = {
  code: 200,
  result: true,
  data: {
    accessToken: "at-123",
    accessTokenExpiryDate: "2027-01-01T00:00:00",
    refreshToken: "rt-123",
    refreshTokenExpiryDate: "2027-06-01T00:00:00",
  },
};

describe("authenticate", () => {
  it("returns credentials and parses naive expiry as UTC", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(AUTH_OK)) as unknown as typeof fetch;
    const creds = await client(fetchImpl).authenticate("a@b.com", "key");

    expect(creds.accessToken).toBe("at-123");
    // A naive timestamp read as local time would be wrong by the server offset.
    expect(creds.accessTokenExpiresAt.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(creds.refreshToken).toBe("rt-123");
  });

  it("sends the API key as the password field", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(AUTH_OK)) as unknown as typeof fetch;
    await client(fetchImpl).authenticate("a@b.com", "secret-key");

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.com", password: "secret-key" });
  });

  it("rejects an unparseable expiry rather than defaulting it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 200, data: { ...AUTH_OK.data, accessTokenExpiryDate: "never" } }),
    ) as unknown as typeof fetch;
    await expect(client(fetchImpl).authenticate("a@b.com", "k")).rejects.toThrow(/Unparseable token expiry/);
  });
});

describe("application-level error codes", () => {
  it("maps 404 inside a 200 envelope to NOT_FOUND and does not retry", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 404, message: "product not found", data: null }),
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).getProduct("P1", "at")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps 401 inside a 200 envelope to TOKEN_EXPIRED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 401, message: "token expired", data: null }),
    ) as unknown as typeof fetch;
    await expect(client(fetchImpl).getProduct("P1", "at")).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });
});

describe("retry policy", () => {
  it("retries a 500 and succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls < 3
        ? jsonResponse({ error: "boom" }, 500)
        : jsonResponse({ code: 200, data: { pid: "P1", productNameEn: "x", variants: [{ vid: "V1", variantSellPrice: 1 }] } });
    }) as unknown as typeof fetch;

    const product = await client(fetchImpl).getProduct("P1", "at");
    expect(product.pid).toBe("P1");
    expect(calls).toBe(3);
  });

  it("retries a 429 and surfaces Retry-After", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "slow down" }, 429, { "Retry-After": "2" }),
    ) as unknown as typeof fetch;

    const error = await client(fetchImpl, 1).getProduct("P1", "at").catch((e) => e);
    expect(error).toBeInstanceOf(SupplierError);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterMs).toBe(2000);
  });

  it("retries network failures", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return jsonResponse({ code: 200, data: { pid: "P1", productNameEn: "x", variants: [{ vid: "V1", variantSellPrice: 1 }] } });
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).getProduct("P1", "at")).resolves.toMatchObject({ pid: "P1" });
    expect(calls).toBe(2);
  });

  it("does NOT retry a 400 — it would only burn the rate budget", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad request" }, 400)) as unknown as typeof fetch;
    await expect(client(fetchImpl).getProduct("P1", "at")).rejects.toThrow(SupplierError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a schema mismatch — the shape will not change", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 200, data: { productNameEn: "missing pid" } }),
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).getProduct("P1", "at")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    await expect(client(fetchImpl, 2).getProduct("P1", "at")).rejects.toThrow(SupplierError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("rejects a non-JSON body without retrying", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(client(fetchImpl).getProduct("P1", "at")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });
});

describe("requests", () => {
  it("attaches the access token header", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 200, data: { pid: "P1", productNameEn: "x", variants: [{ vid: "V1", variantSellPrice: 1 }] } }),
    ) as unknown as typeof fetch;

    await client(fetchImpl).getProduct("P1", "token-xyz");
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["CJ-Access-Token"]).toBe("token-xyz");
  });

  it("url-encodes the product id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 200, data: { pid: "a b", productNameEn: "x", variants: [{ vid: "V1", variantSellPrice: 1 }] } }),
    ) as unknown as typeof fetch;

    await client(fetchImpl).getProduct("a b", "at");
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("pid=a%20b");
  });

  it("short-circuits an empty stock query without calling the API", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(client(fetchImpl).getVariantStock([], "at")).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
