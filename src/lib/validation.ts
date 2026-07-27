import { z } from "zod";

export const authTypeSchema = z.enum(["none", "bearer", "header"]);
export const agentAuthSchema = authTypeSchema;

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
const httpHeaderNameSchema = z
  .string()
  .trim()
  .optional()
  .refine((value) => value === undefined || /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value), {
    message: "Header name must be a valid HTTP header name",
  });

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

const evelandProjectIdSchema = z.string().trim().min(1).nullable().optional();

export const createAgentConnectionSchema = z
  .object({
    name: nonEmptyTrimmedString,
    baseUrl: agentBaseUrlSchema,
    authType: authTypeSchema.default("none"),
    evelandProjectId: evelandProjectIdSchema,
    bearerToken: z.string().optional(),
    headerName: httpHeaderNameSchema,
    headerValue: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.evelandProjectId && value.authType !== "none") {
      ctx.addIssue({
        code: "custom",
        path: ["authType"],
        message: "Eveland project identity cannot be combined with legacy agent auth",
      });
    }
    if (value.authType === "bearer" && !value.bearerToken?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["bearerToken"],
        message: "Bearer token is required for bearer auth",
      });
    }

    if (value.authType === "header") {
      if (!value.headerName?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["headerName"],
          message: "Header name is required for header auth",
        });
      }

      if (!value.headerValue?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["headerValue"],
          message: "Header value is required for header auth",
        });
      }
    }
  });

export const updateAgentConnectionSchema = z
  .object({
    name: nonEmptyTrimmedString,
    baseUrl: agentBaseUrlSchema,
    authType: authTypeSchema,
    evelandProjectId: evelandProjectIdSchema,
    bearerToken: z.string().optional(),
    headerName: httpHeaderNameSchema,
    headerValue: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.evelandProjectId && value.authType !== "none") {
      ctx.addIssue({
        code: "custom",
        path: ["authType"],
        message: "Eveland project identity cannot be combined with legacy agent auth",
      });
    }
    if (value.authType === "header" && !value.headerName?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["headerName"],
        message: "Header name is required for header auth",
      });
    }
  });

export const discoverAgentsSchema = z.object({
  gatewayUrl: agentBaseUrlSchema,
});

export const createChatSchema = z.object({
  agentId: nonEmptyTrimmedString,
  message: nonEmptyTrimmedString,
});
