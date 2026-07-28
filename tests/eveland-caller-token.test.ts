import {
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CallerTokenError,
  createCallerTokenVerifier,
} from "@/identity/server";

const issuer = "https://eveland.example.com";
const projectId = "project_support";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const kid = "key_test";
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const fetch = vi.fn(async () =>
    Response.json({
      keys: [{ ...publicJwk, alg: "ES256", kid, use: "sig" }],
    }),
  );

  function token(
    overrides: Record<string, unknown> = {},
    headerOverrides: Record<string, unknown> = {},
  ): string {
    const now = 1_785_000_000;
    const header = encode({ alg: "ES256", kid, typ: "JWT", ...headerOverrides });
    const payload = encode({
      iss: issuer,
      sub: "ipr_user_1",
      aud: `eveland:project:${projectId}`,
      principal_type: "user",
      realm_id: "irl_account_1",
      agent_url: "https://support.agents.example.com",
      iat: now,
      nbf: now,
      exp: now + 60,
      ...overrides,
    });
    const input = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(input), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return `${input}.${signature}`;
  }

  return {
    fetch,
    token,
    verifier: createCallerTokenVerifier({
      issuer,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch,
      now: () => new Date(1_785_000_010_000),
    }),
  };
}

describe("Eveland Caller Token verifier", () => {
  it("verifies ES256 and returns only the internal identity boundary", async () => {
    const fixture = createFixture();

    await expect(
      fixture.verifier.verifyAuthorization(
        `Bearer ${fixture.token({ name: "Test User", email: "user@example.com" })}`,
        projectId,
      ),
    ).resolves.toEqual({
      issuer,
      principalId: "ipr_user_1",
      realmId: "irl_account_1",
      projectId,
      agentUrl: "https://support.agents.example.com",
      expiresAt: 1_785_000_060,
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.example.com" }],
    ["wrong audience", { aud: "eveland:project:project_other" }],
    ["wrong principal type", { principal_type: "service" }],
    ["missing subject", { sub: "" }],
    ["missing realm", { realm_id: "" }],
    ["invalid Agent URL", { agent_url: "https://attacker.example.com/path" }],
    ["not active yet", { nbf: 1_785_000_020 }],
  ])("rejects %s", async (_name, claims) => {
    const fixture = createFixture();

    await expect(
      fixture.verifier.verifyAuthorization(`Bearer ${fixture.token(claims)}`, projectId),
    ).rejects.toBeInstanceOf(CallerTokenError);
  });

  it("returns a structured expiration error", async () => {
    const fixture = createFixture();

    await expect(
      fixture.verifier.verifyAuthorization(
        `Bearer ${fixture.token({ exp: 1_785_000_009 })}`,
        projectId,
      ),
    ).rejects.toMatchObject({
      code: "caller_token_expired",
      status: 401,
    });
  });

  it("fails closed when JWKS is unavailable", async () => {
    const fixture = createFixture();
    fixture.fetch.mockRejectedValueOnce(new Error("offline"));

    await expect(
      fixture.verifier.verifyAuthorization(`Bearer ${fixture.token()}`, projectId),
    ).rejects.toMatchObject({
      code: "caller_token_verification_unavailable",
      status: 503,
    });
  });

  it("rejects a missing bearer credential", async () => {
    const fixture = createFixture();

    await expect(
      fixture.verifier.verifyAuthorization(null, projectId),
    ).rejects.toMatchObject({
      code: "caller_token_missing",
      status: 401,
    });
  });

  it("verifies an app-scoped identity token with its application audience", async () => {
    const fixture = createFixture();

    await expect(
      fixture.verifier.verifyAppAuthorization(
        `Bearer ${fixture.token({ aud: "eveland:app:eve-chats" })}`,
        "eve-chats",
      ),
    ).resolves.toEqual({
      issuer,
      principalId: "ipr_user_1",
      realmId: "irl_account_1",
      expiresAt: 1_785_000_060,
    });
    await expect(
      fixture.verifier.verifyAppAuthorization(
        `Bearer ${fixture.token()}`,
        "eve-chats",
      ),
    ).rejects.toBeInstanceOf(CallerTokenError);
  });
});
