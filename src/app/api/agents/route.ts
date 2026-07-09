import { createAndCheckAgentConnection, listAgentConnections } from "@/app/api/agents/api";

export async function GET(): Promise<Response> {
  return listAgentConnections();
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  return createAndCheckAgentConnection(body);
}
