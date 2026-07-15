import { builtInAuthMethodCatalog } from "@/agent-auth/built-ins";
import type {
  AgentAuthModule,
  AgentRequestInit,
  AgentRequestTarget,
} from "@/agent-auth/contracts";
import {
  AgentAuthSnapshotConfigurationError,
  createAgentAuthModule,
  type AgentAuthSnapshot,
} from "@/agent-auth/module";
import {
  createAgentTransport,
  prepareAgentTransportInit,
  type AgentTransport,
} from "@/agent-auth/transport";
import { getDbClient } from "@/db/provider";
import {
  createRepository,
  type AgentConnection,
} from "@/db/repository";
import type { AuthType } from "@/db/schema";
import { parseAuthConfig } from "@/eve/auth";

/**
 * Direct server composition root. Keep this file out of the broad client-safe
 * `@/agent-auth` barrel: it owns database, decryption, DNS, and fetch wiring.
 */

interface LegacyAuthAdapter {
  readonly method: string;
  readonly adapt: (connection: AgentConnection) => unknown;
}

const LEGACY_AUTH_ADAPTERS: Record<AuthType, LegacyAuthAdapter> = {
  none: {
    method: "none",
    adapt: () => ({}),
  },
  bearer: {
    method: "bearer",
    adapt: (connection) => {
      const values = legacyConfigObject(connection);
      const token = values.bearerToken ?? values.token;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("Legacy bearer configuration is missing its token");
      }
      return { token };
    },
  },
  header: {
    method: "headers",
    adapt: (connection) => {
      const values = legacyConfigObject(connection);
      const headerName = values.headerName;
      const headerValue = values.headerValue ?? values.value;
      if (
        typeof headerName !== "string" ||
        headerName.length === 0 ||
        typeof headerValue !== "string" ||
        headerValue.length === 0
      ) {
        throw new Error("Legacy header configuration is incomplete");
      }
      return { headers: { [headerName]: headerValue } };
    },
  },
};

interface DefaultAgentAuthRuntime {
  readonly module: AgentAuthModule;
  readonly transport: AgentTransport;
}

let defaultRuntime: DefaultAgentAuthRuntime | undefined;
let testModule: AgentAuthModule | undefined;

export function getAgentAuthModule(): AgentAuthModule {
  if (testModule !== undefined) {
    return testModule;
  }
  return getDefaultRuntime().module;
}

export function requestAnonymousAgent(
  baseUrl: string,
  target: AgentRequestTarget,
  init?: AgentRequestInit,
): Promise<Response> {
  return getDefaultRuntime().transport.request({
    baseUrl,
    credential: { kind: "none" },
    target,
    init: prepareAgentTransportInit(init),
  });
}

export function setAgentAuthModuleForTests(module: AgentAuthModule): void {
  assertTestEnvironment("setAgentAuthModuleForTests");
  testModule = module;
}

export function resetAgentAuthModuleForTests(): void {
  assertTestEnvironment("resetAgentAuthModuleForTests");
  testModule = undefined;
}

function getDefaultRuntime(): DefaultAgentAuthRuntime {
  defaultRuntime ??= createDefaultRuntime();
  return defaultRuntime;
}

function createDefaultRuntime(): DefaultAgentAuthRuntime {
  const localTransportAllowed =
    process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development";
  const transport = createAgentTransport({
    ...(localTransportAllowed
      ? {
          policy: {
            allowInsecureHttp: true,
            allowlistedHostnames: ["localhost", "127.0.0.1", "::1"],
          },
        }
      : {}),
  });
  const module = createAgentAuthModule({
    catalog: builtInAuthMethodCatalog,
    transport,
    // Deliberately construct the repository inside every load. Tests can replace
    // the current DB client, and production requests must not retain stale handles.
    load: async (target): Promise<AgentAuthSnapshot> => {
      const repository = createRepository(getDbClient());
      const connection = await repository.getAgentConnection(target.agentConnectionId);
      if (!connection) {
        throw new AgentAuthSnapshotConfigurationError({
          cause: new Error("Agent connection was not found"),
        });
      }

      const adapter = LEGACY_AUTH_ADAPTERS[connection.authType];
      if (adapter === undefined) {
        throw new AgentAuthSnapshotConfigurationError({
          cause: new Error("Stored authentication method is unsupported"),
        });
      }
      try {
        return {
          agentConnectionId: connection.id,
          baseUrl: connection.baseUrl,
          authMethod: adapter.method,
          authConfig: adapter.adapt(connection),
          securityRevision: connection.securityRevision,
        };
      } catch (cause) {
        throw new AgentAuthSnapshotConfigurationError({
          method: adapter.method,
          cause,
        });
      }
    },
  });
  return { module, transport };
}

function legacyConfigObject(connection: AgentConnection): Record<string, unknown> {
  const config = parseAuthConfig(connection);
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Legacy authentication configuration is missing");
  }
  return config as Record<string, unknown>;
}

function assertTestEnvironment(operation: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`${operation} may only be used while testing`);
  }
}
