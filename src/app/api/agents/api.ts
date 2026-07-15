import { z } from "zod";

import { createRepository, DuplicateAgentUrlError, type AgentConnection } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { checkEveAgent, type EveHealthCheckResult } from "@/eve/client";
import { encryptAuthConfig, parseAuthConfig } from "@/eve/auth";
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
  authType: "none" | "bearer" | "header";
  hasAuth: boolean;
  status: "unknown" | "healthy" | "unreachable";
  lastCheckedAt: string | null;
};

export type AgentConnectionEditDefaults = {
  id: string;
  name: string;
  baseUrl: string;
  authType: "none" | "bearer" | "header";
  hasAuth: boolean;
  headerName: string;
};

type StoredAuthConfig =
  | { authType: "none" }
  | { authType: "bearer"; bearerToken: string }
  | { authType: "header"; headerName: string; headerValue: string };

type UpdateAgentConnectionData = z.infer<typeof updateAgentConnectionSchema>;

class InvalidAgentAuthUpdateError extends Error {}

function readStoredAuthConfig(agent: AgentConnection): StoredAuthConfig {
  if (agent.authType === "none") {
    return { authType: "none" };
  }

  const config = parseAuthConfig(agent);
  if (!config || typeof config !== "object") {
    throw new Error("Agent auth configuration is missing");
  }
  const values = config as Record<string, unknown>;

  if (agent.authType === "bearer") {
    const bearerToken = values.bearerToken ?? values.token;
    if (typeof bearerToken !== "string" || bearerToken.length === 0) {
      throw new Error("Bearer auth configuration is missing a token");
    }
    return { authType: "bearer", bearerToken };
  }

  const headerName = values.headerName;
  const headerValue = values.headerValue ?? values.value;
  if (
    typeof headerName !== "string" ||
    headerName.length === 0 ||
    typeof headerValue !== "string" ||
    headerValue.length === 0
  ) {
    throw new Error("Header auth configuration is missing a header name or value");
  }
  return { authType: "header", headerName, headerValue };
}

export function getAgentConnectionEditDefaults(agent: AgentConnection): AgentConnectionEditDefaults {
  const auth = readStoredAuthConfig(agent);
  return {
    id: agent.id,
    name: agent.name,
    baseUrl: agent.baseUrl,
    authType: agent.authType,
    hasAuth: auth.authType !== "none",
    headerName: auth.authType === "header" ? auth.headerName : "",
  };
}

function hasSubmittedSecret(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function resolveUpdatedAuthConfig(
  existing: AgentConnection,
  input: UpdateAgentConnectionData,
): string | null {
  if (input.authType === "none") {
    return null;
  }

  if (input.authType === "bearer") {
    if (hasSubmittedSecret(input.bearerToken)) {
      return encryptAuthConfig({ bearerToken: input.bearerToken });
    }
    if (existing.authType !== "bearer" || !existing.authConfigEncrypted) {
      throw new InvalidAgentAuthUpdateError("A new bearer token is required");
    }
    const stored = readStoredAuthConfig(existing);
    if (stored.authType !== "bearer") {
      throw new Error("Stored bearer auth configuration is invalid");
    }
    return existing.authConfigEncrypted;
  }

  if (!input.headerName) {
    throw new InvalidAgentAuthUpdateError("A valid header name is required");
  }
  if (hasSubmittedSecret(input.headerValue)) {
    return encryptAuthConfig({
      headerName: input.headerName,
      headerValue: input.headerValue,
    });
  }
  if (existing.authType !== "header") {
    throw new InvalidAgentAuthUpdateError("A new header value is required");
  }
  const stored = readStoredAuthConfig(existing);
  if (stored.authType !== "header") {
    throw new Error("Stored header auth configuration is invalid");
  }
  return encryptAuthConfig({
    headerName: input.headerName,
    headerValue: stored.headerValue,
  });
}

export function redactAgentConnection(agent: AgentConnection): RedactedAgentConnection {
  return {
    id: agent.id,
    name: agent.name,
    baseUrl: agent.baseUrl,
    authType: agent.authType,
    hasAuth: agent.authType !== "none" && Boolean(agent.authConfigEncrypted),
    status: agent.status,
    lastCheckedAt: agent.lastCheckedAt?.toISOString() ?? null,
  };
}

export function encodeAuthConfig(input: z.infer<typeof createAgentConnectionSchema>): string | null {
  if (input.authType === "none") {
    return null;
  }

  if (input.authType === "bearer") {
    return encryptAuthConfig({ bearerToken: input.bearerToken });
  }

  return encryptAuthConfig({ headerName: input.headerName, headerValue: input.headerValue });
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
    const repository = createRepository(getDbClient());
    const created = await repository.createAgentConnection({
      name: parsed.data.name,
      baseUrl: parsed.data.baseUrl,
      authType: parsed.data.authType,
      authConfigEncrypted: encodeAuthConfig(parsed.data),
    });

    const check = await checkEveAgent(created);
    const checked = await repository.updateAgentHealth(created.id, { status: check.status, lastCheckedAt: new Date() });

    return jsonResponse(createCheckResponse(checked, check), { status: 201 });
  } catch (error) {
    if (error instanceof DuplicateAgentUrlError) {
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

    const updated = await repository.updateAgentConnection(agentId, {
      name: parsed.data.name,
      baseUrl: parsed.data.baseUrl,
      authType: parsed.data.authType,
      authConfigEncrypted: resolveUpdatedAuthConfig(existing, parsed.data),
    });
    if (!updated) {
      return jsonResponse({ error: "Agent connection not found" }, { status: 404 });
    }

    const check = await checkEveAgent(updated);
    const checked = await repository.updateAgentHealth(updated.id, {
      status: check.status,
      lastCheckedAt: new Date(),
    });
    return jsonResponse(createCheckResponse(checked, check));
  } catch (error) {
    if (error instanceof InvalidAgentAuthUpdateError) {
      return validationErrorResponse();
    }
    if (error instanceof DuplicateAgentUrlError) {
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
    const checked = await repository.updateAgentHealth(agent.id, { status: check.status, lastCheckedAt: new Date() });

    return jsonResponse(createCheckResponse(checked, check));
  } catch {
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
    ...("authFailure" in check && check.authFailure !== undefined
      ? { authFailure: check.authFailure }
      : {}),
  };
}
