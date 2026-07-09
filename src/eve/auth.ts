import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

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

const AUTH_CONFIG_ENCRYPTION_PREFIX = "eve-auth:v1:";
const AUTH_CONFIG_KEY_CONTEXT = "eve-chats-agent-auth-config";

export function encryptAuthConfig(config: unknown): string {
  const plaintext = JSON.stringify(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getAuthConfigEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(AUTH_CONFIG_KEY_CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${AUTH_CONFIG_ENCRYPTION_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptAuthConfig(raw: string): string {
  if (!raw.startsWith(AUTH_CONFIG_ENCRYPTION_PREFIX)) {
    return raw;
  }

  const payload = raw.slice(AUTH_CONFIG_ENCRYPTION_PREFIX.length);
  const [ivText, tagText, ciphertextText] = payload.split(".");
  if (!ivText || !tagText || !ciphertextText) {
    throw new Error("Agent auth configuration is invalid");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", getAuthConfigEncryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(AUTH_CONFIG_KEY_CONTEXT));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Agent auth configuration is invalid");
  }
}

function getAuthConfigEncryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret === "replace-with-local-dev-secret" || secret === "replace-with-a-local-secret") {
    throw new Error("AUTH_SECRET is required to encrypt agent auth configuration");
  }

  return createHash("sha256").update(AUTH_CONFIG_KEY_CONTEXT).update("\0").update(secret).digest();
}

export function parseAuthConfig(connection: EveAgentConnectionLike): unknown {
  const raw = connection.authConfigEncrypted;
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(decryptAuthConfig(raw)) as unknown;
  } catch {
    if (connection.authType === "bearer" && !raw.startsWith(AUTH_CONFIG_ENCRYPTION_PREFIX)) {
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
