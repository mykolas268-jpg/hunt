/**
 * Authenticated encryption for supplier credentials at rest.
 *
 * Threat model: an attacker who obtains a database dump must not be able to
 * read a merchant's supplier API key and drain their balance. The encryption
 * key lives only in the environment, never in the database.
 *
 * AES-256-GCM is used rather than CBC so that tampering is detected rather than
 * silently decrypting to garbage.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;
const VERSION = "v1";

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

let cachedKey: Buffer | null = null;

/**
 * Resolve the encryption key from the environment.
 *
 * Fails at first use rather than returning a default, so a misconfigured
 * deployment cannot silently write unencrypted or undecryptable data.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new CryptoError(
      "ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new CryptoError("ENCRYPTION_KEY is not valid base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  cachedKey = key;
  return key;
}

/** Test seam: forget the memoised key so a changed env var is picked up. */
export function resetKeyCache(): void {
  cachedKey = null;
}

/**
 * Encrypt a UTF-8 string.
 *
 * Output format: `v1.<iv>.<ciphertext>.<authTag>`, all base64url. The version
 * prefix exists so the key can be rotated later without guessing at the format
 * of existing rows.
 */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new CryptoError("encrypt expects a string");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a value produced by `encrypt`.
 *
 * Throws on any tampering, truncation or key mismatch. It never returns a
 * partially-trusted value — a caller that receives a string from this function
 * can rely on it being exactly what was encrypted.
 */
export function decrypt(payload: string): string {
  if (typeof payload !== "string" || payload.length === 0) {
    throw new CryptoError("decrypt expects a non-empty string");
  }

  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new CryptoError("Malformed ciphertext: expected 4 dot-separated parts");
  }

  const [version, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  if (version !== VERSION) {
    throw new CryptoError(`Unsupported ciphertext version: ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");

  if (iv.length !== IV_BYTES) {
    throw new CryptoError(`Malformed IV: expected ${IV_BYTES} bytes, got ${iv.length}`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new CryptoError(`Malformed auth tag: expected ${TAG_BYTES} bytes, got ${tag.length}`);
  }

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Deliberately opaque: do not tell an attacker which part failed.
    throw new CryptoError("Decryption failed: ciphertext was tampered with or the key is wrong");
  }
}

/** Encrypt only when a value is present, for nullable credential columns. */
export function encryptNullable(plaintext: string | null | undefined): string | null {
  return plaintext == null || plaintext === "" ? null : encrypt(plaintext);
}

export function decryptNullable(payload: string | null | undefined): string | null {
  return payload == null || payload === "" ? null : decrypt(payload);
}

/** Constant-time comparison, for webhook HMACs and similar. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Redact a secret for logs. Never log the real value. */
export function redact(secret: string | null | undefined): string {
  if (!secret) return "<none>";
  if (secret.length <= 8) return "***";
  return `${secret.slice(0, 4)}***${secret.slice(-2)}`;
}
