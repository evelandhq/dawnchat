import { Spinner } from "@/components/ui/spinner";

// Matches the thread's own loading state, so the server gap and the client
// load read as one wait instead of two.
export default function Loading(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      Loading conversation…
    </div>
  );
}
