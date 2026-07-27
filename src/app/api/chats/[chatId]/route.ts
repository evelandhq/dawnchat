import { getChatWithEvents } from "@/app/api/chats/api";

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { chatId } = await context.params;
  return getChatWithEvents(request, chatId);
}
