import { describe, expect, it, vi } from "vitest";
import { z, type ZodType } from "zod";

import { AuthMethodCatalog } from "@/agent-auth/catalog";
import type {
  AgentAuthFailure,
  AgentAuthTarget,
  AgentRequestInit,
  AgentRequestTarget,
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
import {
  AgentTransportConfigurationError,
  AgentTransportUpstreamUnavailableError,
  type AgentTransport,
  type AgentTransportRequest,
} from "@/agent-auth/transport";

type TestConfig = { readonly label: string; readonly secret: string };
type CredentialScript = CredentialResult;
type RecoveryScript = RecoveryDecision | FinalUnauthorizedDecision;

const METHOD = "scripted-method";
const TARGET: AgentAuthTarget = {
  agentConnectionId: "connection-1",
  principalId: "principal / one",
};
const REQUEST: AgentRequestTarget = { pathname: "/eve/v1/info" };
const INIT: AgentRequestInit = { method: "POST", jsonBody: { message: "hello" } };
const V1: CredentialVersion = { securityRevision: 7, rotationSeq: 1 };
const V2: CredentialVersion = { securityRevision: 7, rotationSeq: 2 };
const SAFE_CONFIGURATION_MESSAGE = "The Agent authentication configuration is invalid";

class ScriptedProvider implements CredentialProvider<TestConfig> {
  readonly method = METHOD;
  readonly getCalls: ProviderContext<TestConfig>[] = [];
  readonly inspectCalls: ProviderContext<TestConfig>[] = [];
  readonly recoverCalls: Array<{
    readonly ctx: ProviderContext<TestConfig>;
    readonly evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 0 | 1 };
  }> = [];
  readonly #credentialScripts: CredentialScript[];
  readonly #recoveryScripts: RecoveryScript[];
  readonly #inspectResult: CredentialInspectResult;
  readonly #credentialForContext?: (
    ctx: ProviderContext<TestConfig>,
    callIndex: number,
  ) => CredentialResult;
  readonly #onRecover?: (
    evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 0 | 1 },
  ) => void;

  constructor(options: {
    readonly credentials?: readonly CredentialScript[];
    readonly recoveries?: readonly RecoveryScript[];
    readonly inspect?: CredentialInspectResult;
    readonly credentialForContext?: (
      ctx: ProviderContext<TestConfig>,
      callIndex: number,
    ) => CredentialResult;
    readonly onRecover?: (
      evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 0 | 1 },
    ) => void;
  } = {}) {
    this.#credentialScripts = [...(options.credentials ?? [credential("token-v1", V1)])];
    this.#recoveryScripts = [...(options.recoveries ?? [])];
    this.#inspectResult = options.inspect ?? { state: "ok" };
    this.#credentialForContext = options.credentialForContext;
    this.#onRecover = options.onRecover;
  }

  async getCredential(ctx: ProviderContext<TestConfig>): Promise<CredentialResult> {
    this.getCalls.push(ctx);
    if (this.#credentialForContext !== undefined) {
      return this.#credentialForContext(ctx, this.getCalls.length - 1);
    }
    const result = this.#credentialScripts.shift();
    if (result === undefined) {
      throw new Error("Unexpected getCredential call");
    }
    return result;
  }

  async inspect(ctx: ProviderContext<TestConfig>): Promise<CredentialInspectResult> {
    this.inspectCalls.push(ctx);
    return this.#inspectResult;
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
    ctx: ProviderContext<TestConfig>,
    evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 0 | 1 },
  ): Promise<RecoveryDecision> {
    this.recoverCalls.push({ ctx, evidence });
    this.#onRecover?.(evidence);
    const result = this.#recoveryScripts.shift();
    if (result === undefined) {
      throw new Error("Unexpected recoverUnauthorized call");
    }
    return result;
  }
}

class ScriptedTransport implements AgentTransport {
  readonly calls: AgentTransportRequest[] = [];
  readonly #scripts: Array<Response | unknown>;

  constructor(scripts: readonly (Response | unknown)[] = [new Response("ok", { status: 200 })]) {
    this.#scripts = [...scripts];
  }

  async request(request: AgentTransportRequest): Promise<Response> {
    this.calls.push(request);
    if (this.#scripts.length === 0) {
      throw new Error("Unexpected transport call");
    }
    const result = this.#scripts.shift();
    if (result instanceof Response) {
      return result;
    }
    throw result;
  }
}

function credential(token: string, version: CredentialVersion): CredentialResult {
  return { ok: true, credential: { kind: "bearer", token }, version };
}

function failure(
  code: "credential_rejected" | "configuration_invalid" | "interaction_required" | "provider_unavailable" | "retry_required",
  message: string,
): CredentialResult {
  return { ok: false, failure: { code, message } };
}

function giveUp(
  code: "credential_rejected" | "configuration_invalid" | "interaction_required" | "provider_unavailable" | "retry_required",
  message: string,
): RecoveryDecision {
  return { action: "give_up", failure: { code, message } };
}

function defaultSnapshot(overrides: Partial<AgentAuthSnapshot> = {}): AgentAuthSnapshot {
  return {
    agentConnectionId: TARGET.agentConnectionId,
    baseUrl: "https://agent.example/deployment",
    authMethod: METHOD,
    authConfig: { label: "parsed-label", secret: "super-secret-config-value" },
    securityRevision: 7,
    ...overrides,
  };
}

function entry(options: {
  readonly provider: ScriptedProvider;
  readonly scope?: CredentialScope;
  readonly schema?: ZodType<TestConfig>;
  readonly authorizePath?: string;
}): AuthMethodCatalogEntry {
  const interaction =
    options.authorizePath === undefined ? {} : { interaction: { authorizePath: options.authorizePath } };
  return {
    key: METHOD,
    registration: {
      method: METHOD,
      credentialScope: options.scope ?? "connection",
      configSchema:
        options.schema ?? z.object({ label: z.string(), secret: z.string() }).strict(),
      provider: options.provider,
      ...interaction,
    },
    descriptor: {
      method: METHOD,
      label: "Scripted",
      interactive: options.authorizePath !== undefined,
      fields: [],
    },
  };
}

function harness(options: {
  readonly provider?: ScriptedProvider;
  readonly transport?: ScriptedTransport;
  readonly scope?: CredentialScope;
  readonly schema?: ZodType<TestConfig>;
  readonly authorizePath?: string;
  readonly snapshot?: AgentAuthSnapshot;
  readonly catalog?: AuthMethodCatalog;
  readonly load?: LoadAgentAuthSnapshot;
} = {}) {
  const provider = options.provider ?? new ScriptedProvider();
  const transport = options.transport ?? new ScriptedTransport();
  const snapshot = options.snapshot ?? defaultSnapshot();
  const load: LoadAgentAuthSnapshot = options.load ?? vi.fn(async () => snapshot);
  const catalog =
    options.catalog ??
    new AuthMethodCatalog([
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
  return { catalog, load, module, provider, snapshot, transport };
}

function expectConfigurationFailure(
  result: Response | AgentAuthFailure,
  method = METHOD,
): void {
  expect(result).toEqual({
    code: "configuration_invalid",
    method,
    message: SAFE_CONFIGURATION_MESSAGE,
  });
  expect(JSON.stringify(result)).not.toContain("super-secret-config-value");
  expect(JSON.stringify(result)).not.toContain("schema-secret");
}

function responseWithCancelableBody(
  status: number,
  onCancel: () => void | Promise<void>,
): Response {
  return new Response(
    new ReadableStream({
      cancel() {
        return onCancel();
      },
    }),
    { status },
  );
}

describe("AgentAuthModule.request preparation", () => {
  it.each([
    { scope: "connection" as const, expectedSubject: "" },
    { scope: "principal" as const, expectedSubject: TARGET.principalId },
  ])("returns the raw response with resolved $scope scope", async ({ scope, expectedSubject }) => {
    const response = new Response("raw-success", { status: 201 });
    const provider = new ScriptedProvider({ credentials: [credential("token-v1", V1)] });
    const transport = new ScriptedTransport([response]);
    const { load, module } = harness({ provider, scope, transport });

    const result = await module.request(TARGET, REQUEST, INIT);

    expect(result).toBe(response);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(TARGET);
    expect(provider.getCalls).toEqual([
      {
        target: TARGET,
        config: { label: "parsed-label", secret: "super-secret-config-value" },
        securityRevision: 7,
        credentialScope: scope,
        scopeSubject: expectedSubject,
      },
    ]);
    expect(transport.calls).toEqual([
      {
        baseUrl: "https://agent.example/deployment",
        credential: { kind: "bearer", token: "token-v1" },
        target: REQUEST,
        init: { method: "POST", body: '{"message":"hello"}' },
      },
    ]);
  });

  it("snapshots mutable caller identity, request, init, and interaction before stateful serialization", async () => {
    const target = {
      agentConnectionId: "connection-A",
      principalId: "principal-A",
    };
    const searchParams: Record<string, string> = { cursor: "cursor-A", tenant: "tenant-A" };
    const requestTarget: { pathname: string; searchParams: Record<string, string> } = {
      pathname: "/agents/A/messages",
      searchParams,
    };
    const interaction = { chatId: "chat-A" };
    let init!: AgentRequestInit & { method: "GET" | "POST" };
    const jsonBody = {
      toJSON() {
        target.agentConnectionId = "connection-B";
        target.principalId = "principal-B";
        requestTarget.pathname = "/agents/B/messages";
        searchParams.cursor = "cursor-B";
        searchParams.tenant = "tenant-B";
        requestTarget.searchParams = { injected: "path-B" };
        interaction.chatId = "chat-B";
        init.method = "GET";
        return { message: "serialize-once" };
      },
    };
    init = { method: "POST", jsonBody };
    const load = vi.fn<LoadAgentAuthSnapshot>(async () =>
      defaultSnapshot({ agentConnectionId: "connection-A" }),
    );
    const provider = new ScriptedProvider({
      credentialForContext(ctx, callIndex) {
        return credential(
          `token-for-${ctx.target.agentConnectionId}-${ctx.target.principalId}-${callIndex}`,
          callIndex === 0 ? V1 : V2,
        );
      },
      recoveries: [
        { action: "retry" },
        giveUp("interaction_required", "Sign in to continue"),
      ],
    });
    const transport = new ScriptedTransport([
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    ]);
    const { module } = harness({
      authorizePath: "/auth/oidc/authorize",
      load,
      provider,
      scope: "principal",
      transport,
    });

    await expect(module.request(target, requestTarget, init, interaction)).resolves.toEqual({
      code: "interaction_required",
      method: METHOD,
      message: "Sign in to continue",
      interaction: { type: "redirect", url: "/auth/oidc/authorize?chatId=chat-A" },
    });

    expect(load).toHaveBeenCalledOnce();
    const loadedTarget = load.mock.calls[0]![0];
    expect(loadedTarget).toEqual({
      agentConnectionId: "connection-A",
      principalId: "principal-A",
    });
    expect(loadedTarget).not.toBe(target);
    expect(Object.isFrozen(loadedTarget)).toBe(true);
    expect(provider.getCalls).toHaveLength(2);
    for (const context of provider.getCalls) {
      expect(context.target).toBe(loadedTarget);
      expect(context.target).toEqual({
        agentConnectionId: "connection-A",
        principalId: "principal-A",
      });
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.target)).toBe(true);
    }
    expect(transport.calls.map(({ credential }) => credential)).toEqual([
      { kind: "bearer", token: "token-for-connection-A-principal-A-0" },
      { kind: "bearer", token: "token-for-connection-A-principal-A-1" },
    ]);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]!.target).toBe(transport.calls[1]!.target);
    expect(transport.calls[0]!.target).not.toBe(requestTarget);
    for (const call of transport.calls) {
      expect(call.target).toEqual({
        pathname: "/agents/A/messages",
        searchParams: { cursor: "cursor-A", tenant: "tenant-A" },
      });
      expect(Object.isFrozen(call.target)).toBe(true);
      expect(Object.isFrozen(call.target.searchParams)).toBe(true);
      expect(JSON.stringify(call)).not.toContain("connection-B");
      expect(JSON.stringify(call)).not.toContain("principal-B");
      expect(JSON.stringify(call)).not.toContain("agents/B");
      expect(JSON.stringify(call)).not.toContain("cursor-B");
      expect(JSON.stringify(call)).not.toContain("tenant-B");
      expect(JSON.stringify(call)).not.toContain("path-B");
    }
    expect(transport.calls[0]!.init).toBe(transport.calls[1]!.init);
    expect(transport.calls[0]!.init).toMatchObject({
      method: "POST",
      body: '{"message":"serialize-once"}',
    });
  });

  it("keeps original frozen identity and request snapshots when recovery mutates caller objects", async () => {
    const target = {
      agentConnectionId: "connection-A",
      principalId: "principal-A",
    };
    const searchParams: Record<string, string> = { cursor: "cursor-A" };
    const requestTarget = { pathname: "/agents/A/messages", searchParams };
    const load = vi.fn<LoadAgentAuthSnapshot>(async () =>
      defaultSnapshot({ agentConnectionId: "connection-A" }),
    );
    const provider = new ScriptedProvider({
      credentialForContext(ctx, callIndex) {
        return credential(
          `token-for-${ctx.target.agentConnectionId}-${ctx.target.principalId}-${callIndex}`,
          callIndex === 0 ? V1 : V2,
        );
      },
      recoveries: [{ action: "retry" }],
      onRecover({ attempt }) {
        if (attempt === 0) {
          target.agentConnectionId = "connection-B";
          target.principalId = "principal-B";
          requestTarget.pathname = "/agents/B/messages";
          searchParams.cursor = "cursor-B";
          requestTarget.searchParams = { injected: "path-B" };
        }
      },
    });
    const response = new Response("fresh", { status: 200 });
    const transport = new ScriptedTransport([
      new Response(null, { status: 401 }),
      response,
    ]);
    const { module } = harness({ load, provider, scope: "principal", transport });

    await expect(module.request(target, requestTarget)).resolves.toBe(response);

    const loadedTarget = load.mock.calls[0]![0];
    expect(loadedTarget).toEqual({
      agentConnectionId: "connection-A",
      principalId: "principal-A",
    });
    expect(Object.isFrozen(loadedTarget)).toBe(true);
    expect(provider.getCalls.map(({ target: providerTarget }) => providerTarget)).toEqual([
      loadedTarget,
      loadedTarget,
    ]);
    expect(provider.getCalls.every((context) => Object.isFrozen(context))).toBe(true);
    expect(transport.calls.map(({ credential }) => credential)).toEqual([
      { kind: "bearer", token: "token-for-connection-A-principal-A-0" },
      { kind: "bearer", token: "token-for-connection-A-principal-A-1" },
    ]);
    expect(transport.calls[0]!.target).toBe(transport.calls[1]!.target);
    expect(transport.calls.map(({ target: sentTarget }) => sentTarget)).toEqual([
      { pathname: "/agents/A/messages", searchParams: { cursor: "cursor-A" } },
      { pathname: "/agents/A/messages", searchParams: { cursor: "cursor-A" } },
    ]);
    expect(transport.calls.every(({ target: sentTarget }) => Object.isFrozen(sentTarget))).toBe(
      true,
    );
    expect(
      transport.calls.every(({ target: sentTarget }) =>
        Object.isFrozen(sentTarget.searchParams),
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "target",
      target: null as unknown as AgentAuthTarget,
      requestTarget: REQUEST,
      init: undefined,
      interaction: undefined,
    },
    {
      name: "request target",
      target: TARGET,
      requestTarget: { pathname: "/safe", searchParams: { bad: 1 } } as unknown as AgentRequestTarget,
      init: undefined,
      interaction: undefined,
    },
    {
      name: "request init",
      target: TARGET,
      requestTarget: REQUEST,
      init: { method: "DELETE" } as unknown as AgentRequestInit,
      interaction: undefined,
    },
    {
      name: "interaction context",
      target: TARGET,
      requestTarget: REQUEST,
      init: undefined,
      interaction: { chatId: 42 } as unknown as { chatId: string },
    },
  ])("fails closed before loader, provider, and transport for invalid public $name shape", async ({
    target,
    requestTarget,
    init,
    interaction,
  }) => {
    const { load, module, provider, transport } = harness();

    const result = await module.request(target, requestTarget, init, interaction);

    expectConfigurationFailure(result, "unknown");
    expect(load).not.toHaveBeenCalled();
    expect(provider.getCalls).toHaveLength(0);
    expect(provider.recoverCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("normalizes a typed snapshot-loader configuration failure without exposing diagnostics", async () => {
    const secretCause = new Error("loader-cause-super-secret");
    const loaderError = new AgentAuthSnapshotConfigurationError({
      method: METHOD,
      cause: secretCause,
    });
    const load = vi.fn<LoadAgentAuthSnapshot>(async () => {
      throw loaderError;
    });
    const { module, provider, transport } = harness({ load });

    const result = await module.request(TARGET, REQUEST);

    expectConfigurationFailure(result);
    expect(JSON.stringify(result)).not.toContain("loader-cause-super-secret");
    expect(JSON.stringify(result)).not.toContain(loaderError.message);
    expect(provider.getCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("propagates an unknown snapshot-loader error unchanged", async () => {
    const unknownError = new Error("unknown loader programming failure");
    const load = vi.fn<LoadAgentAuthSnapshot>(async () => {
      throw unknownError;
    });
    const { module, provider, transport } = harness({ load });

    await expect(module.request(TARGET, REQUEST)).rejects.toBe(unknownError);
    expect(provider.getCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    {
      name: "malformed config",
      build: () => harness({ snapshot: defaultSnapshot({ authConfig: { secret: "bad" } }) }),
    },
    {
      name: "schema exception",
      build: () =>
        harness({
          schema: {
            safeParse() {
              throw new Error("schema-secret diagnostic");
            },
          } as unknown as ZodType<TestConfig>,
        }),
    },
    {
      name: "unknown method",
      build: () => harness({ snapshot: defaultSnapshot({ authMethod: "unknown-method" }) }),
      expectedMethod: "unknown-method",
    },
    {
      name: "mismatched snapshot id",
      build: () => harness({ snapshot: defaultSnapshot({ agentConnectionId: "connection-2" }) }),
    },
    {
      name: "zero revision",
      build: () => harness({ snapshot: defaultSnapshot({ securityRevision: 0 }) }),
    },
    {
      name: "non-integer revision",
      build: () => harness({ snapshot: defaultSnapshot({ securityRevision: 1.5 }) }),
    },
    {
      name: "blank principal for principal scope",
      build: () => harness({ scope: "principal" }),
      target: { ...TARGET, principalId: "  " },
    },
  ])(
    "fails closed before provider or transport for $name",
    async ({ build, target, expectedMethod }) => {
      const { module, provider, transport } = build();

      const result = await module.request(target ?? TARGET, REQUEST);

      expectConfigurationFailure(result, expectedMethod);
      expect(provider.getCalls).toHaveLength(0);
      expect(provider.recoverCalls).toHaveLength(0);
      expect(transport.calls).toHaveLength(0);
    },
  );

  it("rejects a GET JSON body before credential-provider or transport side effects", async () => {
    const { module, provider, transport } = harness();

    const result = await module.request(TARGET, REQUEST, {
      method: "GET",
      jsonBody: { disallowed: true },
    });

    expectConfigurationFailure(result);
    expect(provider.getCalls).toHaveLength(0);
    expect(provider.recoverCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("maps JSON serialization failure before credential-provider or transport side effects", async () => {
    const serializationFailure = new Error("must-not-escape-secret-serialization-detail");
    const jsonBody = {
      toJSON() {
        throw serializationFailure;
      },
    };
    const { module, provider, transport } = harness();

    const result = await module.request(TARGET, REQUEST, { method: "POST", jsonBody });

    expectConfigurationFailure(result);
    expect(provider.getCalls).toHaveLength(0);
    expect(provider.recoverCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("stamps provider failures with the catalog method and hides unsafe configuration details", async () => {
    const provider = new ScriptedProvider({
      credentials: [
        failure(
          "configuration_invalid",
          "schema said super-secret-config-value was invalid at authConfig.secret",
        ),
      ],
    });
    const { module, transport } = harness({ provider });

    const result = await module.request(TARGET, REQUEST);

    expectConfigurationFailure(result);
    expect(transport.calls).toHaveLength(0);
  });

  it("stamps a safe non-configuration provider failure with the catalog method", async () => {
    const provider = new ScriptedProvider({
      credentials: [failure("provider_unavailable", "The credential provider is unavailable")],
    });
    const { module } = harness({ provider });

    await expect(module.request(TARGET, REQUEST)).resolves.toEqual({
      code: "provider_unavailable",
      method: METHOD,
      message: "The credential provider is unavailable",
    });
  });
});

describe("AgentAuthModule.request interactions", () => {
  it("builds a same-origin root-relative interaction URL with URL-encoded chatId", async () => {
    const provider = new ScriptedProvider({
      credentials: [failure("interaction_required", "Sign in to continue")],
    });
    const { module } = harness({
      provider,
      authorizePath: "/auth/oidc/authorize",
    });

    await expect(
      module.request(TARGET, REQUEST, undefined, { chatId: "chat /?&=+雪" }),
    ).resolves.toEqual({
      code: "interaction_required",
      method: METHOD,
      message: "Sign in to continue",
      interaction: {
        type: "redirect",
        url: "/auth/oidc/authorize?chatId=chat+%2F%3F%26%3D%2B%E9%9B%AA",
      },
    });
  });

  it.each([
    { name: "no context", context: undefined },
    { name: "blank chat id", context: { chatId: "  " } },
  ])("returns interaction_required without a URL for $name", async ({ context }) => {
    const provider = new ScriptedProvider({
      credentials: [failure("interaction_required", "Sign in to continue")],
    });
    const { module } = harness({ provider, authorizePath: "/auth/oidc/authorize" });

    await expect(module.request(TARGET, REQUEST, undefined, context)).resolves.toEqual({
      code: "interaction_required",
      method: METHOD,
      message: "Sign in to continue",
    });
  });

  it("fails closed when a provider requests interaction without a registration descriptor", async () => {
    const provider = new ScriptedProvider({
      credentials: [failure("interaction_required", "Sign in with leaked-secret")],
    });
    const { module } = harness({ provider });

    const result = await module.request(TARGET, REQUEST, undefined, { chatId: "chat-1" });

    expectConfigurationFailure(result);
  });
});

describe("AgentAuthModule.request response orchestration", () => {
  it("returns a normalized give_up failure after the first 401", async () => {
    const provider = new ScriptedProvider({
      credentials: [credential("token-v1", V1)],
      recoveries: [giveUp("credential_rejected", "The Agent rejected the credential")],
    });
    const transport = new ScriptedTransport([new Response(null, { status: 401 })]);
    const { module } = harness({ provider, transport });

    await expect(module.request(TARGET, REQUEST)).resolves.toEqual({
      code: "credential_rejected",
      method: METHOD,
      message: "The Agent rejected the credential",
    });
    expect(provider.recoverCalls.map(({ evidence }) => evidence)).toEqual([
      { rejectedVersion: V1, attempt: 0 },
    ]);
    expect(provider.getCalls).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
  });

  it("retries exactly once with a freshly acquired credential and version", async () => {
    const response = new Response("fresh", { status: 200 });
    const provider = new ScriptedProvider({
      credentials: [credential("token-v1", V1), credential("token-v2", V2)],
      recoveries: [{ action: "retry" }],
    });
    const transport = new ScriptedTransport([
      new Response(null, { status: 401 }),
      response,
    ]);
    const { module } = harness({ provider, transport });

    const result = await module.request(TARGET, REQUEST, INIT);

    expect(result).toBe(response);
    expect(provider.getCalls).toHaveLength(2);
    expect(provider.recoverCalls.map(({ evidence }) => evidence)).toEqual([
      { rejectedVersion: V1, attempt: 0 },
    ]);
    expect(transport.calls.map(({ credential }) => credential)).toEqual([
      { kind: "bearer", token: "token-v1" },
      { kind: "bearer", token: "token-v2" },
    ]);
    expect(transport.calls.map(({ target, init }) => ({ target, init }))).toEqual([
      { target: REQUEST, init: { method: "POST", body: '{"message":"hello"}' } },
      { target: REQUEST, init: { method: "POST", body: '{"message":"hello"}' } },
    ]);
  });

  it("serializes a stateful JSON body once and reuses the identical prepared body on retry", async () => {
    let serializationCount = 0;
    const jsonBody = {
      toJSON() {
        serializationCount += 1;
        return { message: `serialization-${serializationCount}` };
      },
    };
    const response = new Response("fresh", { status: 200 });
    const provider = new ScriptedProvider({
      credentials: [credential("token-v1", V1), credential("token-v2", V2)],
      recoveries: [{ action: "retry" }],
    });
    const transport = new ScriptedTransport([
      new Response(null, { status: 401 }),
      response,
    ]);
    const { module } = harness({ provider, transport });

    const result = await module.request(TARGET, REQUEST, { method: "POST", jsonBody });

    expect(result).toBe(response);
    expect(serializationCount).toBe(1);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]!.init).toBe(transport.calls[1]!.init);
    expect(transport.calls.map(({ init }) => init)).toEqual([
      { method: "POST", body: '{"message":"serialization-1"}' },
      { method: "POST", body: '{"message":"serialization-1"}' },
    ]);
    expect(Object.isFrozen(transport.calls[0]!.init)).toBe(true);
  });

  it("awaits and cancels a discarded first 401 body before recovery, ignoring cleanup failure", async () => {
    const cancelFailure = new Error("discard cleanup failed");
    const firstCancel = vi.fn(async () => {
      throw cancelFailure;
    });
    const response = new Response("fresh", { status: 200 });
    const provider = new ScriptedProvider({
      credentials: [credential("token-v1", V1), credential("token-v2", V2)],
      recoveries: [{ action: "retry" }],
      onRecover(evidence) {
        if (evidence.attempt === 0) {
          expect(firstCancel).toHaveBeenCalledOnce();
        }
      },
    });
    const transport = new ScriptedTransport([
      responseWithCancelableBody(401, firstCancel),
      response,
    ]);
    const { module } = harness({ provider, transport });

    await expect(module.request(TARGET, REQUEST)).resolves.toBe(response);
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(transport.calls).toHaveLength(2);
  });

  it("passes V2 to attempt 1 after a second 401 and never sends a third request", async () => {
    const provider = new ScriptedProvider({
      credentials: [credential("token-v1", V1), credential("token-v2", V2)],
      recoveries: [
        { action: "retry" },
        giveUp("retry_required", "Retry the complete request"),
      ],
    });
    const transport = new ScriptedTransport([
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    ]);
    const { module } = harness({ provider, transport });

    await expect(module.request(TARGET, REQUEST)).resolves.toEqual({
      code: "retry_required",
      method: METHOD,
      message: "Retry the complete request",
    });
    expect(provider.recoverCalls.map(({ evidence }) => evidence)).toEqual([
      { rejectedVersion: V1, attempt: 0 },
      { rejectedVersion: V2, attempt: 1 },
    ]);
    expect(provider.getCalls).toHaveLength(2);
    expect(transport.calls).toHaveLength(2);
  });

  it("cancels a terminal second 401 body before final recovery and never sends a third request", async () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const provider = new ScriptedProvider({
      credentials: [credential("token-v1", V1), credential("token-v2", V2)],
      recoveries: [
        { action: "retry" },
        giveUp("retry_required", "Retry the complete request"),
      ],
      onRecover(evidence) {
        if (evidence.attempt === 1) {
          expect(secondCancel).toHaveBeenCalledOnce();
        }
      },
    });
    const transport = new ScriptedTransport([
      responseWithCancelableBody(401, firstCancel),
      responseWithCancelableBody(401, secondCancel),
    ]);
    const { module } = harness({ provider, transport });

    await expect(module.request(TARGET, REQUEST)).resolves.toEqual({
      code: "retry_required",
      method: METHOD,
      message: "Retry the complete request",
    });
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(transport.calls).toHaveLength(2);
  });

  it("returns a stamped getCredential failure after retry recovery without a second send", async () => {
    const provider = new ScriptedProvider({
      credentials: [
        credential("token-v1", V1),
        failure("provider_unavailable", "The credential provider is unavailable"),
      ],
      recoveries: [{ action: "retry" }],
    });
    const transport = new ScriptedTransport([new Response(null, { status: 401 })]);
    const { module } = harness({ provider, transport });

    await expect(module.request(TARGET, REQUEST)).resolves.toEqual({
      code: "provider_unavailable",
      method: METHOD,
      message: "The credential provider is unavailable",
    });
    expect(provider.getCalls).toHaveLength(2);
    expect(provider.recoverCalls).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
  });

  it("maps a first-response 403 to forbidden without recovery or retry", async () => {
    const cancel = vi.fn();
    const provider = new ScriptedProvider({ credentials: [credential("token-v1", V1)] });
    const transport = new ScriptedTransport([responseWithCancelableBody(403, cancel)]);
    const { module } = harness({ provider, transport });

    await expect(module.request(TARGET, REQUEST)).resolves.toEqual({
      code: "forbidden",
      method: METHOD,
      message: "The Agent denied access to this resource",
    });
    expect(provider.getCalls).toHaveLength(1);
    expect(provider.recoverCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("maps a retry-response 403 to forbidden without a second recovery or third request", async () => {
    const provider = new ScriptedProvider({
      credentials: [credential("token-v1", V1), credential("token-v2", V2)],
      recoveries: [{ action: "retry" }],
    });
    const transport = new ScriptedTransport([
      new Response(null, { status: 401 }),
      new Response(null, { status: 403 }),
    ]);
    const { module } = harness({ provider, transport });

    await expect(module.request(TARGET, REQUEST)).resolves.toEqual({
      code: "forbidden",
      method: METHOD,
      message: "The Agent denied access to this resource",
    });
    expect(provider.recoverCalls.map(({ evidence }) => evidence)).toEqual([
      { rejectedVersion: V1, attempt: 0 },
    ]);
    expect(transport.calls).toHaveLength(2);
  });

  it.each([201, 302, 404, 500])("returns without canceling a raw response with status %i", async (status) => {
    const cancel = vi.fn();
    const response = responseWithCancelableBody(status, cancel);
    const transport = new ScriptedTransport([response]);
    const { module, provider } = harness({ transport });

    const result = await module.request(TARGET, REQUEST);

    expect(result).toBe(response);
    expect(provider.recoverCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(1);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("AgentAuthModule.request transport error contracts", () => {
  it("maps transport configuration errors to a generic safe failure", async () => {
    const transport = new ScriptedTransport([
      new AgentTransportConfigurationError("unsafe URL contains super-secret-config-value"),
    ]);
    const { module } = harness({ transport });

    const result = await module.request(TARGET, REQUEST);

    expectConfigurationFailure(result);
  });

  it("maps transport availability errors to a stable safe failure", async () => {
    const transport = new ScriptedTransport([
      new AgentTransportUpstreamUnavailableError(
        "connect ECONNREFUSED secret-host.internal",
        new Error("socket diagnostic"),
      ),
    ]);
    const { module } = harness({ transport });

    await expect(module.request(TARGET, REQUEST)).resolves.toEqual({
      code: "upstream_unavailable",
      method: METHOD,
      message: "The Agent is unavailable",
    });
  });

  it("propagates the exact AbortError object", async () => {
    const abortError = new DOMException("cancelled", "AbortError");
    const transport = new ScriptedTransport([abortError]);
    const { module } = harness({ transport });

    await expect(module.request(TARGET, REQUEST)).rejects.toBe(abortError);
  });

  it("propagates an unknown error unchanged", async () => {
    const unknownError = new Error("unexpected programming failure");
    const transport = new ScriptedTransport([unknownError]);
    const { module } = harness({ transport });

    await expect(module.request(TARGET, REQUEST)).rejects.toBe(unknownError);
  });
});
