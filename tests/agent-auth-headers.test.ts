import { describe, expect, it } from "vitest";

import type { ProviderContext } from "@/agent-auth/contracts";
import { headersAuthMethodRegistration } from "@/agent-auth/static-methods";

function context(config: unknown, securityRevision = 31): ProviderContext {
  return {
    target: { agentConnectionId: "agent-headers", principalId: "principal-1" },
    config,
    securityRevision,
    credentialScope: "connection",
    scopeSubject: "",
  };
}

const configurationFailure = {
  code: "configuration_invalid",
  message: "Invalid configuration for headers authentication",
};

const rejectionDecision = {
  action: "give_up",
  failure: {
    code: "credential_rejected",
    message: "The Agent rejected the configured headers",
  },
};

describe("headers auth method", () => {
  it("requires at least one valid HTTP field name and CR/LF-free values", async () => {
    const validHeaders = {
      "x-api-key": " secret value ",
      "X.Custom_Header~1": "",
    };

    expect(
      headersAuthMethodRegistration.configSchema.safeParse({ headers: validHeaders }),
    ).toMatchObject({ success: true, data: { headers: validHeaders } });
    expect(
      headersAuthMethodRegistration.configSchema.safeParse({ headers: {} }).success,
    ).toBe(false);

    for (const name of ["", "bad name", "bad:name", "ümlaut"]) {
      expect(
        headersAuthMethodRegistration.configSchema.safeParse({ headers: { [name]: "value" } })
          .success,
      ).toBe(false);
    }
    for (const value of ["first\rsecond", "first\nsecond", "first\r\nsecond"]) {
      expect(
        headersAuthMethodRegistration.configSchema.safeParse({ headers: { "x-api-key": value } })
          .success,
      ).toBe(false);
    }

    const config = { headers: validHeaders };
    const result = await headersAuthMethodRegistration.provider.getCredential(context(config));
    expect(result).toEqual({
      ok: true,
      credential: { kind: "headers", headers: validHeaders },
      version: { securityRevision: 31, rotationSeq: null },
    });
    config.headers["x-api-key"] = "changed after snapshot";
    expect(result).toMatchObject({
      credential: { headers: { "x-api-key": " secret value " } },
    });
    await expect(
      headersAuthMethodRegistration.provider.inspect(context({ headers: validHeaders })),
    ).resolves.toEqual({ state: "ok" });
  });

  it("fails closed for malformed config", async () => {
    await expect(
      headersAuthMethodRegistration.provider.getCredential(context({ headers: {} })),
    ).resolves.toEqual({ ok: false, failure: configurationFailure });
    await expect(
      headersAuthMethodRegistration.provider.inspect(
        context({ headers: { "x-api-key": "line one\nline two" } }),
      ),
    ).resolves.toEqual({
      state: "misconfigured",
      message: configurationFailure.message,
    });
  });

  it.each([0, 1] as const)(
    "fails closed when recovering with malformed config at attempt %i",
    async (attempt) => {
      const rejectedVersion = { securityRevision: 31, rotationSeq: null };
      const ctx = context({ headers: {} });
      const decision =
        attempt === 0
          ? headersAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
              rejectedVersion,
              attempt: 0,
            })
          : headersAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
              rejectedVersion,
              attempt: 1,
            });

      await expect(decision).resolves.toEqual({
        action: "give_up",
        failure: configurationFailure,
      });
    },
  );

  it("gives up without retrying on both unauthorized attempts", async () => {
    const ctx = context({ headers: { "x-api-key": "secret" } });
    const rejectedVersion = { securityRevision: 31, rotationSeq: null };

    await expect(
      headersAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
        rejectedVersion,
        attempt: 0,
      }),
    ).resolves.toEqual(rejectionDecision);
    await expect(
      headersAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
        rejectedVersion,
        attempt: 1,
      }),
    ).resolves.toEqual(rejectionDecision);
  });
});
