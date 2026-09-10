import { z } from "zod";

import { redactAgentConnection } from "@/app/api/agents/api";
import { getDbClient } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { resolveEvelandConfig } from "@/identity/config";
import { normalizeAgentBaseUrl } from "@/lib/validation";

const catalogEntrySchema = z.object({
  projectId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().nullable(),
  url: z.string().transform((value, context) => {
    try {
      return normalizeAgentBaseUrl(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid Agent URL" });
      return z.NEVER;
    }
  }),
  capabilities: z.object({ eveChat: z.literal(true) }),
});

const catalogAgentRequestSchema = z.object({
  issuer: z.string().url(),
  projectId: z.string().trim().min(1),
});

const catalogResponseSchema = z.object({
  agents: z.array(catalogEntrySchema),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = catalogAgentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid Catalog Agent" }, { status: 400 });
  }

  try {
    const eveland = resolveEvelandConfig();
    const issuer = eveland.issuer;
    if (issuer !== parsed.data.issuer.replace(/\/$/, "")) {
      return Response.json(
        { error: "Catalog issuer does not match the configured Eveland instance" },
        { status: 401 },
      );
    }
    const catalogResponse = await fetch(
      `${eveland.internalOrigin}/api/agent-catalog`,
      {
        headers: { accept: "application/json" },
        redirect: "error",
      },
    );
    if (!catalogResponse.ok) {
      return Response.json(
        { error: "Eveland Agent Catalog is unavailable" },
        { status: 502 },
      );
    }
    const catalog = catalogResponseSchema.safeParse(
      await catalogResponse.json().catch(() => null),
    );
    if (!catalog.success) {
      return Response.json(
        { error: "Eveland Agent Catalog returned an invalid response" },
        { status: 502 },
      );
    }
    const entry = catalog.data.agents.find(
      (agent) => agent.projectId === parsed.data.projectId,
    );
    if (!entry) {
      return Response.json(
        { error: "Agent is not present in Eveland's current Catalog" },
        { status: 404 },
      );
    }

    const repository = createRepository(getDbClient());
    const existing = (await repository.listAgentConnections()).find(
      (agent) =>
        agent.source === "managed" &&
        agent.identityIssuer === issuer &&
        agent.evelandProjectId === parsed.data.projectId,
    );
    const agent = await repository.upsertCatalogAgent({
      identityIssuer: issuer,
      evelandProjectId: parsed.data.projectId,
      name: entry.name,
      description: entry.description,
      baseUrl: entry.url,
    });
    const available = await repository.updateAgentHealth(agent.id, {
      status: "healthy",
      lastCheckedAt: null,
    });

    return Response.json(
      {
        agent: {
          ...redactAgentConnection(available),
          description: available.description,
          source: available.source,
          identityIssuer: available.identityIssuer,
        },
      },
      { status: existing ? 200 : 201 },
    );
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
