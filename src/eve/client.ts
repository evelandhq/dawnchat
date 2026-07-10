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

// Some agents (eve 0.18.x) keep the NDJSON stream open after the turn settles,
// so waiting for the iterable to end stalls until the connection times out
// (~5 minutes). A terminal session event is the reliable end-of-turn signal.
const terminalUpdateTypes = new Set<EveTurnUpdate["type"]>(["session.waiting", "session.completed", "session.failed"]);

export async function* sendEveTurn(
  connection: EveAgentConnectionLike,
  sessionState: SessionState | null | undefined,
  message: string,
): AsyncIterable<EveTurnUpdate> {
  const client = createEveClientForConnection(connection);
  const session = client.session(sessionState ?? undefined);
  const abort = new AbortController();
  const response = await session.send({ message, signal: abort.signal });
  const isContinuingSameSession = sessionState?.sessionId === response.sessionId;
  let streamIndex = isContinuingSameSession ? sessionState.streamIndex : 0;
  let latestState: SessionState = {
    sessionId: response.sessionId,
    continuationToken: response.continuationToken ?? (isContinuingSameSession ? sessionState.continuationToken : undefined),
    streamIndex,
  };

  try {
    for await (const event of response) {
      streamIndex += 1;
      latestState = {
        sessionId: response.sessionId,
        continuationToken: response.continuationToken ?? (isContinuingSameSession ? sessionState.continuationToken : undefined),
        streamIndex,
      };

      const update = normalizeEveTurnEvent(event, latestState);
      yield update;

      if (terminalUpdateTypes.has(update.type)) {
        // Aborting tears the connection down immediately; the iterator's own
        // return() would instead wait for the held-open stream to end.
        abort.abort();
        return;
      }
    }
  } catch (error) {
    if (abort.signal.aborted) {
      return;
    }
    throw error;
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
