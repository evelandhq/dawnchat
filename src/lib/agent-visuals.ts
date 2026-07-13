export const AGENT_AVATAR_COLOR_CLASSES = [
  "bg-blue-600",
  "bg-emerald-600",
  "bg-violet-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-cyan-600",
  "bg-indigo-600",
  "bg-teal-600",
] as const;

export function agentInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

export function agentColorClass(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  }
  return AGENT_AVATAR_COLOR_CLASSES[Math.abs(hash) % AGENT_AVATAR_COLOR_CLASSES.length];
}
