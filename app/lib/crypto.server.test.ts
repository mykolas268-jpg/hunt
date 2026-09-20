import { beforeEach, describe, expect, it } from "vitest";
import { CryptoError, decrypt, decryptNullable, encrypt, encryptNullable, redact, resetKeyCache, safeEqual } from "./crypto.server.js";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  process.env.ENCRYPTION_KEY = VALID_KEY;
  resetKeyCache();
});

describe("encrypt / decrypt", () => {
  it("round-trips a value", () => {
    expect(decrypt(encrypt("cj-api-key-12345"))).toBe("cj-api-key-12345");
  });

  it("round-trips unicode and empty strings", () => {
    expect(decrypt(encrypt("čiurlionis ąžuolas 日本語"))).toBe("čiurlionis ąžuolas 日本語");
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("produces different ciphertext for the same plaintext", () => {
    // A deterministic ciphertext would leak which merchants share a key.
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("emits a versioned four-part payload", () => {
    expect(encrypt("x").split(".")).toHaveLength(4);
    expect(encrypt("x").startsWith("v1.")).toBe(true);
  });
});

describe("tamper detection", () => {
  it("rejects a modified ciphertext body", () => {
    const parts = encrypt("secret").split(".");
    parts[2] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow(CryptoError);
  });

  it("rejects a modified auth tag", () => {
    const parts = encrypt("secret").split(".");
    parts[3] = Buffer.alloc(16, 1).toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow(CryptoError);
  });

  it("rejects a wrong-length IV", () => {
    const parts = encrypt("secret").split(".");
    parts[1] = Buffer.alloc(8, 1).toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow(/Malformed IV/);
  });

  it("rejects an unknown version", () => {
    const parts = encrypt("secret").split(".");
    parts[0] = "v2";
    expect(() => decrypt(parts.join("."))).toThrow(/Unsupported ciphertext version/);
  });

  it("rejects a malformed payload", () => {
    expect(() => decrypt("not-a-ciphertext")).toThrow(CryptoError);
    expect(() => decrypt("")).toThrow(CryptoError);
  });

  it("cannot decrypt with a different key", () => {
    const sealed = encrypt("secret");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    resetKeyCache();
    expect(() => decrypt(sealed)).toThrow(CryptoError);
  });
});

describe("key validation", () => {
  it("fails fast when the key is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    resetKeyCache();
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY is not set/);
  });

  it("fails fast when the key is the wrong length", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    resetKeyCache();
    expect(() => encrypt("x")).toThrow(/must decode to 32 bytes/);
  });
});

describe("nullable helpers", () => {
  it("passes null through", () => {
    expect(encryptNullable(null)).toBeNull();
    expect(encryptNullable("")).toBeNull();
    expect(decryptNullable(null)).toBeNull();
  });
  it("round-trips a present value", () => {
    expect(decryptNullable(encryptNullable("token"))).toBe("token");
  });
});

describe("safeEqual / redact", () => {
  it("compares equal strings", () => expect(safeEqual("abc", "abc")).toBe(true));
  it("rejects different strings", () => expect(safeEqual("abc", "abd")).toBe(false));
  it("rejects different lengths without throwing", () => expect(safeEqual("abc", "abcd")).toBe(false));
  it("redacts a secret", () => expect(redact("supersecretvalue")).toBe("supe***ue"));
  it("redacts a short secret entirely", () => expect(redact("abc")).toBe("***"));
  it("handles absent secrets", () => expect(redact(null)).toBe("<none>"));
});
