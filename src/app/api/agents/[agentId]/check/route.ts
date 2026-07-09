import { checkAgentConnection } from "@/app/api/agents/api";

type RouteContext = {
  params: Promise<{ agentId: string }> | { agentId: string };
};

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const params = await context.params;
  return checkAgentConnection(params.agentId);
}
