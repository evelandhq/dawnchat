import { notFound } from "next/navigation";

import { createRepository, type AgentConnection, type Chat, type Message } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { ChatThread, type ChatThreadMessage, type ChatThreadSummary } from "@/components/chat-thread";

export const dynamic = "force-dynamic";

type ChatThreadPageData = {
  chat: ChatThreadSummary;
  messages: ChatThreadMessage[];
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

  const [agent, messages] = await Promise.all([
    repository.getAgentConnection(chat.agentConnectionId),
    repository.listMessages(chat.id),
  ]);

  return {
    chat: chatThreadSummaryForPage(chat, agent),
    messages: messages.map(messageForThread),
  };
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
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

function messageForThread(message: Message): ChatThreadMessage {
  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    content: message.content,
    eventIndex: message.eventIndex,
    createdAt: message.createdAt.toISOString(),
  };
}
