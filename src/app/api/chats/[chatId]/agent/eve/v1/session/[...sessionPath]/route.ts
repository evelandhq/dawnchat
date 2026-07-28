import {
  proxyCancelEveTurn,
  proxyContinueEveSession,
  proxyEveSessionStream,
} from "@/app/api/chats/eve-proxy";

type RouteContext = {
  params: Promise<{ chatId: string; sessionPath: string[] }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { chatId, sessionPath } = await context.params;
  if (sessionPath.length !== 2 || sessionPath[1] !== "stream") {
    return Response.json({ error: "Eve session route not found" }, { status: 404 });
  }
  return proxyEveSessionStream(request, chatId, sessionPath[0]!);
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { chatId, sessionPath } = await context.params;
  if (sessionPath.length === 1) {
    return proxyContinueEveSession(request, chatId, sessionPath[0]!);
  }
  if (sessionPath.length === 2 && sessionPath[1] === "cancel") {
    return proxyCancelEveTurn(request, chatId, sessionPath[0]!);
  }
  return Response.json({ error: "Eve session route not found" }, { status: 404 });
}
