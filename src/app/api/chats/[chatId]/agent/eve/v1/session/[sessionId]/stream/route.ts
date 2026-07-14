import { proxyEveSessionStream } from "@/app/api/chats/eve-proxy";

type RouteContext = {
  params: Promise<{ chatId: string; sessionId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { chatId, sessionId } = await context.params;
  return proxyEveSessionStream(request, chatId, sessionId);
}
