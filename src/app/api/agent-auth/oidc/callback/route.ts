import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { checkEveAgent } from "@/eve/client";
import { createAgentOidcService } from "@/eve/oidc";
import { agentAuthCallbackSchema } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  const parsed = agentAuthCallbackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid Agent Auth callback" }, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  const repository = createRepository(getDbClient());
  try {
    const completed = await createAgentOidcService({ repository }).callback({ search: parsed.data.search });
    const connection = await repository.getAgentConnection(completed.agentConnectionId);
    if (!connection) throw new Error("Agent Connection not found after authorization.");
    const check = await checkEveAgent(connection);
    await repository.updateAgentHealth(connection.id, {
      status: check.status,
      lastCheckedAt: new Date(),
      expectedSecurityRevision: connection.securityRevision,
    });
    if (check.status === "authorization_required") {
      throw new Error("The Agent rejected the authorized OIDC credential.");
    }
    return Response.json({ returnPath: completed.returnPath }, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Agent authorization could not be completed" }, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
}
