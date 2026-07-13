export type CurrentAgentChat = {
  id: string;
  agentConnectionId: string;
};

export function pickDefaultAgentId(chats: CurrentAgentChat[], agentIds: string[]): string | null {
  const known = new Set(agentIds);
  const recent = chats.find((chat) => known.has(chat.agentConnectionId));
  return recent?.agentConnectionId ?? agentIds[0] ?? null;
}

export function deriveCurrentAgentId(
  pathname: string,
  chats: CurrentAgentChat[],
  agentIds: string[],
): string | null {
  const agentMatch = pathname.match(/^\/agents\/([^/]+)\/?$/);
  if (agentMatch && agentMatch[1] !== "new" && agentIds.includes(agentMatch[1])) {
    return agentMatch[1];
  }

  const chatMatch = pathname.match(/^\/chats\/([^/]+)\/?$/);
  if (chatMatch) {
    const chat = chats.find((item) => item.id === chatMatch[1]);
    if (chat && agentIds.includes(chat.agentConnectionId)) {
      return chat.agentConnectionId;
    }
  }

  return pickDefaultAgentId(chats, agentIds);
}
