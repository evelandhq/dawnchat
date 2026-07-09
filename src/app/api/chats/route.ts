import { createChatWithFirstMessage, listChats } from "@/app/api/chats/api";

export async function GET(): Promise<Response> {
  return listChats();
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  return createChatWithFirstMessage(body);
}
