import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { HandleMessageStreamEvent } from "eve/client";

import { createRepository, type AgentConnection, type Chat } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { ChatThread, type ChatThreadSummary } from "@/components/chat-thread";

export const dynamic = "force-dynamic";

type ChatThreadPageData = {
  chat: ChatThreadSummary;
  events: HandleMessageStreamEvent[];
  pendingUserMessage: string | null;
};

type ChatThreadPageProps = {
  params: Promise<{ chatId: string }>;
};

export async function getChatThreadForPage(chatId: string): Promise<ChatThreadPageData | null> {
  const repository = createRepository(getDbClient());
  const chat = await repository.getChat(chatId);
  if (!chat) {
    return null;
  }

  const [agent, events] = await Promise.all([
    repository.getAgentConnection(chat.agentConnectionId),
    repository.listEvents(chat.id),
  ]);

  return {
    chat: chatThreadSummaryForPage(chat, agent),
    events: events.map((event) => event.payload as HandleMessageStreamEvent),
    pendingUserMessage: chat.pendingUserMessage,
  };
}

export async function generateMetadata({ params }: ChatThreadPageProps): Promise<Metadata> {
  const { chatId } = await params;
  const chat = await createRepository(getDbClient()).getChat(chatId);
  return { title: chat?.title ?? "Chat" };
}

export default async function ChatThreadPage({ params }: ChatThreadPageProps): Promise<React.ReactElement> {
  const { chatId } = await params;
  const data = await getChatThreadForPage(chatId);
  if (!data) {
    notFound();
  }

  return <ChatThread {...data} />;
}

function chatThreadSummaryForPage(chat: Chat, agent: AgentConnection | null): ChatThreadSummary {
  return {
    id: chat.id,
    agentConnectionId: chat.agentConnectionId,
    agentName: agent?.name ?? "Unknown agent",
    title: chat.title,
    status: chat.status,
    sessionState: chat.sessionState
      ? {
          sessionId: chat.sessionState.sessionId,
          streamIndex: chat.sessionState.streamIndex ?? 0,
        }
      : null,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}
