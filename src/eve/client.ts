import { Client } from "eve/client";

import { buildEveClientAuthOptions, type EveAgentConnectionLike } from "@/eve/auth";

export type { EveAgentConnectionLike } from "@/eve/auth";

export interface EveHealthCheckResult {
  readonly status: "healthy" | "unreachable";
  readonly info?: unknown;
  readonly error?: string;
}

export function createEveClientForConnection(
  connection: EveAgentConnectionLike,
  callerToken?: string,
): Client {
  return new Client({
    host: connection.baseUrl,
    preserveCompletedSessions: true,
    ...buildEveClientAuthOptions(connection, callerToken),
  });
}

export async function checkEveAgent(connection: EveAgentConnectionLike): Promise<EveHealthCheckResult> {
  try {
    const client = createEveClientForConnection(connection);
    const health = await client.health();
    const info = await fetchAgentInfo(client, health);

    return { status: "healthy", info };
  } catch (error) {
    return { status: "unreachable", error: error instanceof Error ? error.message : "Unknown Eve health check error" };
  }
}

async function fetchAgentInfo(client: Client, health: unknown): Promise<unknown> {
  const response = await client.fetch("/eve/v1/info");
  if (!response.ok) {
    return health;
  }

  try {
    return await response.json();
  } catch {
    return health;
  }
}
