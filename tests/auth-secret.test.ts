import { afterEach, describe, expect, it } from "vitest";

import { encryptAuthConfig } from "@/eve/auth";
import { readValidatedAuthSecret } from "@/lib/server/auth-secret";
import { sealValue } from "@/lib/server/sealed-value";

const originalAuthSecret = process.env.AUTH_SECRET;
const TEST_ERROR_MESSAGE = "AUTH_SECRET is invalid for this test";

afterEach(() => {
  if (originalAuthSecret === undefined) {
    delete process.env.AUTH_SECRET;
  } else {
    process.env.AUTH_SECRET = originalAuthSecret;
  }
});

describe("AUTH_SECRET validation", () => {
  it("rejects a missing AUTH_SECRET", () => {
    delete process.env.AUTH_SECRET;

    expect(() => readValidatedAuthSecret(TEST_ERROR_MESSAGE)).toThrowError(TEST_ERROR_MESSAGE);
  });

  it("rejects a whitespace-only AUTH_SECRET", () => {
    Object.assign(process.env, { AUTH_SECRET: [" ", "\t", "\n", " "].join("") });

    expect(() => readValidatedAuthSecret(TEST_ERROR_MESSAGE)).toThrowError(TEST_ERROR_MESSAGE);
  });

  it("rejects the local development AUTH_SECRET placeholder", () => {
    process.env.AUTH_SECRET = ["replace", "with", "local", "dev", "secret"].join("-");

    expect(() => readValidatedAuthSecret(TEST_ERROR_MESSAGE)).toThrowError(TEST_ERROR_MESSAGE);
  });

  it("rejects the alternate local AUTH_SECRET placeholder", () => {
    Object.assign(process.env, { AUTH_SECRET: ["replace", "with", "a", "local", "secret"].join("-") });

    expect(() => readValidatedAuthSecret(TEST_ERROR_MESSAGE)).toThrowError(TEST_ERROR_MESSAGE);
  });

  it("rejects an AUTH_SECRET shorter than 32 bytes", () => {
    process.env.AUTH_SECRET = "s".repeat(31);

    expect(() => readValidatedAuthSecret(TEST_ERROR_MESSAGE)).toThrowError(TEST_ERROR_MESSAGE);
  });

  it("accepts an AUTH_SECRET that is exactly 32 UTF-8 bytes", () => {
    const secret = "é".repeat(16);
    Object.assign(process.env, { AUTH_SECRET: secret });

    expect(readValidatedAuthSecret(TEST_ERROR_MESSAGE)).toBe(secret);
  });

  it("is enforced by sealed values and existing auth config encryption", () => {
    Object.assign(process.env, { AUTH_SECRET: "s".repeat(31) });

    expect(() =>
      sealValue("payload", { purpose: "test", identity: "secret-validation" }),
    ).toThrowError("AUTH_SECRET is required to seal values");
    expect(() => encryptAuthConfig({ token: "payload" })).toThrowError(
      "AUTH_SECRET is required to encrypt agent auth configuration",
    );
  });
});
