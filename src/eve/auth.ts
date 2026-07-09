import type { ClientOptions } from "eve/client";

import type { AuthType } from "@/db/schema";

export interface EveAgentConnectionLike {
  readonly baseUrl: string;
  readonly authType: AuthType;
  readonly authConfigEncrypted?: string | null;
}

interface BearerAuthConfig {
  readonly bearerToken?: unknown;
  readonly token?: unknown;
}

interface HeaderAuthConfig {
  readonly headerName?: unknown;
  readonly headerValue?: unknown;
  readonly value?: unknown;
}

export function parseAuthConfig(connection: EveAgentConnectionLike): unknown {
  const raw = connection.authConfigEncrypted;
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (connection.authType === "bearer") {
      return { bearerToken: raw } satisfies BearerAuthConfig;
    }

    throw new Error("Agent auth configuration is invalid");
  }
}

export function buildEveClientAuthOptions(
  connection: EveAgentConnectionLike,
): Pick<ClientOptions, "auth" | "headers" | "redirect"> {
  if (connection.authType === "none") {
    return {};
  }

  const config = parseAuthConfig(connection);
  if (!config || typeof config !== "object") {
    throw new Error("Agent auth configuration is missing");
  }

  if (connection.authType === "bearer") {
    const { bearerToken, token } = config as BearerAuthConfig;
    const credential = bearerToken ?? token;
    if (typeof credential !== "string" || credential.length === 0) {
      throw new Error("Bearer auth configuration is missing a token");
    }
    const bearerCredential = credential;

    return { auth: { bearer: bearerCredential }, redirect: "manual" };
  }

  const { headerName, headerValue, value } = config as HeaderAuthConfig;
  const credential = headerValue ?? value;
  if (typeof headerName !== "string" || headerName.length === 0 || typeof credential !== "string" || credential.length === 0) {
    throw new Error("Header auth configuration is missing a header name or value");
  }
  const customHeaderName = headerName;
  const customHeaderCredential = credential;

  return { headers: { [customHeaderName]: customHeaderCredential }, redirect: "manual" };
}
