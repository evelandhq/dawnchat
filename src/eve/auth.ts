import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { AuthType } from "@/db/schema";

export interface EveAgentConnectionLike {
  readonly id: string;
  readonly baseUrl: string;
  readonly authType: AuthType;
  readonly authConfigEncrypted?: string | null;
  readonly securityRevision: number;
}

type AgentAuthConfigBinding = Pick<EveAgentConnectionLike, "id" | "authType" | "securityRevision">;

const AUTH_CONFIG_ENCRYPTION_PREFIX_V1 = "eve-auth:v1:";
const AUTH_CONFIG_ENCRYPTION_PREFIX_V2 = "eve-auth:v2:";
const AUTH_CONFIG_KEY_CONTEXT = "eve-chats-agent-auth-config";
const AUTH_STATE_ENCRYPTION_PREFIX = "eve-auth-state:v1:";

export function encryptAuthConfig(config: unknown, binding: AgentAuthConfigBinding): string {
  const plaintext = JSON.stringify(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getAuthConfigEncryptionKey(), iv);
  cipher.setAAD(authConfigAad(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${AUTH_CONFIG_ENCRYPTION_PREFIX_V2}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptAuthConfig(raw: string, binding: AgentAuthConfigBinding): string {
  const version = raw.startsWith(AUTH_CONFIG_ENCRYPTION_PREFIX_V2)
    ? "v2"
    : raw.startsWith(AUTH_CONFIG_ENCRYPTION_PREFIX_V1)
      ? "v1"
      : null;
  if (!version) {
    return raw;
  }

  const prefix = version === "v2" ? AUTH_CONFIG_ENCRYPTION_PREFIX_V2 : AUTH_CONFIG_ENCRYPTION_PREFIX_V1;
  const payload = raw.slice(prefix.length);
  const [ivText, tagText, ciphertextText] = payload.split(".");
  if (!ivText || !tagText || !ciphertextText) {
    throw new Error("Agent auth configuration is invalid");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", getAuthConfigEncryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAAD(version === "v2" ? authConfigAad(binding) : Buffer.from(AUTH_CONFIG_KEY_CONTEXT));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Agent auth configuration is invalid");
  }
}

function authConfigAad(binding: AgentAuthConfigBinding): Buffer {
  return Buffer.from(JSON.stringify([
    binding.id,
    binding.authType,
    binding.securityRevision,
  ]));
}

function getAuthConfigEncryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret === "replace-with-local-dev-secret" || secret === "replace-with-a-local-secret") {
    throw new Error("AUTH_SECRET is required to encrypt agent auth configuration");
  }

  return createHash("sha256").update(AUTH_CONFIG_KEY_CONTEXT).update("\0").update(secret).digest();
}

export function sealAgentAuthState(value: unknown, purpose: string, binding: readonly unknown[]): string {
  const iv = randomBytes(12);
  const context = `eve-chats-agent-auth-${purpose}`;
  const cipher = createCipheriv("aes-256-gcm", getDerivedEncryptionKey(context), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([purpose, ...binding])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${AUTH_STATE_ENCRYPTION_PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function openAgentAuthState<T>(
  raw: string,
  purpose: string,
  binding: readonly unknown[],
): T {
  if (!raw.startsWith(AUTH_STATE_ENCRYPTION_PREFIX)) throw new Error("Agent auth state is invalid");
  const [ivText, tagText, ciphertextText] = raw.slice(AUTH_STATE_ENCRYPTION_PREFIX.length).split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("Agent auth state is invalid");
  try {
    const context = `eve-chats-agent-auth-${purpose}`;
    const decipher = createDecipheriv("aes-256-gcm", getDerivedEncryptionKey(context), Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(JSON.stringify([purpose, ...binding])));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error("Agent auth state is invalid");
  }
}

function getDerivedEncryptionKey(context: string): Buffer {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret === "replace-with-local-dev-secret" || secret === "replace-with-a-local-secret") {
    throw new Error("AUTH_SECRET is required to encrypt agent auth configuration");
  }
  return createHash("sha256").update(context).update("\0").update(secret).digest();
}

export function parseAuthConfig(connection: EveAgentConnectionLike): unknown {
  const raw = connection.authConfigEncrypted;
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(decryptAuthConfig(raw, connection)) as unknown;
  } catch {
    if (
      connection.authType === "bearer"
      && !raw.startsWith(AUTH_CONFIG_ENCRYPTION_PREFIX_V1)
      && !raw.startsWith(AUTH_CONFIG_ENCRYPTION_PREFIX_V2)
    ) {
      return { bearerToken: raw };
    }

    throw new Error("Agent auth configuration is invalid");
  }
}
