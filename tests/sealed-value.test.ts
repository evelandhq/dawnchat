import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InvalidSealedValueError, sealValue, unsealValue } from "@/lib/server/sealed-value";

const originalAuthSecret = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = "test-only-auth-secret-with-enough-entropy";
});

afterEach(() => {
  if (originalAuthSecret === undefined) {
    delete process.env.AUTH_SECRET;
  } else {
    process.env.AUTH_SECRET = originalAuthSecret;
  }
});

describe("sealed values", () => {
  it("roundtrips a value without exposing its plaintext", () => {
    const plaintext = JSON.stringify({ accessToken: "highly-sensitive-token" });
    const context = { purpose: "agent-credential", identity: "agent_123:1:principal_user_456" };

    const sealed = sealValue(plaintext, context);

    expect(sealed).toMatch(/^sealed:v1:k1:/);
    expect(sealed).not.toContain("highly-sensitive-token");
    expect(unsealValue(sealed, context)).toBe(plaintext);
  });

  it("roundtrips an empty plaintext", () => {
    const context = { purpose: "agent-credential", identity: "empty-payload" };

    const sealed = sealValue(String(), context);

    expect(sealed.endsWith(".")).toBe(true);
    expect(unsealValue(sealed, context)).toBe(String());
  });

  it("rejects base64url segments containing invalid characters", () => {
    const context = { purpose: "agent-credential", identity: "invalid-character" };
    const sealed = sealValue("payload", context);
    const ivEnd = sealed.indexOf(".", "sealed:v1:k1:".length);
    const malformed = `${sealed.slice(0, ivEnd)}*${sealed.slice(ivEnd)}`;

    expect(() => unsealValue(malformed, context)).toThrowError(InvalidSealedValueError);
    expect(() => unsealValue(malformed, context)).toThrowError("Invalid sealed value");
  });

  it("rejects a truncated envelope", () => {
    const context = { purpose: "agent-credential", identity: "truncated-envelope" };
    const sealed = sealValue("payload", context);
    const truncated = sealed.slice(0, sealed.lastIndexOf("."));

    expect(() => unsealValue(truncated, context)).toThrowError(InvalidSealedValueError);
    expect(() => unsealValue(truncated, context)).toThrowError("Invalid sealed value");
  });

  it("rejects an envelope with an extra segment", () => {
    const context = { purpose: "agent-credential", identity: "extra-segment" };
    const sealed = sealValue("payload", context);
    const malformed = `${sealed}.extra`;

    expect(() => unsealValue(malformed, context)).toThrowError(InvalidSealedValueError);
    expect(() => unsealValue(malformed, context)).toThrowError("Invalid sealed value");
  });

  it("rejects an unknown format version", () => {
    const context = { purpose: "agent-credential", identity: "format-version" };
    const sealed = sealValue("payload", context);
    const unsupported = sealed.replace("sealed:v1:k1:", "sealed:v2:k1:");

    expect(() => unsealValue(unsupported, context)).toThrowError(InvalidSealedValueError);
    expect(() => unsealValue(unsupported, context)).toThrowError("Invalid sealed value");
  });

  it("rejects an unknown key version", () => {
    const context = { purpose: "agent-credential", identity: "key-version" };
    const sealed = sealValue("payload", context);
    const unsupported = sealed.replace("sealed:v1:k1:", "sealed:v1:k2:");

    expect(() => unsealValue(unsupported, context)).toThrowError(InvalidSealedValueError);
    expect(() => unsealValue(unsupported, context)).toThrowError("Invalid sealed value");
  });

  it("rejects padded and otherwise noncanonical base64url segments", () => {
    const context = { purpose: "agent-credential", identity: "noncanonical-segment" };
    const sealed = sealValue("payload", context);
    const prefix = "sealed:v1:k1:";
    const [iv, tag, ciphertext] = sealed.slice(prefix.length).split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const tagLastCharacter = tag.at(-1)!;
    const noncanonicalTag = `${tag.slice(0, -1)}${alphabet[alphabet.indexOf(tagLastCharacter) + 1]}`;
    const malformed = [
      `${prefix}${iv}=.${tag}.${ciphertext}`,
      `${prefix}${iv}.${noncanonicalTag}.${ciphertext}`,
    ];

    for (const value of malformed) {
      expect(() => unsealValue(value, context)).toThrowError(InvalidSealedValueError);
      expect(() => unsealValue(value, context)).toThrowError("Invalid sealed value");
    }
  });

  it("fails closed for the wrong identity, wrong purpose, and tampering", () => {
    const context = { purpose: "agent-credential", identity: "agent_123:1:principal_user_456" };
    const sealed = sealValue("sensitive payload", context);
    const ciphertextOffset = sealed.lastIndexOf(".") + 1;
    const ciphertext = sealed.slice(ciphertextOffset);
    const replacement = ciphertext[0] === "A" ? "B" : "A";
    const tampered = `${sealed.slice(0, ciphertextOffset)}${replacement}${ciphertext.slice(1)}`;
    const attempts = [
      () => unsealValue(sealed, { ...context, identity: "agent_999:1:principal_user_456" }),
      () => unsealValue(sealed, { ...context, purpose: "authorization-transaction" }),
      () => unsealValue(tampered, context),
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrowError(InvalidSealedValueError);
      expect(attempt).toThrowError("Invalid sealed value");
    }
  });
});
