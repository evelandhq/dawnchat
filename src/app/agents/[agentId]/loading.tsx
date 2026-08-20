import { Spinner } from "@/components/ui/spinner";

export default function Loading(): React.ReactElement {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 px-6 py-12 sm:py-20">
      <div className="flex min-h-48 items-center justify-center">
        <Spinner />
      </div>
    </section>
  );
}
