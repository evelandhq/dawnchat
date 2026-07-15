import { describe, expect, it } from "vitest";

import type { ProviderContext } from "@/agent-auth/contracts";
import { basicAuthMethodRegistration } from "@/agent-auth/static-methods";

function context(config: unknown, securityRevision = 12): ProviderContext {
  return {
    target: { agentConnectionId: "agent-basic", principalId: "principal-1" },
    config,
    securityRevision,
    credentialScope: "connection",
    scopeSubject: "",
  };
}

const configurationFailure = {
  code: "configuration_invalid",
  message: "Invalid configuration for basic authentication",
};

const rejectionDecision = {
  action: "give_up",
  failure: {
    code: "credential_rejected",
    message: "The Agent rejected the configured Basic credentials",
  },
};

describe("basic auth method", () => {
  it("requires both fields, trims username, and preserves password", async () => {
    const parsed = basicAuthMethodRegistration.configSchema.safeParse({
      username: "  alice  ",
      password: "  p@ss word  ",
    });

    expect(parsed).toMatchObject({
      success: true,
      data: { username: "alice", password: "  p@ss word  " },
    });
    expect(
      basicAuthMethodRegistration.configSchema.safeParse({ username: "   ", password: "secret" })
        .success,
    ).toBe(false);
    expect(
      basicAuthMethodRegistration.configSchema.safeParse({ username: "alice", password: "" })
        .success,
    ).toBe(false);
    expect(
      basicAuthMethodRegistration.configSchema.safeParse({ username: "alice" }).success,
    ).toBe(false);

    await expect(
      basicAuthMethodRegistration.provider.getCredential(
        context({ username: "  alice  ", password: "  p@ss word  " }),
      ),
    ).resolves.toEqual({
      ok: true,
      credential: { kind: "basic", username: "alice", password: "  p@ss word  " },
      version: { securityRevision: 12, rotationSeq: null },
    });
    await expect(
      basicAuthMethodRegistration.provider.inspect(
        context({ username: "alice", password: "secret" }),
      ),
    ).resolves.toEqual({ state: "ok" });
  });

  it("turns malformed or hostile config into a generic configuration failure", async () => {
    const hostile = Object.defineProperty({}, "username", {
      enumerable: true,
      get() {
        throw new Error("sensitive internal detail");
      },
    });

    await expect(
      basicAuthMethodRegistration.provider.getCredential(
        context({ username: " ", password: "secret" }),
      ),
    ).resolves.toEqual({ ok: false, failure: configurationFailure });
    await expect(
      basicAuthMethodRegistration.provider.getCredential(context(hostile)),
    ).resolves.toEqual({ ok: false, failure: configurationFailure });
    await expect(
      basicAuthMethodRegistration.provider.inspect(context({ username: "alice", password: "" })),
    ).resolves.toEqual({
      state: "misconfigured",
      message: configurationFailure.message,
    });
  });

  it.each([0, 1] as const)(
    "fails closed when recovering with malformed config at attempt %i",
    async (attempt) => {
      const rejectedVersion = { securityRevision: 12, rotationSeq: null };
      const ctx = context({ username: "alice" });
      const decision =
        attempt === 0
          ? basicAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
              rejectedVersion,
              attempt: 0,
            })
          : basicAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
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
    const ctx = context({ username: "alice", password: "secret" });
    const rejectedVersion = { securityRevision: 12, rotationSeq: null };

    await expect(
      basicAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
        rejectedVersion,
        attempt: 0,
      }),
    ).resolves.toEqual(rejectionDecision);
    await expect(
      basicAuthMethodRegistration.provider.recoverUnauthorized(ctx, {
        rejectedVersion,
        attempt: 1,
      }),
    ).resolves.toEqual(rejectionDecision);
  });
});
