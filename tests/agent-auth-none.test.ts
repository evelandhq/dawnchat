import { describe, expect, it } from "vitest";

import type { ProviderContext } from "@/agent-auth/contracts";
import { noneAuthMethodRegistration } from "@/agent-auth/static-methods";

function context(config: unknown, securityRevision = 7): ProviderContext {
  return {
    target: { agentConnectionId: "agent-1", principalId: "principal-1" },
    config,
    securityRevision,
    credentialScope: "connection",
    scopeSubject: "",
  };
}

describe("none auth method", () => {
  it("accepts only an empty config and returns a versioned none credential", async () => {
    expect(noneAuthMethodRegistration.method).toBe("none");
    expect(noneAuthMethodRegistration.credentialScope).toBe("connection");
    expect(noneAuthMethodRegistration.configSchema.safeParse({}).success).toBe(true);
    expect(noneAuthMethodRegistration.configSchema.safeParse({ unexpected: true }).success).toBe(
      false,
    );

    await expect(noneAuthMethodRegistration.provider.getCredential(context({}))).resolves.toEqual({
      ok: true,
      credential: { kind: "none" },
      version: { securityRevision: 7, rotationSeq: null },
    });
    await expect(noneAuthMethodRegistration.provider.inspect(context({}))).resolves.toEqual({
      state: "not_required",
    });
  });

  it("fails closed when directly given malformed config", async () => {
    await expect(
      noneAuthMethodRegistration.provider.getCredential(context({ unexpected: true })),
    ).resolves.toEqual({
      ok: false,
      failure: {
        code: "configuration_invalid",
        message: "Invalid configuration for none authentication",
      },
    });
    await expect(
      noneAuthMethodRegistration.provider.inspect(context({ unexpected: true })),
    ).resolves.toEqual({
      state: "misconfigured",
      message: "Invalid configuration for none authentication",
    });
  });

  it.each([0, 1] as const)(
    "fails closed when recovering with malformed config at attempt %i",
    async (attempt) => {
      const rejectedVersion = { securityRevision: 7, rotationSeq: null };
      const ctx = context({ unexpected: true });
      const decision =
        attempt === 0
          ? noneAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
              rejectedVersion,
              attempt: 0,
            })
          : noneAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
              rejectedVersion,
              attempt: 1,
            });

      await expect(decision).resolves.toEqual({
        action: "give_up",
        failure: {
          code: "configuration_invalid",
          message: "Invalid configuration for none authentication",
        },
      });
    },
  );

  it.each([0, 1] as const)("never retries a rejected credential at attempt %i", async (attempt) => {
    const version = { securityRevision: 7, rotationSeq: null };
    const ctx = context({});
    const decision =
      attempt === 0
        ? noneAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
            rejectedVersion: version,
            attempt: 0,
          })
        : noneAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
            rejectedVersion: version,
            attempt: 1,
          });

    await expect(decision).resolves.toEqual({
      action: "give_up",
      failure: {
        code: "credential_rejected",
        message: "The Agent rejected an unauthenticated request",
      },
    });
  });
});
