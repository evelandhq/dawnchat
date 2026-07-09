import { AgentConnectionForm } from "@/components/agent-connection-form";

export default function NewAgentPage(): React.ReactElement {
  return (
    <section style={{ display: "grid", gap: "1rem" }}>
      <div>
        <h1>Connect an agent</h1>
        <p>Register and verify a remote Eve agent.</p>
      </div>
      <AgentConnectionForm />
    </section>
  );
}
