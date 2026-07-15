import type { AgentAuthFailure } from "@/agent-auth/contracts";
import {
  getAgentAuthModule,
  requestAnonymousAgent,
} from "@/agent-auth/runtime.server";
import type { EveAgentConnectionLike } from "@/eve/auth";

export interface EveInspectableAgentConnection extends EveAgentConnectionLike {
  readonly id: string;
}

export type EveHealthCheckResult =
  | {
      readonly status: "healthy";
      readonly info?: unknown;
      readonly authFailure?: AgentAuthFailure;
      readonly error?: string;
    }
  | {
      readonly status: "unreachable";
      readonly error: string;
      readonly info?: never;
      readonly authFailure?: never;
    };

export async function checkEveAgent(
  connection: EveInspectableAgentConnection,
): Promise<EveHealthCheckResult> {
  let health: unknown;
  try {
    const healthResponse = await requestAnonymousAgent(connection.baseUrl, {
      pathname: "/eve/v1/health",
    });
    if (!healthResponse.ok) {
      await healthResponse.body?.cancel().catch(() => undefined);
      throw new Error(`Eve health check failed with status ${healthResponse.status}`);
    }
    health = await healthResponse.json();
  } catch {
    return {
      status: "unreachable",
      error: "Eve health check failed",
    };
  }

  try {
    const infoResult = await getAgentAuthModule().request(
      { agentConnectionId: connection.id, principalId: "" },
      { pathname: "/eve/v1/info" },
    );
    if (!(infoResult instanceof Response)) {
      return { status: "healthy", authFailure: infoResult };
    }
    if (!infoResult.ok) {
      await infoResult.body?.cancel().catch(() => undefined);
      return { status: "healthy", info: health };
    }

    try {
      return { status: "healthy", info: await infoResult.json() };
    } catch {
      return { status: "healthy", info: health };
    }
  } catch {
    return {
      status: "healthy",
      error: "Unable to inspect Eve agent authentication readiness",
    };
  }
}
