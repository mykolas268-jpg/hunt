import { describe, expect, it, vi } from "vitest";
import { fetchEcbFeed, FxError, parseEcbFeed, resolveRateBp } from "./fx.js";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01">
  <Cube><Cube time='2026-09-18'>
    <Cube currency='USD' rate='1.0951'/>
    <Cube currency='GBP' rate='0.8420'/>
    <Cube currency='PLN' rate='4.3150'/>
    <Cube currency='SEK' rate='11.2350'/>
  </Cube></Cube>
</gesmes:Envelope>`;

describe("parseEcbFeed", () => {
  it("extracts the publication date", () => {
    expect(parseEcbFeed(FEED).asOfDate).toBe("2026-09-18");
  });

  it("converts rates to basis points", () => {
    const rates = new Map(parseEcbFeed(FEED).rates.map((r) => [r.quoteCurrency, r.rateBp]));
    expect(rates.get("USD")).toBe(10951);
    expect(rates.get("PLN")).toBe(43150);
  });

  it("handles double-quoted attributes", () => {
    const xml = `<Cube time="2026-09-18"><Cube currency="USD" rate="1.1"/></Cube>`;
    expect(parseEcbFeed(xml).rates[0]).toEqual({ quoteCurrency: "USD", rateBp: 11000 });
  });

  it("raises rather than returning nothing when the format changes", () => {
    // A silent empty result would look like "no rates today" and leave stale
    // rates in place indefinitely.
    expect(() => parseEcbFeed("<html>maintenance</html>")).toThrow(FxError);
    expect(() => parseEcbFeed("<Cube time='2026-09-18'></Cube>")).toThrow(/no usable rates/);
  });

  it("skips malformed rate entries without failing the batch", () => {
    const xml = `<Cube time='2026-09-18'><Cube currency='USD' rate='0'/><Cube currency='GBP' rate='0.84'/></Cube>`;
    expect(parseEcbFeed(xml).rates).toEqual([{ quoteCurrency: "GBP", rateBp: 8400 }]);
  });
});

describe("fetchEcbFeed", () => {
  it("parses a successful response", async () => {
    const fetchImpl = vi.fn(async () => new Response(FEED, { status: 200 })) as unknown as typeof fetch;
    await expect(fetchEcbFeed(fetchImpl)).resolves.toMatchObject({ asOfDate: "2026-09-18" });
  });

  it("raises on a non-200", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchEcbFeed(fetchImpl)).rejects.toThrow(/503/);
  });
});

describe("resolveRateBp", () => {
  const lookup = { eurRates: new Map([["USD", 10951], ["PLN", 43150]]) };

  it("returns parity for the same currency", () => {
    expect(resolveRateBp("EUR", "EUR", lookup)).toBe(10_000);
    expect(resolveRateBp("USD", "USD", lookup)).toBe(10_000);
  });

  it("reads a EUR-based rate directly", () => {
    expect(resolveRateBp("EUR", "USD", lookup)).toBe(10951);
  });

  it("inverts for a EUR quote", () => {
    // 1 / 1.0951 = 0.91316...
    expect(resolveRateBp("USD", "EUR", lookup)).toBe(9132);
  });

  it("triangulates a cross rate through EUR", () => {
    // USD -> PLN = 4.3150 / 1.0951 = 3.9403...
    expect(resolveRateBp("USD", "PLN", lookup)).toBe(39403);
  });

  it("returns null for an unknown currency instead of guessing", () => {
    // A fallback of 1.0 here would lose roughly 8% on every order silently.
    expect(resolveRateBp("EUR", "XYZ", lookup)).toBeNull();
    expect(resolveRateBp("XYZ", "EUR", lookup)).toBeNull();
    expect(resolveRateBp("XYZ", "USD", lookup)).toBeNull();
  });

  it("round-trips within rounding tolerance", () => {
    const forward = resolveRateBp("EUR", "USD", lookup) as number;
    const back = resolveRateBp("USD", "EUR", lookup) as number;
    expect(Math.abs((forward * back) / 10_000 - 10_000)).toBeLessThan(5);
  });
});
