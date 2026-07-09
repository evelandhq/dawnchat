import { sendChatMessage } from "@/app/api/chats/api";

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { chatId } = await context.params;
  return sendChatMessage(chatId, body);
}
