import type { Metadata } from "next";

import { AgentCatalog } from "@/components/agent-catalog";

export const metadata: Metadata = {
  title: "Agents",
};

export default function AgentsPage(): React.ReactElement {
  return <AgentCatalog />;
}
