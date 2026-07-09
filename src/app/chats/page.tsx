import { createRepository, type AgentConnection, type Chat } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { ChatList, type ChatListAgent, type ChatListSummary } from "@/components/chat-list";

export const dynamic = "force-dynamic";

type ChatsPageData = {
  chats: ChatListSummary[];
  agents: ChatListAgent[];
};

export async function getChatsForPage(): Promise<ChatsPageData> {
  const repository = createRepository(getDbClient());
  const [chats, agents] = await Promise.all([repository.listChats(), repository.listAgentConnections()]);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const summaries = await Promise.all(
    chats.map(async (chat) => {
      const messages = await repository.listMessages(chat.id);
      return chatSummaryForPage(chat, agentsById.get(chat.agentConnectionId), messages.at(-1)?.content ?? null);
    }),
  );

  return {
    chats: summaries,
    agents: agents.map(agentForChatList),
  };
}

export default async function ChatsPage(): Promise<React.ReactElement> {
  const data = await getChatsForPage();
  return <ChatList {...data} />;
}

function chatSummaryForPage(chat: Chat, agent: AgentConnection | undefined, lastMessage: string | null): ChatListSummary {
  return {
    id: chat.id,
    agentConnectionId: chat.agentConnectionId,
    agentName: agent?.name ?? "Unknown agent",
    title: chat.title,
    status: chat.status,
    lastMessage,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

function agentForChatList(agent: AgentConnection): ChatListAgent {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
  };
}
