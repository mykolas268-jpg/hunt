import { describe, expect, it } from "vitest";
import { JOB_NAMES, parseJobPayload } from "./jobs.js";

describe("parseJobPayload", () => {
  it("accepts a valid payload", () => {
    expect(
      parseJobPayload(JOB_NAMES.importProduct, {
        shopId: "s1", supplierAccountId: "a1", supplierProductId: "p1",
      }),
    ).toEqual({ shopId: "s1", supplierAccountId: "a1", supplierProductId: "p1" });
  });

  it("applies declared defaults", () => {
    const payload = parseJobPayload(JOB_NAMES.generateListing, {
      shopId: "s1", productId: "p1", marketId: "m1",
    });
    expect(payload.tone).toBe("professional");
    expect(payload.audienceNote).toBeNull();
  });

  it("rejects a payload missing a required field", () => {
    expect(() => parseJobPayload(JOB_NAMES.importProduct, { shopId: "s1" })).toThrow(
      /Invalid payload for job "import.product"/,
    );
  });

  it("rejects an unknown enum value", () => {
    expect(() =>
      parseJobPayload(JOB_NAMES.generateListing, {
        shopId: "s1", productId: "p1", marketId: "m1", tone: "sarcastic",
      }),
    ).toThrow(/tone/);
  });

  it("rejects a stale payload shape left in the queue by an older deploy", () => {
    // Types vanish at runtime; rows in the queue do not.
    expect(() => parseJobPayload(JOB_NAMES.pushProduct, { shop: "s1", product: "p1" })).toThrow(
      /Invalid payload/,
    );
  });

  it("names every field that failed", () => {
    const error = (() => {
      try { parseJobPayload(JOB_NAMES.pushProduct, {}); } catch (e) { return e as Error; }
    })();
    expect(error?.message).toContain("shopId");
    expect(error?.message).toContain("productId");
    expect(error?.message).toContain("marketId");
  });
});
