import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusValue = "unknown" | "healthy" | "unreachable" | "active" | "completed" | "failed";

const statusClasses: Record<StatusValue, string> = {
  healthy: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400",
  active: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400",
  completed: "bg-sky-500/15 text-sky-700 dark:bg-sky-500/20 dark:text-sky-400",
  unknown: "",
  unreachable: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  failed: "bg-destructive/10 text-destructive dark:bg-destructive/20",
};

export function StatusBadge({ status }: { status: StatusValue }): React.ReactElement {
  return (
    <Badge variant="secondary" className={cn(statusClasses[status])}>
      <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden />
      {status}
    </Badge>
  );
}
