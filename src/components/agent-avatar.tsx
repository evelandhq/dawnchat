import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar";
import { agentColorClass, agentInitial } from "@/lib/agent-visuals";
import { cn } from "@/lib/utils";

type AgentAvatarProps = {
  agentId: string;
  name: string;
  size?: "sm" | "default" | "lg";
  showUnreachableDot?: boolean;
  className?: string;
  fallbackClassName?: string;
};

export function AgentAvatar({
  agentId,
  name,
  size = "default",
  showUnreachableDot = false,
  className,
  fallbackClassName,
}: AgentAvatarProps): React.ReactElement {
  return (
    <Avatar size={size} className={className}>
      <AvatarFallback className={cn("font-medium text-white", agentColorClass(agentId), fallbackClassName)}>
        {agentInitial(name)}
      </AvatarFallback>
      {showUnreachableDot ? (
        <AvatarBadge className="bg-destructive">
          <span className="sr-only">unreachable</span>
        </AvatarBadge>
      ) : null}
    </Avatar>
  );
}
