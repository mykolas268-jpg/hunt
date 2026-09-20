import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildDataRequestResponse,
  intakeWebhook,
  readWebhookHeaders,
  verifyWebhookHmac,
  WebhookVerificationError,
} from "./webhooks.server.js";

const SECRET = "shpss_test_secret";
const prisma = new PrismaClient();

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function headers(body: string, overrides: Record<string, string | null> = {}) {
  return {
    hmac: sign(body),
    topic: "shop/redact",
    shopDomain: "hooktest.myshopify.com",
    eventId: `evt-${crypto.randomUUID()}`,
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: { startsWith: "hooktest" } } });
});

afterAll(async () => {
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: { startsWith: "hooktest" } } });
  await prisma.$disconnect();
});

describe("verifyWebhookHmac", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"shop_id":123}';
    expect(verifyWebhookHmac(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a body modified after signing", () => {
    const body = '{"shop_id":123}';
    expect(verifyWebhookHmac('{"shop_id":999}', sign(body), SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const body = '{"shop_id":123}';
    expect(verifyWebhookHmac(body, sign(body, "wrong"), SECRET)).toBe(false);
  });

  it("rejects a missing header without throwing", () => {
    expect(verifyWebhookHmac("{}", null, SECRET)).toBe(false);
    expect(verifyWebhookHmac("{}", undefined, SECRET)).toBe(false);
  });

  it("rejects a wrong-length signature without throwing", () => {
    // timingSafeEqual throws on length mismatch, so this must be guarded.
    expect(verifyWebhookHmac("{}", Buffer.from("short").toString("base64"), SECRET)).toBe(false);
  });

  it("is byte-exact — reserialised JSON does not verify", () => {
    // Re-serialising drops the original whitespace, so the bytes differ even
    // though the value is identical. This is the failure that looks like a
    // Shopify bug and is not: the raw body must be signed, never a reparse.
    const raw = '{"shop_id": 123, "shop_domain": "demo.myshopify.com"}';
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect(verifyWebhookHmac(reserialised, sign(raw), SECRET)).toBe(false);
  });

  it("verifies a Buffer body identically to a string", () => {
    const body = '{"shop_id":123}';
    expect(verifyWebhookHmac(Buffer.from(body, "utf8"), sign(body), SECRET)).toBe(true);
  });

  it("fails loudly when the secret is not configured", () => {
    expect(() => verifyWebhookHmac("{}", "abc", "")).toThrow(WebhookVerificationError);
  });
});

describe("readWebhookHeaders", () => {
  it("reads Shopify headers case-insensitively", () => {
    const parsed = readWebhookHeaders(
      new Headers({
        "X-Shopify-Hmac-Sha256": "sig",
        "x-shopify-topic": "app/uninstalled",
        "X-Shopify-Shop-Domain": "demo.myshopify.com",
        "x-shopify-event-id": "evt-1",
      }),
    );
    expect(parsed).toEqual({
      hmac: "sig", topic: "app/uninstalled",
      shopDomain: "demo.myshopify.com", eventId: "evt-1",
    });
  });

  it("returns nulls for absent headers", () => {
    expect(readWebhookHeaders(new Headers()).hmac).toBeNull();
  });
});

describe("intakeWebhook", () => {
  it("accepts and records a valid delivery", async () => {
    const body = '{"shop_id":1,"shop_domain":"hooktest.myshopify.com"}';
    const result = await intakeWebhook(prisma, body, headers(body), SECRET);

    expect(result.status).toBe("accepted");
    const stored = await prisma.webhookEvent.findFirst({ where: { shopDomain: "hooktest.myshopify.com" } });
    expect(stored?.topic).toBe("shop/redact");
  });

  it("reports a replay as duplicate, not as an error", async () => {
    // An error response makes Shopify retry, and the loop never ends.
    const body = '{"shop_id":1}';
    const h = headers(body);

    expect((await intakeWebhook(prisma, body, h, SECRET)).status).toBe("accepted");
    expect((await intakeWebhook(prisma, body, h, SECRET)).status).toBe("duplicate");
    expect(await prisma.webhookEvent.count({ where: { shopDomain: "hooktest.myshopify.com" } })).toBe(1);
  });

  it("rejects an unsigned delivery before touching the database", async () => {
    const body = '{"shop_id":1}';
    const result = await intakeWebhook(prisma, body, headers(body, { hmac: null }), SECRET);

    expect(result).toEqual({ status: "rejected", reason: "HMAC verification failed" });
    expect(await prisma.webhookEvent.count({ where: { shopDomain: "hooktest.myshopify.com" } })).toBe(0);
  });

  it("rejects a forged body", async () => {
    const body = '{"shop_id":1}';
    const h = headers(body);
    const result = await intakeWebhook(prisma, '{"shop_id":666}', h, SECRET);
    expect(result.status).toBe("rejected");
  });

  it("rejects a delivery missing topic or shop domain", async () => {
    const body = '{"shop_id":1}';
    expect((await intakeWebhook(prisma, body, headers(body, { topic: null }), SECRET)).status).toBe("rejected");
    expect((await intakeWebhook(prisma, body, headers(body, { shopDomain: null }), SECRET)).status).toBe("rejected");
  });

  it("rejects a non-JSON body", async () => {
    const body = "not json";
    const result = await intakeWebhook(prisma, body, headers(body), SECRET);
    expect(result).toMatchObject({ status: "rejected", reason: "Body was not valid JSON" });
  });

  it("stays idempotent when the event id header is absent", async () => {
    const body = '{"shop_id":1}';
    const h = headers(body, { eventId: null });

    expect((await intakeWebhook(prisma, body, h, SECRET)).status).toBe("accepted");
    expect((await intakeWebhook(prisma, body, h, SECRET)).status).toBe("duplicate");
  });

  it("treats different events on one shop as distinct", async () => {
    const body = '{"shop_id":1}';
    await intakeWebhook(prisma, body, headers(body), SECRET);
    await intakeWebhook(prisma, body, headers(body), SECRET);
    expect(await prisma.webhookEvent.count({ where: { shopDomain: "hooktest.myshopify.com" } })).toBe(2);
  });
});

describe("buildDataRequestResponse", () => {
  it("states plainly that no customer data is held", () => {
    const response = buildDataRequestResponse("demo.myshopify.com");
    expect(response.customerDataHeld).toBe(false);
    expect(response.note).toContain("no customer personal data");
  });
});
