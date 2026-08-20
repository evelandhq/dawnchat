import type { Metadata } from "next";

import { AgentEntry } from "@/components/agent-entry";

export const metadata: Metadata = {
  title: "New Chat",
};

type AgentNewChatPageProps = {
  params: Promise<{ agentId: string }>;
};

export default async function AgentNewChatPage({ params }: AgentNewChatPageProps): Promise<React.ReactElement> {
  const { agentId } = await params;

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 px-6 py-12 sm:py-20">
      <AgentEntry agentId={agentId} />
    </section>
  );
}
