/**
 * Webhook verification and intake.
 *
 * Three rules govern every handler, and all three are review-blocking:
 *
 *   1. Verify the HMAC before parsing the body. An unverified webhook is an
 *      unauthenticated stranger asking you to delete a merchant's data.
 *   2. Return 200 within 5 seconds. Receive, verify, enqueue, respond — no
 *      supplier calls, no AI calls, no database sweeps inline.
 *   3. Treat every delivery as a possible duplicate. Shopify delivers AT LEAST
 *      ONCE, which is why WebhookEvent.shopifyEventId carries a UNIQUE index.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const MANDATORY_COMPLIANCE_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Verify Shopify's HMAC over the RAW request body.
 *
 * The body must be the exact bytes received. Parsing to JSON and
 * re-serialising changes key order and whitespace, and the signature will
 * never match — a failure that looks like a Shopify bug and is not.
 */
export function verifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string | null | undefined,
  apiSecret: string,
): boolean {
  if (!hmacHeader) return false;
  if (!apiSecret) {
    throw new WebhookVerificationError("SHOPIFY_API_SECRET is not set; cannot verify webhooks.");
  }

  const digest = createHmac("sha256", apiSecret).update(rawBody).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }

  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false.
  if (provided.length !== digest.length) return false;
  return timingSafeEqual(digest, provided);
}

export interface WebhookHeaders {
  hmac: string | null;
  topic: string | null;
  shopDomain: string | null;
  eventId: string | null;
}

/** Pull Shopify's headers, which are case-insensitive on the wire. */
export function readWebhookHeaders(headers: Headers): WebhookHeaders {
  return {
    hmac: headers.get("x-shopify-hmac-sha256"),
    topic: headers.get("x-shopify-topic"),
    shopDomain: headers.get("x-shopify-shop-domain"),
    eventId: headers.get("x-shopify-event-id"),
  };
}

export type IntakeOutcome =
  | { status: "accepted"; webhookEventId: string }
  | { status: "duplicate" }
  | { status: "rejected"; reason: string };

/**
 * Verify and record a delivery.
 *
 * Returns `duplicate` rather than throwing on a replay, because a replay is a
 * normal, expected event that must still be answered with 200 — if Shopify
 * gets an error it retries, and the loop never ends.
 */
export async function intakeWebhook(
  prisma: PrismaClient,
  rawBody: string,
  headers: WebhookHeaders,
  apiSecret: string,
): Promise<IntakeOutcome> {
  if (!verifyWebhookHmac(rawBody, headers.hmac, apiSecret)) {
    return { status: "rejected", reason: "HMAC verification failed" };
  }
  if (!headers.topic || !headers.shopDomain) {
    return { status: "rejected", reason: "Missing topic or shop domain header" };
  }

  // Shopify always sends an event id; falling back to a body hash keeps
  // idempotency working rather than disabling it if one is ever absent.
  const eventId =
    headers.eventId ??
    createHmac("sha256", apiSecret).update(`${headers.topic}:${rawBody}`).digest("hex");

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: "rejected", reason: "Body was not valid JSON" };
  }

  try {
    const record = await prisma.webhookEvent.create({
      data: {
        shopDomain: headers.shopDomain,
        topic: headers.topic,
        shopifyEventId: eventId,
        payload: payload as object,
      },
    });
    return { status: "accepted", webhookEventId: record.id };
  } catch (error) {
    // P2002 is the unique violation on shopifyEventId — precisely the replay
    // the constraint exists to catch.
    if (isUniqueViolation(error)) return { status: "duplicate" };
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Build the `customers/data_request` reply.
 *
 * This app requests no customer scopes and stores no customer records, so the
 * honest answer is that there is nothing to hand over. Saying so explicitly is
 * better than an empty 200, because it is also the answer a reviewer is
 * checking for.
 */
export function buildDataRequestResponse(shopDomain: string): {
  shopDomain: string;
  customerDataHeld: false;
  note: string;
} {
  return {
    shopDomain,
    customerDataHeld: false,
    note:
      "This app holds no customer personal data. It requests only " +
      "write_products, read_locations and write_inventory, and stores product, " +
      "supplier and pricing data scoped to the shop.",
  };
}
