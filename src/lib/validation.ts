import { z } from "zod";

import { agentAuthMethods } from "@/eve/auth-methods";

export const authTypeSchema = z.enum(agentAuthMethods);
export const agentAuthSchema = authTypeSchema;
const legacyAuthTypeSchema = z.enum([...agentAuthMethods, "header"]);

export function normalizeAgentBaseUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Agent URL must be a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent URL must use http or https");
  }

  if (url.username || url.password) {
    throw new Error("Agent URL must not include credentials");
  }

  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/+$/, "");
}

const nonEmptyTrimmedString = z.string().trim().min(1);
const agentBaseUrlSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeAgentBaseUrl(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Agent URL is invalid",
    });

    return z.NEVER;
  }
});

const agentConnectionInputSchema = z.object({
  name: nonEmptyTrimmedString,
  baseUrl: agentBaseUrlSchema,
  authType: legacyAuthTypeSchema.default("none"),
  config: z.unknown().optional(),
  bearerToken: z.string().optional(),
  headerName: z.string().trim().optional(),
  headerValue: z.string().optional(),
}).transform((value) => {
  const authType = value.authType === "header" ? "headers" as const : value.authType;
  let config = value.config;
  if (config === undefined && authType === "bearer" && value.bearerToken !== undefined) {
    config = value.bearerToken ? { token: value.bearerToken } : {};
  }
  if (config === undefined && authType === "headers") {
    config = value.headerName && value.headerValue
      ? { headers: { [value.headerName]: value.headerValue } }
      : {};
  }
  return { name: value.name, baseUrl: value.baseUrl, authType, config: config ?? {} };
});

export const createAgentConnectionSchema = agentConnectionInputSchema;
export const updateAgentConnectionSchema = agentConnectionInputSchema;

export const agentAuthCallbackSchema = z.object({
  search: z.string().min(1).max(8_192).refine(
    (value) => value.startsWith("?"),
    "OIDC callback search must start with ?.",
  ),
});

export const discoverAgentsSchema = z.object({
  gatewayUrl: agentBaseUrlSchema,
});

export const createChatSchema = z.object({
  agentId: nonEmptyTrimmedString,
  message: nonEmptyTrimmedString,
});
