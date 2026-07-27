import { createChatWithFirstMessage, listChats } from "@/app/api/chats/api";

export async function GET(request: Request): Promise<Response> {
  return listChats(request);
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  return createChatWithFirstMessage(request, body);
}
