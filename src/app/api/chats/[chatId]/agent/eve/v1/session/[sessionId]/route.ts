import { proxyContinueEveSession } from "@/app/api/chats/eve-proxy";

type RouteContext = {
  params: Promise<{ chatId: string; sessionId: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { chatId, sessionId } = await context.params;
  return proxyContinueEveSession(request, chatId, sessionId);
}
