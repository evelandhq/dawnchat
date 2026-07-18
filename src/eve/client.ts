import { Client, ClientError } from "eve/client";

import { createRepository, type AgentConnection } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import type { EveAgentConnectionLike } from "@/eve/auth";
import {
  AgentAuthRecoveryUnavailableError,
  canRecoverAgentAuth,
  recoverAgentAuthAfterUnauthorized,
  resolveAgentAuth,
  resolveStaticAgentAuth,
  type ResolvedAgentAuth,
} from "@/eve/auth-runtime";
import { AgentAuthorizationRequiredError } from "@/eve/oidc";

export type { EveAgentConnectionLike } from "@/eve/auth";

export interface EveHealthCheckResult {
  readonly status: "healthy" | "unreachable" | "authorization_required";
  readonly info?: unknown;
  readonly error?: string;
  readonly authorization?: { type: "redirect"; url: string };
}

export type ResolvedEveClient = {
  client: Client;
  connection: AgentConnection;
  auth: ResolvedAgentAuth;
};

export function createEveClientForConnection(connection: EveAgentConnectionLike): Client {
  const auth = resolveStaticAgentAuth(connection);
  return new Client({
    host: connection.baseUrl,
    preserveCompletedSessions: true,
    ...auth.clientOptions,
  });
}

export async function resolveEveClientForConnection(
  connection: AgentConnection,
  returnPath = `/agents/${connection.id}/edit`,
): Promise<ResolvedEveClient> {
  const auth = await resolveAgentAuth(connection, {
    getRepository: () => createRepository(getDbClient()),
    returnPath,
  });
  return {
    client: new Client({
      host: connection.baseUrl,
      preserveCompletedSessions: true,
      ...auth.clientOptions,
    }),
    connection,
    auth,
  };
}

export async function recoverEveClientAfterUnauthorized(
  resolved: ResolvedEveClient,
  attempt: 0 | 1,
  returnPath = `/agents/${resolved.connection.id}/edit`,
): Promise<ResolvedEveClient> {
  const repository = createRepository(getDbClient());
  const recovered = await recoverAgentAuthAfterUnauthorized({
    resolved: resolved.auth,
    connection: resolved.connection,
    repository,
    attempt,
    returnPath,
  });
  return {
    client: new Client({
      host: recovered.connection.baseUrl,
      preserveCompletedSessions: true,
      ...recovered.auth.clientOptions,
    }),
    connection: recovered.connection,
    auth: recovered.auth,
  };
}

export async function checkEveAgent(connection: AgentConnection): Promise<EveHealthCheckResult> {
  const returnPath = `/agents/${connection.id}/edit`;
  try {
    let resolved = await resolveEveClientForConnection(connection, returnPath);
    try {
      return await checkResolvedClient(resolved.client);
    } catch (error) {
      if (!(error instanceof ClientError) || error.status !== 401) throw error;
      if (!canRecoverAgentAuth(resolved.auth)) throw error;
      try {
        resolved = await recoverEveClientAfterUnauthorized(resolved, 0, returnPath);
      } catch (recoveryError) {
        if (recoveryError instanceof AgentAuthRecoveryUnavailableError) throw error;
        throw recoveryError;
      }
      try {
        return await checkResolvedClient(resolved.client);
      } catch (retryError) {
        if (!(retryError instanceof ClientError) || retryError.status !== 401) throw retryError;
        await recoverEveClientAfterUnauthorized(resolved, 1, returnPath);
        throw retryError;
      }
    }
  } catch (error) {
    if (error instanceof AgentAuthorizationRequiredError) {
      return {
        status: "authorization_required",
        error: error.message,
        authorization: { type: "redirect", url: error.interactionUrl },
      };
    }
    return { status: "unreachable", error: error instanceof Error ? error.message : "Unknown Eve health check error" };
  }
}

async function checkResolvedClient(client: Client): Promise<EveHealthCheckResult> {
  const health = await client.health();
  const info = await fetchAgentInfo(client, health);
  return { status: "healthy", info };
}

async function fetchAgentInfo(client: Client, health: unknown): Promise<unknown> {
  const response = await client.fetch("/eve/v1/info");
  if (!response.ok) {
    if (response.status === 404) return health;
    throw new ClientError(response.status, await response.text(), response.headers);
  }

  try {
    return await response.json();
  } catch {
    return health;
  }
}
