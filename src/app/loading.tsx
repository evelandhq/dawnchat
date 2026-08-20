import { Spinner } from "@/components/ui/spinner";

export default function Loading(): React.ReactElement {
  return (
    <div className="flex min-h-48 items-center justify-center">
      <Spinner />
    </div>
  );
}
