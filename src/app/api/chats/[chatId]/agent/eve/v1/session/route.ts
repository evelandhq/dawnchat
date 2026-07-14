import { proxyCreateEveSession } from "@/app/api/chats/eve-proxy";

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { chatId } = await context.params;
  return proxyCreateEveSession(request, chatId);
}
