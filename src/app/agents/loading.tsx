import { Spinner } from "@/components/ui/spinner";

export default function Loading(): React.ReactElement {
  return (
    <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      Loading your Agents…
    </div>
  );
}
