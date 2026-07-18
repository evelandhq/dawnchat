import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { createAgentOidcService } from "@/eve/oidc";
import { agentAuthCallbackUrl } from "@/lib/public-origin";

type StartOidcRouteContext = {
  params: Promise<{ agentId: string }>;
};

export async function GET(request: Request, context: StartOidcRouteContext): Promise<Response> {
  const { agentId } = await context.params;
  const repository = createRepository(getDbClient());
  const connection = await repository.getAgentConnection(agentId);
  if (!connection || connection.authType !== "oidc") {
    return Response.json({ error: "Agent Auth interaction not found" }, { status: 404 });
  }
  const returnPath = new URL(request.url).searchParams.get("returnPath");
  if (!returnPath) return Response.json({ error: "Agent Auth return path is required" }, { status: 400 });
  try {
    const interaction = await createAgentOidcService({ repository }).start({
      connection,
      callbackUrl: agentAuthCallbackUrl(request.url),
      returnPath,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: interaction.authorizationUrl,
        "cache-control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "Agent authorization could not be started" }, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
}
