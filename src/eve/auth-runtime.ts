import type { ClientOptions } from "eve/client";

import type { AgentConnection, Repository } from "@/db/repository";
import type { AuthType } from "@/db/schema";
import { parseAuthConfig, type EveAgentConnectionLike } from "@/eve/auth";
import {
  normalizeAgentAuthConfig,
  type OidcAuthorizationCodeConfig,
} from "@/eve/auth-methods";
import { createAgentOidcService, preflightOidcConfig } from "@/eve/oidc";

export type AgentAuthClientOptions = Pick<ClientOptions, "auth" | "headers" | "redirect">;

export type ResolvedAgentAuth = {
  method: AuthType;
  clientOptions: AgentAuthClientOptions;
  credentialVersion?: string;
};

type ResolveContext = {
  getRepository: () => Repository;
  returnPath: string;
};

type RecoverContext = {
  repository: Repository;
  returnPath: string;
  attempt: 0 | 1;
  credentialVersion: string;
};

type AgentAuthProvider = {
  method: AuthType;
  preflight(config: Record<string, unknown>): Promise<void>;
  resolve(connection: AgentConnection, context: ResolveContext): Promise<ResolvedAgentAuth>;
  resolveStatic?: (connection: EveAgentConnectionLike) => ResolvedAgentAuth;
  recoverUnauthorized?: (connection: AgentConnection, context: RecoverContext) => Promise<ResolvedAgentAuth>;
};

export class AgentAuthRecoveryUnavailableError extends Error {
  constructor() {
    super("The Agent credential was rejected.");
    this.name = "AgentAuthRecoveryUnavailableError";
  }
}

const providers = {
  "local-dev": staticProvider("local-dev", () => ({})),
  none: staticProvider("none", () => ({})),
  basic: staticProvider("basic", (config) => ({
    auth: {
      basic: {
        username: config.username as string,
        password: config.password as string,
      },
    },
    redirect: "manual",
  })),
  bearer: staticProvider("bearer", (config) => ({
    auth: { bearer: requiredToken(config.token, "Bearer token is required.") },
    redirect: "manual",
  })),
  "vercel-oidc": staticProvider("vercel-oidc", (config) => ({
    auth: { vercelOidc: { token: requiredToken(config.token, "Vercel OIDC token is required.") } },
    redirect: "manual",
  })),
  oidc: {
    method: "oidc",
    async preflight(config) {
      await preflightOidcConfig(config as OidcAuthorizationCodeConfig);
    },
    async resolve(connection, context) {
      const credential = await createAgentOidcService({ repository: context.getRepository() })
        .resolve(connection, context.returnPath);
      return {
        method: "oidc",
        clientOptions: {
          auth: { bearer: credential.token },
          redirect: "manual",
        },
        credentialVersion: String(credential.rotationSeq),
      };
    },
    async recoverUnauthorized(connection, context) {
      const rejectedRotationSeq = Number(context.credentialVersion);
      if (!Number.isSafeInteger(rejectedRotationSeq) || rejectedRotationSeq < 0) {
        throw new Error("The resolved Agent credential version is invalid.");
      }
      const credential = await createAgentOidcService({ repository: context.repository }).recoverUnauthorized({
        connection,
        rejectedRotationSeq,
        attempt: context.attempt,
        returnPath: context.returnPath,
      });
      return {
        method: "oidc",
        clientOptions: {
          auth: { bearer: credential.token },
          redirect: "manual",
        },
        credentialVersion: String(credential.rotationSeq),
      };
    },
  },
  headers: staticProvider("headers", (config) => ({
    headers: config.headers as Record<string, string>,
    redirect: "manual",
  })),
} satisfies Record<AuthType, AgentAuthProvider>;

export async function preflightAgentAuth(method: AuthType, config: Record<string, unknown>): Promise<void> {
  await providerFor(method).preflight(config);
}

export async function resolveAgentAuth(
  connection: AgentConnection,
  context: ResolveContext,
): Promise<ResolvedAgentAuth> {
  return providerFor(connection.authType).resolve(connection, context);
}

export function resolveStaticAgentAuth(connection: EveAgentConnectionLike): ResolvedAgentAuth {
  const provider = providerFor(connection.authType);
  if (!provider.resolveStatic) {
    throw new Error(`${connection.authType} Agent authentication requires an authorized credential.`);
  }
  return provider.resolveStatic(connection);
}

export function canRecoverAgentAuth(auth: ResolvedAgentAuth): boolean {
  return providerFor(auth.method).recoverUnauthorized !== undefined
    && auth.credentialVersion !== undefined;
}

export async function recoverAgentAuthAfterUnauthorized(input: {
  resolved: ResolvedAgentAuth;
  connection: AgentConnection;
  repository: Repository;
  attempt: 0 | 1;
  returnPath: string;
}): Promise<{ connection: AgentConnection; auth: ResolvedAgentAuth }> {
  const provider = providerFor(input.resolved.method);
  if (!provider.recoverUnauthorized || input.resolved.credentialVersion === undefined) {
    throw new AgentAuthRecoveryUnavailableError();
  }
  const current = await input.repository.getAgentConnection(input.connection.id);
  if (
    !current
    || current.authType !== input.resolved.method
    || current.securityRevision !== input.connection.securityRevision
  ) {
    throw new Error("The Agent Connection changed; retry the request.");
  }
  const auth = await provider.recoverUnauthorized(current, {
    repository: input.repository,
    returnPath: input.returnPath,
    attempt: input.attempt,
    credentialVersion: input.resolved.credentialVersion,
  });
  return { connection: current, auth };
}

function providerFor(method: AuthType): AgentAuthProvider {
  return providers[method];
}

function staticProvider(
  method: Exclude<AuthType, "oidc">,
  buildClientOptions: (config: Record<string, unknown>) => AgentAuthClientOptions,
): AgentAuthProvider {
  const resolveStatic = (connection: EveAgentConnectionLike): ResolvedAgentAuth => {
    const config = method === "local-dev" || method === "none"
      ? {}
      : readConfig(connection);
    return { method, clientOptions: buildClientOptions(config) };
  };
  return {
    method,
    async preflight() {},
    resolveStatic,
    async resolve(connection) {
      return resolveStatic(connection);
    },
  };
}

function readConfig(connection: EveAgentConnectionLike): Record<string, unknown> {
  const rawConfig = parseAuthConfig(connection);
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error("Agent auth configuration is missing.");
  }
  return normalizeAgentAuthConfig(connection.authType, {}, rawConfig);
}

function requiredToken(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}
