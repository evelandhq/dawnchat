import { claimChats } from "@/app/api/chats/api";

export async function POST(request: Request): Promise<Response> {
  return claimChats(request);
}
