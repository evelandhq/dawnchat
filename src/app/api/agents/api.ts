import { z } from "zod";

import {
  AgentConnectionChangedError,
  createRepository,
  DuplicateAgentUrlError,
  type AgentConnection,
} from "@/db/repository";
import type { AgentConnectionStatus, AuthType } from "@/db/schema";
import { getDbClient } from "@/db/provider";
import { checkEveAgent, type EveHealthCheckResult } from "@/eve/client";
import { encryptAuthConfig, parseAuthConfig } from "@/eve/auth";
import {
  agentAuthMethodStoresConfig,
  agentAuthConfigsEqual,
  normalizeAgentAuthConfig,
  redactAgentAuthConfig,
  validateAgentAuthTarget,
} from "@/eve/auth-methods";
import { preflightAgentAuth } from "@/eve/auth-runtime";
import { createId } from "@/lib/ids";
import {
  createAgentConnectionSchema,
  discoverAgentsSchema,
  normalizeAgentBaseUrl,
  updateAgentConnectionSchema,
} from "@/lib/validation";

export type RedactedAgentConnection = {
  id: string;
  name: string;
  baseUrl: string;
  authType: AuthType;
  hasAuth: boolean;
  securityRevision: number;
  status: AgentConnectionStatus;
  lastCheckedAt: string | null;
};

export type AgentConnectionEditDefaults = {
  id: string;
  name: string;
  baseUrl: string;
  authType: AuthType;
  hasAuth: boolean;
  securityRevision: number;
  config: Record<string, unknown>;
  status: AgentConnectionStatus;
};

type UpdateAgentConnectionData = z.infer<typeof updateAgentConnectionSchema>;

class InvalidAgentAuthUpdateError extends Error {}

function readStoredAuthConfig(agent: AgentConnection): Record<string, unknown> {
  if (!agentAuthMethodStoresConfig(agent.authType)) return {};
  return normalizeAgentAuthConfig(agent.authType, {}, parseAuthConfig(agent));
}

export function getAgentConnectionEditDefaults(agent: AgentConnection): AgentConnectionEditDefaults {
  const auth = readStoredAuthConfig(agent);
  return {
    id: agent.id,
    name: agent.name,
    baseUrl: agent.baseUrl,
    authType: agent.authType,
    hasAuth: agentAuthMethodStoresConfig(agent.authType),
    securityRevision: agent.securityRevision,
    config: redactAgentAuthConfig(agent.authType, auth),
    status: agent.status,
  };
}

function resolveUpdatedAuthConfig(
  existing: AgentConnection,
  input: UpdateAgentConnectionData,
): { config: Record<string, unknown>; encrypted: string | null; securityChanged: boolean } {
  let previous: Record<string, unknown> | undefined;
  if (existing.authType === input.authType) previous = readStoredAuthConfig(existing);
  let config: Record<string, unknown>;
  try {
    config = normalizeAgentAuthConfig(input.authType, input.config, previous);
  } catch (error) {
    throw new InvalidAgentAuthUpdateError(error instanceof Error ? error.message : "Invalid Agent Auth configuration");
  }
  const securityChanged = existing.baseUrl !== input.baseUrl
    || existing.authType !== input.authType
    || !agentAuthConfigsEqual(previous, config);
  const securityRevision = existing.securityRevision + (securityChanged ? 1 : 0);
  return {
    config,
    encrypted: agentAuthMethodStoresConfig(input.authType)
      ? encryptAuthConfig(config, {
          id: existing.id,
          authType: input.authType,
          securityRevision,
        })
      : null,
    securityChanged,
  };
}

export function redactAgentConnection(agent: AgentConnection): RedactedAgentConnection {
  return {
    id: agent.id,
    name: agent.name,
    baseUrl: agent.baseUrl,
    authType: agent.authType,
    hasAuth: agentAuthMethodStoresConfig(agent.authType) && Boolean(agent.authConfigEncrypted),
    securityRevision: agent.securityRevision,
    status: agent.status,
    lastCheckedAt: agent.lastCheckedAt?.toISOString() ?? null,
  };
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

export function validationErrorResponse(): Response {
  return jsonResponse({ error: "Invalid agent connection" }, { status: 400 });
}

export function unknownErrorResponse(): Response {
  return jsonResponse({ error: "Internal server error" }, { status: 500 });
}

export async function createAndCheckAgentConnection(body: unknown): Promise<Response> {
  const parsed = createAgentConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return validationErrorResponse();
  }

  try {
    assertValidAuthTarget(parsed.data.authType, parsed.data.baseUrl);
    let normalizedConfig: Record<string, unknown>;
    try {
      normalizedConfig = normalizeAgentAuthConfig(parsed.data.authType, parsed.data.config);
    } catch {
      return validationErrorResponse();
    }
    try {
      await preflightAgentAuth(parsed.data.authType, normalizedConfig);
    } catch {
      return jsonResponse({ error: "Agent Auth provider preflight failed" }, { status: 422 });
    }
    const repository = createRepository(getDbClient());
    const agentId = createId("agent");
    const created = await repository.createAgentConnection({
      id: agentId,
      name: parsed.data.name,
      baseUrl: parsed.data.baseUrl,
      authType: parsed.data.authType,
      authConfigEncrypted: agentAuthMethodStoresConfig(parsed.data.authType)
        ? encryptAuthConfig(normalizedConfig, {
            id: agentId,
            authType: parsed.data.authType,
            securityRevision: 1,
          })
        : null,
    });

    const check = await checkEveAgent(created);
    const checked = await repository.updateAgentHealth(created.id, {
      status: check.status,
      lastCheckedAt: new Date(),
      expectedSecurityRevision: created.securityRevision,
    });

    return jsonResponse(createCheckResponse(checked, check), { status: 201 });
  } catch (error) {
    if (error instanceof InvalidAgentAuthUpdateError) {
      return validationErrorResponse();
    }
    if (error instanceof DuplicateAgentUrlError) {
      return jsonResponse({ error: error.message }, { status: 409 });
    }
    if (error instanceof AgentConnectionChangedError) {
      return jsonResponse({ error: error.message }, { status: 409 });
    }
    return unknownErrorResponse();
  }
}

export async function updateAndCheckAgentConnection(agentId: string, body: unknown): Promise<Response> {
  const parsed = updateAgentConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return validationErrorResponse();
  }

  try {
    const repository = createRepository(getDbClient());
    const existing = await repository.getAgentConnection(agentId);
    if (!existing) {
      return jsonResponse({ error: "Agent connection not found" }, { status: 404 });
    }

    assertValidAuthTarget(parsed.data.authType, parsed.data.baseUrl);
    const resolvedAuth = resolveUpdatedAuthConfig(existing, parsed.data);
    if (resolvedAuth.securityChanged) {
      try {
        await preflightAgentAuth(parsed.data.authType, resolvedAuth.config);
      } catch {
        return jsonResponse({ error: "Agent Auth provider preflight failed" }, { status: 422 });
      }
    }
    const updated = await repository.updateAgentConnection(agentId, {
      name: parsed.data.name,
      baseUrl: parsed.data.baseUrl,
      authType: parsed.data.authType,
      authConfigEncrypted: resolvedAuth.encrypted,
      expectedSecurityRevision: existing.securityRevision,
      securityChanged: resolvedAuth.securityChanged,
    });
    if (!updated) {
      return jsonResponse({ error: "Agent connection was updated by another request" }, { status: 409 });
    }

    if (resolvedAuth.securityChanged) {
      await repository.deleteStaleAgentAuthCredentials(updated.id, updated.securityRevision);
    }

    const check = await checkEveAgent(updated);
    const checked = await repository.updateAgentHealth(updated.id, {
      status: check.status,
      lastCheckedAt: new Date(),
      expectedSecurityRevision: updated.securityRevision,
    });
    return jsonResponse(createCheckResponse(checked, check));
  } catch (error) {
    if (error instanceof InvalidAgentAuthUpdateError) {
      return validationErrorResponse();
    }
    if (error instanceof DuplicateAgentUrlError) {
      return jsonResponse({ error: error.message }, { status: 409 });
    }
    if (error instanceof AgentConnectionChangedError) {
      return jsonResponse({ error: error.message }, { status: 409 });
    }
    return unknownErrorResponse();
  }
}

export async function deleteAgentConnectionById(agentId: string): Promise<Response> {
  try {
    const repository = createRepository(getDbClient());
    const deleted = await repository.deleteAgentConnection(agentId);
    if (!deleted) {
      return jsonResponse({ error: "Agent connection not found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch {
    return unknownErrorResponse();
  }
}

export async function listAgentConnections(): Promise<Response> {
  try {
    const repository = createRepository(getDbClient());
    const agents = await repository.listAgentConnections();
    return jsonResponse({ agents: agents.map(redactAgentConnection) });
  } catch {
    return unknownErrorResponse();
  }
}

export async function checkAgentConnection(agentId: string): Promise<Response> {
  try {
    const repository = createRepository(getDbClient());
    const agent = await repository.getAgentConnection(agentId);
    if (!agent) {
      return jsonResponse({ error: "Agent connection not found" }, { status: 404 });
    }

    const check = await checkEveAgent(agent);
    const checked = await repository.updateAgentHealth(agent.id, {
      status: check.status,
      lastCheckedAt: new Date(),
      expectedSecurityRevision: agent.securityRevision,
    });

    return jsonResponse(createCheckResponse(checked, check));
  } catch (error) {
    if (error instanceof AgentConnectionChangedError) {
      return jsonResponse({ error: error.message }, { status: 409 });
    }
    return unknownErrorResponse();
  }
}

const gatewayAgentSchema = z.object({
  name: z.string().trim().min(1),
  url: z.string(),
});

const gatewayDirectorySchema = z.object({
  agents: z.array(z.unknown()),
});

export type DiscoveredAgent = {
  name: string;
  url: string;
  connected: boolean;
};

export async function discoverAgentsFromGateway(body: unknown): Promise<Response> {
  const parsed = discoverAgentsSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: "Invalid discovery request" }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(`${parsed.data.gatewayUrl}/.well-known/eve/agents.json`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return jsonResponse({ error: "Gateway unreachable" }, { status: 502 });
  }

  if (!response.ok) {
    return jsonResponse({ error: "Gateway unreachable" }, { status: 502 });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return jsonResponse({ error: "Invalid gateway response" }, { status: 502 });
  }

  const directory = gatewayDirectorySchema.safeParse(payload);
  if (!directory.success) {
    return jsonResponse({ error: "Invalid gateway response" }, { status: 502 });
  }

  try {
    const repository = createRepository(getDbClient());
    const connectedUrls = new Set((await repository.listAgentConnections()).map((agent) => agent.baseUrl));

    const agents: DiscoveredAgent[] = [];
    for (const entry of directory.data.agents) {
      const agent = gatewayAgentSchema.safeParse(entry);
      if (!agent.success) {
        continue;
      }

      let url: string;
      try {
        url = normalizeAgentBaseUrl(agent.data.url);
      } catch {
        continue;
      }

      agents.push({ name: agent.data.name, url, connected: connectedUrls.has(url) });
    }

    return jsonResponse({ agents });
  } catch {
    return unknownErrorResponse();
  }
}

function createCheckResponse(agent: AgentConnection, check: EveHealthCheckResult): Record<string, unknown> {
  return {
    agent: redactAgentConnection(agent),
    ...(check.info === undefined ? {} : { info: check.info }),
    ...(check.error === undefined ? {} : { error: check.error }),
    ...(check.authorization === undefined ? {} : { authorization: check.authorization }),
  };
}

function assertValidAuthTarget(authType: AuthType, baseUrl: string): void {
  try {
    validateAgentAuthTarget(authType, baseUrl);
  } catch (error) {
    throw new InvalidAgentAuthUpdateError(error instanceof Error ? error.message : "Invalid Agent Auth target");
  }
}
