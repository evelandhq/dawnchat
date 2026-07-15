import { describe, expect, it, vi } from "vitest";
import { z, type ZodType } from "zod";

import { AuthMethodCatalog } from "@/agent-auth/catalog";
import type {
  AgentAuthModule,
  AgentAuthStatus,
  AgentAuthTarget,
  AuthMethodCatalogEntry,
  CredentialInspectResult,
  CredentialProvider,
  CredentialResult,
  CredentialScope,
  CredentialVersion,
  FinalUnauthorizedDecision,
  ProviderContext,
  RecoveryDecision,
} from "@/agent-auth/contracts";
import {
  AgentAuthSnapshotConfigurationError,
  createAgentAuthModule,
  type AgentAuthSnapshot,
  type LoadAgentAuthSnapshot,
} from "@/agent-auth/module";
import type { AgentTransport, AgentTransportRequest } from "@/agent-auth/transport";

type TestConfig = { readonly tenant: string };

const METHOD = "inspectable-method";
const TARGET: AgentAuthTarget = {
  agentConnectionId: "connection-status",
  principalId: "principal-status",
};
const SAFE_CONFIGURATION_MESSAGE = "The Agent authentication configuration is invalid";

class InspectableProvider implements CredentialProvider<TestConfig> {
  readonly method = METHOD;
  readonly inspectCalls: ProviderContext<TestConfig>[] = [];
  getCount = 0;
  recoverCount = 0;
  readonly #result: CredentialInspectResult;

  constructor(result: CredentialInspectResult) {
    this.#result = result;
  }

  async getCredential(_ctx: ProviderContext<TestConfig>): Promise<CredentialResult> {
    this.getCount += 1;
    throw new Error("status must not call getCredential");
  }

  async inspect(ctx: ProviderContext<TestConfig>): Promise<CredentialInspectResult> {
    this.inspectCalls.push(ctx);
    return this.#result;
  }

  async recoverUnauthorized(
    ctx: ProviderContext<TestConfig>,
    evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 0 },
  ): Promise<RecoveryDecision>;
  async recoverUnauthorized(
    ctx: ProviderContext<TestConfig>,
    evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 1 },
  ): Promise<FinalUnauthorizedDecision>;
  async recoverUnauthorized(
    _ctx: ProviderContext<TestConfig>,
    _evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 0 | 1 },
  ): Promise<RecoveryDecision> {
    this.recoverCount += 1;
    throw new Error("status must not call recoverUnauthorized");
  }
}

class ForbiddenTransport implements AgentTransport {
  requestCount = 0;

  async request(_request: AgentTransportRequest): Promise<Response> {
    this.requestCount += 1;
    throw new Error("status must not call transport");
  }
}

function snapshot(overrides: Partial<AgentAuthSnapshot> = {}): AgentAuthSnapshot {
  return {
    agentConnectionId: TARGET.agentConnectionId,
    baseUrl: "https://must-not-be-resolved.example",
    authMethod: METHOD,
    authConfig: { tenant: "tenant-one" },
    securityRevision: 3,
    ...overrides,
  };
}

function entry(options: {
  readonly provider: InspectableProvider;
  readonly scope?: CredentialScope;
  readonly schema?: ZodType<TestConfig>;
  readonly authorizePath?: string;
}): AuthMethodCatalogEntry {
  return {
    key: METHOD,
    registration: {
      method: METHOD,
      credentialScope: options.scope ?? "connection",
      configSchema: options.schema ?? z.object({ tenant: z.string() }).strict(),
      provider: options.provider,
      ...(options.authorizePath === undefined
        ? {}
        : { interaction: { authorizePath: options.authorizePath } }),
    },
    descriptor: {
      method: METHOD,
      label: "Inspectable",
      interactive: options.authorizePath !== undefined,
      fields: [],
    },
  };
}

function harness(options: {
  readonly inspect?: CredentialInspectResult;
  readonly scope?: CredentialScope;
  readonly schema?: ZodType<TestConfig>;
  readonly authorizePath?: string;
  readonly loaded?: AgentAuthSnapshot;
  readonly load?: LoadAgentAuthSnapshot;
} = {}) {
  const provider = new InspectableProvider(options.inspect ?? { state: "ok" });
  const transport = new ForbiddenTransport();
  const loaded = options.loaded ?? snapshot();
  const load: LoadAgentAuthSnapshot = options.load ?? vi.fn(async () => loaded);
  const catalog = new AuthMethodCatalog([
    entry({
      provider,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.schema === undefined ? {} : { schema: options.schema }),
      ...(options.authorizePath === undefined
        ? {}
        : { authorizePath: options.authorizePath }),
    }),
  ]);
  const module = createAgentAuthModule({ catalog, transport, load });
  return { load, module, provider, transport };
}

function assertReadOnlySideEffects(
  provider: InspectableProvider,
  transport: ForbiddenTransport,
): void {
  expect(provider.getCount).toBe(0);
  expect(provider.recoverCount).toBe(0);
  expect(transport.requestCount).toBe(0);
}

describe("AgentAuthModule.status", () => {
  it.each<{
    readonly inspect: CredentialInspectResult;
    readonly expected: AgentAuthStatus;
  }>([
    { inspect: { state: "not_required" }, expected: { state: "not_required" } },
    { inspect: { state: "ok" }, expected: { state: "credential_available" } },
    { inspect: { state: "recoverable" }, expected: { state: "credential_available" } },
  ])("maps inspect state $inspect.state without request side effects", async ({ inspect, expected }) => {
    const { load, module, provider, transport } = harness({ inspect });

    await expect(module.status(TARGET)).resolves.toEqual(expected);

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(TARGET);
    expect(provider.inspectCalls).toEqual([
      {
        target: TARGET,
        config: { tenant: "tenant-one" },
        securityRevision: 3,
        credentialScope: "connection",
        scopeSubject: "",
      },
    ]);
    assertReadOnlySideEffects(provider, transport);
  });

  it("snapshots target and interaction before awaiting the loader", async () => {
    const target = {
      agentConnectionId: "connection-status",
      principalId: "principal-status",
    };
    const interaction = { chatId: "chat-original" };
    let resolveLoad!: (value: AgentAuthSnapshot) => void;
    const load = vi.fn<LoadAgentAuthSnapshot>(
      () =>
        new Promise<AgentAuthSnapshot>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const { module, provider, transport } = harness({
      authorizePath: "/auth/custom/authorize",
      inspect: { state: "interaction_required" },
      load,
    });

    const pending = module.status(target, interaction);
    target.agentConnectionId = "other-connection";
    target.principalId = "other-principal";
    interaction.chatId = "chat-mutated";
    resolveLoad(snapshot());

    await expect(pending).resolves.toEqual({
      state: "interaction_required",
      interaction: {
        type: "redirect",
        url: "/auth/custom/authorize?chatId=chat-original",
      },
    });
    const loadedTarget = load.mock.calls[0]![0];
    expect(loadedTarget).toEqual(TARGET);
    expect(loadedTarget).not.toBe(target);
    expect(Object.isFrozen(loadedTarget)).toBe(true);
    expect(provider.inspectCalls).toHaveLength(1);
    expect(provider.inspectCalls[0]!.target).toBe(loadedTarget);
    expect(Object.isFrozen(provider.inspectCalls[0])).toBe(true);
    expect(Object.isFrozen(provider.inspectCalls[0]!.target)).toBe(true);
    assertReadOnlySideEffects(provider, transport);
  });

  it.each([
    {
      name: "target",
      target: { agentConnectionId: 7, principalId: "principal" } as unknown as AgentAuthTarget,
      interaction: undefined,
    },
    {
      name: "interaction context",
      target: TARGET,
      interaction: { chatId: null } as unknown as { chatId: string },
    },
  ])("fails closed before loader and inspect for invalid public $name shape", async ({
    target,
    interaction,
  }) => {
    const { load, module, provider, transport } = harness();

    await expect(module.status(target, interaction)).resolves.toEqual({
      state: "misconfigured",
      message: SAFE_CONFIGURATION_MESSAGE,
    });
    expect(load).not.toHaveBeenCalled();
    expect(provider.inspectCalls).toHaveLength(0);
    assertReadOnlySideEffects(provider, transport);
  });

  it("normalizes a typed snapshot-loader configuration failure without exposing diagnostics", async () => {
    const loaderError = new AgentAuthSnapshotConfigurationError({
      method: METHOD,
      cause: new Error("loader-status-super-secret"),
    });
    const load = vi.fn<LoadAgentAuthSnapshot>(async () => {
      throw loaderError;
    });
    const { module, provider, transport } = harness({ load });

    const result = await module.status(TARGET);

    expect(result).toEqual({
      state: "misconfigured",
      message: SAFE_CONFIGURATION_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain("loader-status-super-secret");
    expect(JSON.stringify(result)).not.toContain(loaderError.message);
    expect(provider.inspectCalls).toHaveLength(0);
    assertReadOnlySideEffects(provider, transport);
  });

  it("propagates an unknown snapshot-loader error unchanged", async () => {
    const unknownError = new Error("unknown status loader programming failure");
    const load = vi.fn<LoadAgentAuthSnapshot>(async () => {
      throw unknownError;
    });
    const { module, provider, transport } = harness({ load });

    await expect(module.status(TARGET)).rejects.toBe(unknownError);
    expect(provider.inspectCalls).toHaveLength(0);
    assertReadOnlySideEffects(provider, transport);
  });

  it("resolves principal scope for inspect without acquiring a credential", async () => {
    const { module, provider, transport } = harness({ scope: "principal" });

    await expect(module.status(TARGET)).resolves.toEqual({ state: "credential_available" });

    expect(provider.inspectCalls[0]).toMatchObject({
      credentialScope: "principal",
      scopeSubject: TARGET.principalId,
    });
    assertReadOnlySideEffects(provider, transport);
  });

  it("maps interaction_required with an encoded same-origin interaction URL", async () => {
    const { module, provider, transport } = harness({
      inspect: { state: "interaction_required" },
      authorizePath: "/auth/custom/authorize",
    });

    await expect(module.status(TARGET, { chatId: "chat /?&=+雪" })).resolves.toEqual({
      state: "interaction_required",
      interaction: {
        type: "redirect",
        url: "/auth/custom/authorize?chatId=chat+%2F%3F%26%3D%2B%E9%9B%AA",
      },
    });
    assertReadOnlySideEffects(provider, transport);
  });

  it.each([
    { name: "missing interaction context", context: undefined },
    { name: "blank chat id", context: { chatId: "  " } },
  ])("maps interaction_required without a URL for $name", async ({ context }) => {
    const { module, provider, transport } = harness({
      inspect: { state: "interaction_required" },
      authorizePath: "/auth/custom/authorize",
    });

    await expect(module.status(TARGET, context)).resolves.toEqual({
      state: "interaction_required",
    });
    assertReadOnlySideEffects(provider, transport);
  });

  it("fails closed when inspect requests interaction without a registration descriptor", async () => {
    const { module, provider, transport } = harness({
      inspect: { state: "interaction_required" },
    });

    await expect(module.status(TARGET, { chatId: "chat-1" })).resolves.toEqual({
      state: "misconfigured",
      message: SAFE_CONFIGURATION_MESSAGE,
    });
    assertReadOnlySideEffects(provider, transport);
  });

  it("normalizes provider misconfiguration without exposing provider or config details", async () => {
    const { module, provider, transport } = harness({
      inspect: {
        state: "misconfigured",
        message: "tenant-one and secret-provider-diagnostic are invalid",
      },
    });

    const result = await module.status(TARGET);

    expect(result).toEqual({
      state: "misconfigured",
      message: SAFE_CONFIGURATION_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain("tenant-one");
    expect(JSON.stringify(result)).not.toContain("secret-provider-diagnostic");
    assertReadOnlySideEffects(provider, transport);
  });

  it.each([
    {
      name: "malformed config",
      options: { loaded: snapshot({ authConfig: { bad: "tenant-one" } }) },
      target: TARGET,
    },
    {
      name: "throwing schema",
      options: {
        schema: {
          safeParse() {
            throw new Error("schema-secret-diagnostic");
          },
        } as unknown as ZodType<TestConfig>,
      },
      target: TARGET,
    },
    {
      name: "snapshot id mismatch",
      options: { loaded: snapshot({ agentConnectionId: "other-connection" }) },
      target: TARGET,
    },
    {
      name: "invalid revision",
      options: { loaded: snapshot({ securityRevision: -1 }) },
      target: TARGET,
    },
    {
      name: "blank principal",
      options: { scope: "principal" as const },
      target: { ...TARGET, principalId: "\t" },
    },
  ])("returns safe misconfigured before inspect for $name", async ({ options, target }) => {
    const { module, provider, transport } = harness(options);

    const result = await module.status(target);

    expect(result).toEqual({
      state: "misconfigured",
      message: SAFE_CONFIGURATION_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain("tenant-one");
    expect(JSON.stringify(result)).not.toContain("schema-secret-diagnostic");
    expect(provider.inspectCalls).toHaveLength(0);
    assertReadOnlySideEffects(provider, transport);
  });
});

// Compile-time coverage for the complete public value contract and only two public operations.
const publicModule: AgentAuthModule = harness().module;
const publicStatus: AgentAuthStatus = {
  state: "interaction_required",
  interaction: { type: "redirect", url: "/auth/example?chatId=one" },
};
void publicModule;
void publicStatus;
