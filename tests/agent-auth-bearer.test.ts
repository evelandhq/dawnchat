import { describe, expect, it } from "vitest";

import type { ProviderContext } from "@/agent-auth/contracts";
import { bearerAuthMethodRegistration } from "@/agent-auth/static-methods";

function context(config: unknown, securityRevision = 23): ProviderContext {
  return {
    target: { agentConnectionId: "agent-bearer", principalId: "principal-1" },
    config,
    securityRevision,
    credentialScope: "connection",
    scopeSubject: "",
  };
}

const configurationFailure = {
  code: "configuration_invalid",
  message: "Invalid configuration for bearer authentication",
};

const rejectionDecision = {
  action: "give_up",
  failure: {
    code: "credential_rejected",
    message: "The Agent rejected the configured Bearer token",
  },
};

describe("bearer auth method", () => {
  it("requires a nonblank token and applies Bearer trim normalization", async () => {
    expect(
      bearerAuthMethodRegistration.configSchema.safeParse({ token: " \t ey.token.value \r\n" }),
    ).toMatchObject({ success: true, data: { token: "ey.token.value" } });
    expect(
      bearerAuthMethodRegistration.configSchema.safeParse({ token: " \t\r\n " }).success,
    ).toBe(false);
    expect(bearerAuthMethodRegistration.configSchema.safeParse({}).success).toBe(false);

    await expect(
      bearerAuthMethodRegistration.provider.getCredential(
        context({ token: " \t ey.token.value \r\n" }),
      ),
    ).resolves.toEqual({
      ok: true,
      credential: { kind: "bearer", token: "ey.token.value" },
      version: { securityRevision: 23, rotationSeq: null },
    });
    await expect(
      bearerAuthMethodRegistration.provider.inspect(context({ token: "token" })),
    ).resolves.toEqual({ state: "ok" });
  });

  it("fails closed for malformed config", async () => {
    await expect(
      bearerAuthMethodRegistration.provider.getCredential(context({ token: "   " })),
    ).resolves.toEqual({ ok: false, failure: configurationFailure });
    await expect(
      bearerAuthMethodRegistration.provider.inspect(context({ token: 42 })),
    ).resolves.toEqual({
      state: "misconfigured",
      message: configurationFailure.message,
    });
  });

  it.each([0, 1] as const)(
    "fails closed when recovering with malformed config at attempt %i",
    async (attempt) => {
      const rejectedVersion = { securityRevision: 23, rotationSeq: null };
      const ctx = context({ token: 42 });
      const decision =
        attempt === 0
          ? bearerAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
              rejectedVersion,
              attempt: 0,
            })
          : bearerAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
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
    const ctx = context({ token: "token" });
    const rejectedVersion = { securityRevision: 23, rotationSeq: null };

    await expect(
      bearerAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
        rejectedVersion,
        attempt: 0,
      }),
    ).resolves.toEqual(rejectionDecision);
    await expect(
      bearerAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
        rejectedVersion,
        attempt: 1,
      }),
    ).resolves.toEqual(rejectionDecision);
  });
});
