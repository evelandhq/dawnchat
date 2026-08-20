import type { Metadata } from "next";

import { AgentEditor } from "@/components/agent-editor";

export const metadata: Metadata = {
  title: "Edit agent",
};

type EditAgentPageProps = {
  params: Promise<{ agentId: string }>;
};

export default async function EditAgentPage({ params }: EditAgentPageProps): Promise<React.ReactElement> {
  const { agentId } = await params;

  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <AgentEditor agentId={agentId} />
    </section>
  );
}
