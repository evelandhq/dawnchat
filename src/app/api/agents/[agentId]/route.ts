import {
  deleteAgentConnectionById,
  updateAndCheckAgentConnection,
} from "@/app/api/agents/api";

type AgentRouteContext = {
  params: Promise<{ agentId: string }>;
};

export async function PATCH(request: Request, context: AgentRouteContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { agentId } = await context.params;
  return updateAndCheckAgentConnection(agentId, body);
}

export async function DELETE(_request: Request, context: AgentRouteContext): Promise<Response> {
  const { agentId } = await context.params;
  return deleteAgentConnectionById(agentId);
}
