import { UnknownAuthMethodError, type AuthMethodCatalog } from "@/agent-auth/catalog";
import type {
  AgentAuthFailure,
  AgentAuthModule,
  AgentAuthStatus,
  AgentAuthTarget,
  AgentRequestInit,
  AgentRequestTarget,
  AuthInteraction,
  AuthMethodRegistration,
  CredentialSnapshot,
  InteractionContext,
  ProviderContext,
  ProviderFailure,
} from "@/agent-auth/contracts";
import {
  AgentTransportConfigurationError,
  AgentTransportUpstreamUnavailableError,
  prepareAgentTransportInit,
  type AgentTransport,
  type AgentTransportInit,
} from "@/agent-auth/transport";

const SAFE_CONFIGURATION_MESSAGE = "The Agent authentication configuration is invalid";
const SAFE_SNAPSHOT_CONFIGURATION_MESSAGE =
  "The Agent authentication snapshot configuration is invalid";
const SAFE_UPSTREAM_MESSAGE = "The Agent is unavailable";
const FORBIDDEN_MESSAGE = "The Agent denied access to this resource";
const INTERACTION_ORIGIN = "https://agent-auth-interaction.invalid";

/**
 * The loader must read the connection identity, decrypted auth configuration, and
 * current security revision from one consistent database snapshot. Repository and
 * decryption wiring deliberately remain outside this module.
 */
export interface AgentAuthSnapshot {
  readonly agentConnectionId: string;
  readonly baseUrl: string;
  readonly authMethod: string;
  readonly authConfig: unknown;
  readonly securityRevision: number;
}

export interface AgentAuthSnapshotConfigurationErrorOptions {
  /** A non-sensitive auth method identifier that is safe to return to callers. */
  readonly method?: string;
  /** Internal diagnostics retained for server-side error handling only. */
  readonly cause?: unknown;
}

/**
 * Expected server-side snapshot loading/configuration failure. Its message is
 * deliberately fixed; sensitive loader diagnostics belong in `cause` only.
 */
export class AgentAuthSnapshotConfigurationError extends Error {
  readonly kind = "configuration_invalid" as const;
  readonly method?: string;

  constructor(options: AgentAuthSnapshotConfigurationErrorOptions = {}) {
    super(
      SAFE_SNAPSHOT_CONFIGURATION_MESSAGE,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AgentAuthSnapshotConfigurationError";
    if (typeof options.method === "string" && options.method.length > 0) {
      this.method = options.method;
    }
  }
}

export type LoadAgentAuthSnapshot = (
  target: AgentAuthTarget,
) => Promise<AgentAuthSnapshot>;

export interface CreateAgentAuthModuleOptions {
  readonly catalog: AuthMethodCatalog;
  readonly transport: AgentTransport;
  readonly load: LoadAgentAuthSnapshot;
}

interface PreparedAuth {
  readonly baseUrl: string;
  readonly method: string;
  readonly registration: AuthMethodRegistration;
  readonly context: ProviderContext;
}

type PreparationResult =
  | { readonly ok: true; readonly prepared: PreparedAuth }
  | { readonly ok: false; readonly method: string };

type TransportResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly failure: AgentAuthFailure };

type InteractionResult =
  | { readonly ok: true; readonly interaction?: AuthInteraction }
  | { readonly ok: false };

class DefaultAgentAuthModule implements AgentAuthModule {
  readonly #catalog: AuthMethodCatalog;
  readonly #transport: AgentTransport;
  readonly #load: LoadAgentAuthSnapshot;

  constructor(options: CreateAgentAuthModuleOptions) {
    this.#catalog = options.catalog;
    this.#transport = options.transport;
    this.#load = options.load;
  }

  async request(
    target: AgentAuthTarget,
    req: AgentRequestTarget,
    init?: AgentRequestInit,
    interaction?: InteractionContext,
  ): Promise<Response | AgentAuthFailure> {
    let targetSnapshot: AgentAuthTarget;
    let requestSnapshot: AgentRequestTarget;
    let initSnapshot: AgentRequestInit | undefined;
    let interactionSnapshot: InteractionContext | undefined;
    try {
      targetSnapshot = snapshotAgentAuthTarget(target);
      requestSnapshot = snapshotAgentRequestTarget(req);
      interactionSnapshot = snapshotInteractionContext(interaction);
      initSnapshot = snapshotAgentRequestInit(init);
    } catch {
      return configurationFailure("unknown");
    }

    const preparation = await this.#prepare(targetSnapshot);
    if (!preparation.ok) {
      return configurationFailure(preparation.method);
    }
    const prepared = preparation.prepared;

    let transportInit: AgentTransportInit;
    try {
      transportInit = prepareAgentTransportInit(initSnapshot);
    } catch (error) {
      if (error instanceof AgentTransportConfigurationError) {
        return configurationFailure(prepared.method);
      }
      throw error;
    }

    const firstCredential = await prepared.registration.provider.getCredential(prepared.context);
    if (!firstCredential.ok) {
      return normalizeProviderFailure(prepared, firstCredential.failure, interactionSnapshot);
    }

    const firstSend = await this.#send(
      prepared,
      firstCredential.credential,
      requestSnapshot,
      transportInit,
    );
    if (!firstSend.ok) {
      return firstSend.failure;
    }
    if (firstSend.response.status === 403) {
      await discardResponse(firstSend.response);
      return forbiddenFailure(prepared.method);
    }
    if (firstSend.response.status !== 401) {
      return firstSend.response;
    }
    await discardResponse(firstSend.response);

    const firstRecovery = await prepared.registration.provider.recoverUnauthorized(
      prepared.context,
      { rejectedVersion: firstCredential.version, attempt: 0 },
    );
    if (firstRecovery.action === "give_up") {
      return normalizeProviderFailure(prepared, firstRecovery.failure, interactionSnapshot);
    }
    if (firstRecovery.action !== "retry") {
      return configurationFailure(prepared.method);
    }

    // Recovery can refresh locally or observe a concurrent refresh. Always resolve
    // the credential again so the replay cannot reuse V1.
    const secondCredential = await prepared.registration.provider.getCredential(prepared.context);
    if (!secondCredential.ok) {
      return normalizeProviderFailure(prepared, secondCredential.failure, interactionSnapshot);
    }

    const secondSend = await this.#send(
      prepared,
      secondCredential.credential,
      requestSnapshot,
      transportInit,
    );
    if (!secondSend.ok) {
      return secondSend.failure;
    }
    if (secondSend.response.status === 403) {
      await discardResponse(secondSend.response);
      return forbiddenFailure(prepared.method);
    }
    if (secondSend.response.status !== 401) {
      return secondSend.response;
    }
    await discardResponse(secondSend.response);

    const finalRecovery = await prepared.registration.provider.recoverUnauthorized(
      prepared.context,
      { rejectedVersion: secondCredential.version, attempt: 1 },
    );
    if (finalRecovery.action !== "give_up") {
      return configurationFailure(prepared.method);
    }

    // attempt: 1 is terminal by contract. There is deliberately no third send.
    return normalizeProviderFailure(prepared, finalRecovery.failure, interactionSnapshot);
  }

  async status(
    target: AgentAuthTarget,
    interaction?: InteractionContext,
  ): Promise<AgentAuthStatus> {
    let targetSnapshot: AgentAuthTarget;
    let interactionSnapshot: InteractionContext | undefined;
    try {
      targetSnapshot = snapshotAgentAuthTarget(target);
      interactionSnapshot = snapshotInteractionContext(interaction);
    } catch {
      return misconfiguredStatus();
    }

    const preparation = await this.#prepare(targetSnapshot);
    if (!preparation.ok) {
      return misconfiguredStatus();
    }
    const prepared = preparation.prepared;

    // inspect() is the only provider operation allowed in this read-only path.
    const inspected = await prepared.registration.provider.inspect(prepared.context);
    switch (inspected.state) {
      case "not_required":
        return { state: "not_required" };
      case "ok":
      case "recoverable":
        return { state: "credential_available" };
      case "misconfigured":
        return misconfiguredStatus();
      case "interaction_required": {
        const resolved = resolveInteraction(prepared.registration, interactionSnapshot);
        if (!resolved.ok) {
          return misconfiguredStatus();
        }
        return resolved.interaction === undefined
          ? { state: "interaction_required" }
          : { state: "interaction_required", interaction: resolved.interaction };
      }
      default:
        return misconfiguredStatus();
    }
  }

  async #prepare(target: AgentAuthTarget): Promise<PreparationResult> {
    let snapshot: AgentAuthSnapshot;
    try {
      snapshot = await this.#load(target);
    } catch (error) {
      if (error instanceof AgentAuthSnapshotConfigurationError) {
        return { ok: false, method: error.method ?? "unknown" };
      }
      throw error;
    }
    const method = methodForFailure(snapshot);

    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      snapshot.agentConnectionId !== target.agentConnectionId ||
      !Number.isInteger(snapshot.securityRevision) ||
      snapshot.securityRevision <= 0
    ) {
      return { ok: false, method };
    }

    let registration: AuthMethodRegistration;
    try {
      registration = this.#catalog.getRegistration(snapshot.authMethod);
    } catch (error) {
      if (error instanceof UnknownAuthMethodError) {
        return { ok: false, method };
      }
      throw error;
    }

    let parsedConfig: unknown;
    try {
      const parsed = registration.configSchema.safeParse(snapshot.authConfig);
      if (!parsed.success) {
        return { ok: false, method };
      }
      parsedConfig = parsed.data;
    } catch {
      return { ok: false, method };
    }

    let scopeSubject: string;
    if (registration.credentialScope === "connection") {
      scopeSubject = "";
    } else if (registration.credentialScope === "principal") {
      if (typeof target.principalId !== "string" || target.principalId.trim().length === 0) {
        return { ok: false, method };
      }
      scopeSubject = target.principalId;
    } else {
      return { ok: false, method };
    }

    return {
      ok: true,
      prepared: {
        baseUrl: snapshot.baseUrl,
        method: registration.method,
        registration,
        context: Object.freeze({
          target,
          config: parsedConfig,
          securityRevision: snapshot.securityRevision,
          credentialScope: registration.credentialScope,
          scopeSubject,
        }),
      },
    };
  }

  async #send(
    prepared: PreparedAuth,
    credential: CredentialSnapshot,
    target: AgentRequestTarget,
    init: AgentTransportInit,
  ): Promise<TransportResult> {
    try {
      const response = await this.#transport.request({
        baseUrl: prepared.baseUrl,
        credential,
        target,
        init,
      });
      return { ok: true, response };
    } catch (error) {
      if (error instanceof AgentTransportConfigurationError) {
        return { ok: false, failure: configurationFailure(prepared.method) };
      }
      if (error instanceof AgentTransportUpstreamUnavailableError) {
        return {
          ok: false,
          failure: {
            code: "upstream_unavailable",
            method: prepared.method,
            message: SAFE_UPSTREAM_MESSAGE,
          },
        };
      }
      throw error;
    }
  }
}

function snapshotAgentAuthTarget(value: AgentAuthTarget): AgentAuthTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid AgentAuthTarget");
  }
  const candidate = value as unknown as {
    readonly agentConnectionId?: unknown;
    readonly principalId?: unknown;
  };
  const agentConnectionId = candidate.agentConnectionId;
  const principalId = candidate.principalId;
  if (typeof agentConnectionId !== "string" || typeof principalId !== "string") {
    throw new TypeError("Invalid AgentAuthTarget");
  }
  return Object.freeze({ agentConnectionId, principalId });
}

function snapshotAgentRequestTarget(value: AgentRequestTarget): AgentRequestTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid AgentRequestTarget");
  }
  const candidate = value as unknown as {
    readonly pathname?: unknown;
    readonly searchParams?: unknown;
  };
  const pathname = candidate.pathname;
  if (typeof pathname !== "string") {
    throw new TypeError("Invalid AgentRequestTarget");
  }

  const searchParams = candidate.searchParams;
  if (searchParams === undefined) {
    return Object.freeze({ pathname });
  }
  if (
    searchParams === null ||
    typeof searchParams !== "object" ||
    Array.isArray(searchParams)
  ) {
    throw new TypeError("Invalid AgentRequestTarget");
  }

  const entries = Object.entries(searchParams);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    throw new TypeError("Invalid AgentRequestTarget");
  }
  const searchParamsSnapshot = Object.freeze(
    Object.fromEntries(entries) as Record<string, string>,
  );
  return Object.freeze({ pathname, searchParams: searchParamsSnapshot });
}

function snapshotInteractionContext(
  value: InteractionContext | undefined,
): InteractionContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid InteractionContext");
  }
  const chatId = (value as unknown as { readonly chatId?: unknown }).chatId;
  if (typeof chatId !== "string") {
    throw new TypeError("Invalid InteractionContext");
  }
  return Object.freeze({ chatId });
}

function snapshotAgentRequestInit(
  value: AgentRequestInit | undefined,
): AgentRequestInit | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid AgentRequestInit");
  }

  const candidate = value as unknown as {
    readonly method?: unknown;
    readonly jsonBody?: unknown;
    readonly signal?: unknown;
  };
  const method = candidate.method;
  if (method !== undefined && method !== "GET" && method !== "POST") {
    throw new TypeError("Invalid AgentRequestInit");
  }
  const hasJsonBody = Object.prototype.hasOwnProperty.call(candidate, "jsonBody");
  const jsonBody = hasJsonBody ? candidate.jsonBody : undefined;
  const signal = candidate.signal;
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError("Invalid AgentRequestInit");
  }

  return Object.freeze({
    ...(method === undefined ? {} : { method }),
    ...(hasJsonBody ? { jsonBody } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AbortSignal>;
  return (
    typeof candidate.aborted === "boolean" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

export function createAgentAuthModule(
  options: CreateAgentAuthModuleOptions,
): AgentAuthModule {
  return new DefaultAgentAuthModule(options);
}

function methodForFailure(snapshot: AgentAuthSnapshot): string {
  const candidate = (snapshot as unknown as { readonly authMethod?: unknown } | null)
    ?.authMethod;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : "unknown";
}

function normalizeProviderFailure(
  prepared: PreparedAuth,
  failure: ProviderFailure,
  interactionContext: InteractionContext | undefined,
): AgentAuthFailure {
  if (failure.code === "configuration_invalid") {
    return configurationFailure(prepared.method);
  }

  if (failure.code === "interaction_required") {
    const resolved = resolveInteraction(prepared.registration, interactionContext);
    if (!resolved.ok) {
      return configurationFailure(prepared.method);
    }
    return resolved.interaction === undefined
      ? { code: failure.code, method: prepared.method, message: failure.message }
      : {
          code: failure.code,
          method: prepared.method,
          message: failure.message,
          interaction: resolved.interaction,
        };
  }

  return {
    code: failure.code,
    method: prepared.method,
    message: failure.message,
  };
}

function resolveInteraction(
  registration: AuthMethodRegistration,
  context: InteractionContext | undefined,
): InteractionResult {
  if (registration.interaction === undefined) {
    return { ok: false };
  }
  if (
    context === undefined ||
    typeof context.chatId !== "string" ||
    context.chatId.trim().length === 0
  ) {
    return { ok: true };
  }

  try {
    const authorizePath = registration.interaction.authorizePath;
    if (!authorizePath.startsWith("/") || authorizePath.startsWith("//")) {
      return { ok: false };
    }
    const url = new URL(authorizePath, INTERACTION_ORIGIN);
    if (
      url.origin !== INTERACTION_ORIGIN ||
      url.search.length !== 0 ||
      url.hash.length !== 0
    ) {
      return { ok: false };
    }
    url.searchParams.set("chatId", context.chatId);
    return {
      ok: true,
      interaction: { type: "redirect", url: `${url.pathname}${url.search}` },
    };
  } catch {
    return { ok: false };
  }
}

function configurationFailure(method: string): AgentAuthFailure {
  return {
    code: "configuration_invalid",
    method,
    message: SAFE_CONFIGURATION_MESSAGE,
  };
}

function forbiddenFailure(method: string): AgentAuthFailure {
  return {
    code: "forbidden",
    method,
    message: FORBIDDEN_MESSAGE,
  };
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the stable authentication result. A rejected
    // cancellation only prevents connection reuse for this discarded response.
  }
}

function misconfiguredStatus(): AgentAuthStatus {
  return { state: "misconfigured", message: SAFE_CONFIGURATION_MESSAGE };
}
