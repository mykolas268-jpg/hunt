import { describe, expect, it, vi } from "vitest";
import { assertNoUserErrors, ShopifyGraphQLClient, ShopifyGraphQLError } from "./graphql-client.server.js";

function gqlResponse(
  data: unknown,
  cost?: { requestedQueryCost?: number; currentlyAvailable?: number; restoreRate?: number; maximumAvailable?: number },
  init: ResponseInit = {},
) {
  const body: Record<string, unknown> = { data };
  if (cost) {
    body.extensions = {
      cost: {
        requestedQueryCost: cost.requestedQueryCost ?? 10,
        actualQueryCost: cost.requestedQueryCost ?? 10,
        throttleStatus: {
          maximumAvailable: cost.maximumAvailable ?? 1000,
          currentlyAvailable: cost.currentlyAvailable ?? 990,
          restoreRate: cost.restoreRate ?? 100,
        },
      },
    };
  }
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

interface Harness {
  client: ShopifyGraphQLClient;
  fetchImpl: ReturnType<typeof vi.fn>;
  slept: number[];
  setNow: (ms: number) => void;
}

function harness(responses: Response[] | (() => Response), options: Record<string, unknown> = {}): Harness {
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fetchImpl = vi.fn(async () =>
    queue ? (queue.shift() ?? gqlResponse({ ok: true })) : (responses as () => Response)(),
  );

  const slept: number[] = [];
  let now = 0;

  const client = new ShopifyGraphQLClient({
    shop: "demo.myshopify.com",
    accessToken: "shpat_test",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async (ms) => { slept.push(ms); },
    now: () => now,
    ...options,
  });

  return { client, fetchImpl, slept, setNow: (ms) => { now = ms; } };
}

describe("requests", () => {
  it("posts to the versioned admin endpoint with the access token", async () => {
    const h = harness([gqlResponse({ shop: { name: "Demo" } })]);
    await h.client.request("{ shop { name } }");

    const [url, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://demo.myshopify.com/admin/api/2025-07/graphql.json");
    expect((init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_test");
  });

  it("returns the data payload", async () => {
    const h = harness([gqlResponse({ shop: { name: "Demo" } })]);
    await expect(h.client.request("{ shop { name } }")).resolves.toEqual({ shop: { name: "Demo" } });
  });

  it("records throttle status from the response", async () => {
    const h = harness([gqlResponse({ ok: true }, { currentlyAvailable: 800, restoreRate: 100 })]);
    await h.client.request("{ ok }");

    expect(h.client.getThrottleStatus()).toMatchObject({ currentlyAvailable: 800, restoreRate: 100 });
  });
});

describe("self-throttling", () => {
  it("does not wait while the bucket is healthy", async () => {
    const h = harness(() => gqlResponse({ ok: true }, { currentlyAvailable: 900, requestedQueryCost: 10 }));
    await h.client.request("{ ok }");
    await h.client.request("{ ok }");
    expect(h.slept).toEqual([]);
  });

  it("waits BEFORE sending once the bucket is nearly drained", async () => {
    // 5 points left, restoring at 100/s, next query costs 10 plus a 50 reserve:
    // it must wait rather than send a request the server would reject.
    const h = harness(() => gqlResponse({ ok: true }, { currentlyAvailable: 5, restoreRate: 100, requestedQueryCost: 10 }));

    await h.client.request("{ ok }");
    expect(h.slept).toEqual([]); // nothing known before the first response

    await h.client.request("{ ok }");
    expect(h.slept).toHaveLength(1);
    expect(h.slept[0]).toBeGreaterThan(0);
    // Deficit is 60 - 5 = 55 points at 100/s = 550ms.
    expect(h.slept[0]).toBe(550);
  });

  it("credits elapsed time against the deficit", async () => {
    const h = harness(() => gqlResponse({ ok: true }, { currentlyAvailable: 5, restoreRate: 100, requestedQueryCost: 10 }));
    await h.client.request("{ ok }");

    // 400ms later the bucket has refilled by 40 points.
    h.setNow(400);
    await h.client.request("{ ok }");
    expect(h.slept[0]).toBe(150); // 60 - (5 + 40) = 15 points at 100/s
  });

  it("never waits for more than the bucket can hold", async () => {
    const h = harness(() =>
      gqlResponse({ ok: true }, { currentlyAvailable: 0, restoreRate: 100, maximumAvailable: 40, requestedQueryCost: 10 }),
    );
    await h.client.request("{ ok }");
    await h.client.request("{ ok }");
    // Needed is capped at maximumAvailable, so this waits 400ms, not forever.
    expect(h.slept[0]).toBe(400);
  });

  it("treats a 429 as a drained bucket and retries", async () => {
    const h = harness([
      gqlResponse({ ok: true }, { currentlyAvailable: 500, restoreRate: 100, requestedQueryCost: 10 }),
      new Response("{}", { status: 429 }),
      gqlResponse({ ok: true }, { currentlyAvailable: 500, restoreRate: 100 }),
    ]);

    await h.client.request("{ ok }");
    await expect(h.client.request("{ ok }")).resolves.toEqual({ ok: true });
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("serialises concurrent callers so they cannot both spend the same points", async () => {
    const h = harness(() => gqlResponse({ ok: true }, { currentlyAvailable: 5, restoreRate: 100, requestedQueryCost: 10 }));

    await Promise.all([
      h.client.request("{ a }"),
      h.client.request("{ b }"),
      h.client.request("{ c }"),
    ]);

    // The first is uninformed; the two that follow each pace themselves.
    expect(h.slept).toHaveLength(2);
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("error handling", () => {
  it("retries a 500", async () => {
    const h = harness([new Response("{}", { status: 500 }), gqlResponse({ ok: true })]);
    await expect(h.client.request("{ ok }")).resolves.toEqual({ ok: true });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an auth failure", async () => {
    const h = harness([new Response("{}", { status: 401 })]);
    await expect(h.client.request("{ ok }")).rejects.toThrow(/rejected the access token/);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a THROTTLED graphql error", async () => {
    const throttled = new Response(
      JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
      { status: 200 },
    );
    const h = harness([throttled, gqlResponse({ ok: true })]);
    await expect(h.client.request("{ ok }")).resolves.toEqual({ ok: true });
  });

  it("does not retry a query validation error", async () => {
    const invalid = new Response(
      JSON.stringify({ errors: [{ message: "Field 'nope' doesn't exist" }] }),
      { status: 200 },
    );
    const h = harness([invalid]);
    await expect(h.client.request("{ nope }")).rejects.toThrow(/doesn't exist/);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const h = harness(() => new Response("{}", { status: 503 }), { maxRetries: 2 });
    await expect(h.client.request("{ ok }")).rejects.toThrow(ShopifyGraphQLError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps working after a request fails", async () => {
    const h = harness([new Response("{}", { status: 401 }), gqlResponse({ ok: true })]);
    await expect(h.client.request("{ a }")).rejects.toThrow();
    // A rejection must not poison the serialisation chain.
    await expect(h.client.request("{ b }")).resolves.toEqual({ ok: true });
  });
});

describe("assertNoUserErrors", () => {
  it("passes when there are none", () => {
    expect(() => assertNoUserErrors({ userErrors: [] }, "productSet")).not.toThrow();
    expect(() => assertNoUserErrors({}, "productSet")).not.toThrow();
  });

  it("throws on a business-rule failure delivered inside an HTTP 200", () => {
    // Without this, a push that created nothing reports success.
    expect(() =>
      assertNoUserErrors(
        { userErrors: [{ field: ["input", "handle"], message: "Handle has already been taken", code: "TAKEN" }] },
        "productSet",
      ),
    ).toThrow(/productSet failed: input.handle: Handle has already been taken \[TAKEN\]/);
  });

  it("reports every user error", () => {
    const error = (() => {
      try {
        assertNoUserErrors(
          { userErrors: [{ message: "a" }, { message: "b" }] },
          "productVariantsBulkCreate",
        );
      } catch (e) { return e as ShopifyGraphQLError; }
    })();
    expect(error?.userErrors).toHaveLength(2);
  });
});
