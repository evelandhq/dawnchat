export function agentAuthCallbackSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.get("state")) return null;
  return `?${params.toString()}`;
}

export type AgentAuthReturnTarget =
  | { type: "agent"; id: string }
  | { type: "chat"; id: string };

export function parseAgentAuthReturnPath(returnPath: unknown): AgentAuthReturnTarget | null {
  if (typeof returnPath !== "string" || returnPath.startsWith("//")) return null;
  const agent = /^\/agents\/(agent_[a-f0-9]{16})\/edit(?:\?.*)?$/.exec(returnPath);
  if (agent?.[1]) return { type: "agent", id: agent[1] };
  const chat = /^\/chats\/(chat_[a-f0-9]{16})(?:\?.*)?$/.exec(returnPath);
  if (chat?.[1]) return { type: "chat", id: chat[1] };
  return null;
}

export function safeAgentAuthReturnPath(returnPath: unknown): string {
  if (typeof returnPath === "string" && parseAgentAuthReturnPath(returnPath)) return returnPath;
  return "/agents";
}
