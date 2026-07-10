import { z } from "zod";

import { createRepository, type AgentConnection } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { checkEveAgent, type EveHealthCheckResult } from "@/eve/client";
import { encryptAuthConfig } from "@/eve/auth";
import { createAgentConnectionSchema, discoverAgentsSchema, normalizeAgentBaseUrl } from "@/lib/validation";

export type RedactedAgentConnection = {
  id: string;
  name: string;
  baseUrl: string;
  authType: "none" | "bearer" | "header";
  hasAuth: boolean;
  status: "unknown" | "healthy" | "unreachable";
  lastCheckedAt: string | null;
};

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
  };
}
