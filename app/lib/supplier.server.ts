/**
 * Resolve usable supplier credentials for a merchant.
 *
 * Tokens are refreshed proactively on a margin rather than reactively on a 401.
 * Reacting to failure means every merchant's first job after expiry fails, and
 * on a long-lived token the expiry lands unpredictably.
 */

import type { PrismaClient, SupplierAccount } from "@prisma/client";
import { CjClient } from "../adapters/cj/client.js";
import type { SupplierCredentials } from "../adapters/types.js";
import { SupplierError } from "../adapters/types.js";
import { decrypt, encrypt } from "./crypto.server.js";

/** Refresh this far ahead of expiry. */
const REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

export interface ResolvedSupplier {
  account: SupplierAccount;
  credentials: SupplierCredentials;
  client: CjClient;
}

export async function resolveSupplier(
  prisma: PrismaClient,
  supplierAccountId: string,
  client: CjClient = new CjClient(),
  now: Date = new Date(),
): Promise<ResolvedSupplier> {
  const account = await prisma.supplierAccount.findUnique({ where: { id: supplierAccountId } });
  if (!account) {
    throw new SupplierError("AUTH_FAILED", `No supplier account ${supplierAccountId}`, {
      retryable: false,
    });
  }
  if (account.status === "INVALID") {
    throw new SupplierError("AUTH_FAILED", "Supplier credentials were marked invalid; reconnect required.", {
      retryable: false,
    });
  }

  const needsAuth =
    !account.accessTokenEnc ||
    !account.accessTokenExpiresAt ||
    account.accessTokenExpiresAt.getTime() - now.getTime() < REFRESH_MARGIN_MS;

  if (!needsAuth) {
    return {
      account,
      client,
      credentials: {
        accessToken: decrypt(account.accessTokenEnc as string),
        accessTokenExpiresAt: account.accessTokenExpiresAt as Date,
        refreshToken: account.refreshTokenEnc ? decrypt(account.refreshTokenEnc) : null,
        refreshTokenExpiresAt: account.refreshTokenExpiresAt,
      },
    };
  }

  const credentials = await obtainCredentials(account, client, now);
  const updated = await prisma.supplierAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEnc: encrypt(credentials.accessToken),
      accessTokenExpiresAt: credentials.accessTokenExpiresAt,
      refreshTokenEnc: credentials.refreshToken ? encrypt(credentials.refreshToken) : null,
      refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
      lastAuthAt: now,
      status: "ACTIVE",
      lastError: null,
    },
  });

  return { account: updated, credentials, client };
}

/**
 * Prefer the refresh token; fall back to a full re-authentication with the
 * stored API key. Falling back matters because a refresh token that has itself
 * expired would otherwise strand the merchant behind a reconnect prompt they
 * did nothing to deserve.
 */
async function obtainCredentials(
  account: SupplierAccount,
  client: CjClient,
  now: Date,
): Promise<SupplierCredentials> {
  const refreshUsable =
    account.refreshTokenEnc &&
    account.refreshTokenExpiresAt &&
    account.refreshTokenExpiresAt.getTime() > now.getTime();

  if (refreshUsable) {
    try {
      return await client.refresh(decrypt(account.refreshTokenEnc as string));
    } catch {
      // Fall through to a full re-auth below.
    }
  }

  return client.authenticate(account.email, decrypt(account.apiKeyEnc));
}

/** Record an auth failure so the UI can prompt a reconnect. */
export async function markSupplierInvalid(
  prisma: PrismaClient,
  supplierAccountId: string,
  reason: string,
): Promise<void> {
  await prisma.supplierAccount.update({
    where: { id: supplierAccountId },
    data: { status: "INVALID", lastError: reason.slice(0, 500) },
  });
}
