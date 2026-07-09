import { Client, type SessionState } from "eve/client";

import { buildEveClientAuthOptions, type EveAgentConnectionLike } from "@/eve/auth";
import { normalizeEveTurnEvent, type EveTurnUpdate } from "@/eve/events";

export type { EveAgentConnectionLike } from "@/eve/auth";
export type { EveTurnUpdate } from "@/eve/events";
export type { SessionState } from "eve/client";

export interface EveHealthCheckResult {
  readonly status: "healthy" | "unreachable";
  readonly info?: unknown;
  readonly error?: string;
}

export function createEveClientForConnection(connection: EveAgentConnectionLike): Client {
  return new Client({
    host: connection.baseUrl,
    preserveCompletedSessions: true,
    ...buildEveClientAuthOptions(connection),
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

export async function* sendEveTurn(
  connection: EveAgentConnectionLike,
  sessionState: SessionState | null | undefined,
  message: string,
): AsyncIterable<EveTurnUpdate> {
  const client = createEveClientForConnection(connection);
  const session = client.session(sessionState ?? undefined);
  const response = await session.send(message);
  const isContinuingSameSession = sessionState?.sessionId === response.sessionId;
  let streamIndex = isContinuingSameSession ? sessionState.streamIndex : 0;
  let latestState: SessionState = {
    sessionId: response.sessionId,
    continuationToken: response.continuationToken ?? (isContinuingSameSession ? sessionState.continuationToken : undefined),
    streamIndex,
  };

  for await (const event of response) {
    streamIndex += 1;
    latestState = {
      sessionId: response.sessionId,
      continuationToken: response.continuationToken ?? (isContinuingSameSession ? sessionState.continuationToken : undefined),
      streamIndex,
    };

    yield normalizeEveTurnEvent(event, latestState);
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
