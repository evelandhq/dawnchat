import Link from "next/link";

export type AgentListItem = {
  id: string;
  name: string;
  baseUrl: string;
  authType: "none" | "bearer" | "header";
  hasAuth: boolean;
  status: "unknown" | "healthy" | "unreachable";
  lastCheckedAt: string | null;
};

type AgentListProps = {
  agents: AgentListItem[];
};

function authLabel(authType: AgentListItem["authType"]): string {
  if (authType === "bearer") {
    return "Bearer Token";
  }
  if (authType === "header") {
    return "Custom Header";
  }
  return "None";
}

export function AgentList({ agents }: AgentListProps): React.ReactElement {
  return (
    <section style={{ display: "grid", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
        <div>
          <h1>Agents</h1>
          <p>Register Eve agents that chats can connect to.</p>
        </div>
        <Link href="/agents/new">Connect an agent</Link>
      </div>

      {agents.length === 0 ? (
        <p>No agents connected yet.</p>
      ) : (
        <ul style={{ display: "grid", gap: "0.75rem", listStyle: "none", padding: 0 }}>
          {agents.map((agent) => (
            <li key={agent.id} style={{ border: "1px solid #d1d5db", borderRadius: "0.5rem", padding: "1rem" }}>
              <h2>{agent.name}</h2>
              <p>{agent.baseUrl}</p>
              <dl style={{ display: "grid", gap: "0.25rem" }}>
                <div>
                  <dt>Status</dt>
                  <dd>{agent.status}</dd>
                </div>
                <div>
                  <dt>Auth Type</dt>
                  <dd>{authLabel(agent.authType)}</dd>
                </div>
                <div>
                  <dt>Auth</dt>
                  <dd>{agent.hasAuth ? "Auth configured" : "No auth configured"}</dd>
                </div>
                <div>
                  <dt>Last checked</dt>
                  <dd>{agent.lastCheckedAt ?? "Never"}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
