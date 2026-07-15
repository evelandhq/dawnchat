import { z, type ZodType } from "zod";

import type {
  AuthMethodRegistration,
  CredentialInspectResult,
  CredentialProvider,
  CredentialResult,
  CredentialSnapshot,
  CredentialVersion,
  FinalUnauthorizedDecision,
  ProviderContext,
  ProviderFailure,
  RecoveryDecision,
} from "@/agent-auth/contracts";

export type NoneAuthConfig = Record<string, never>;
export interface BasicAuthConfig {
  readonly username: string;
  readonly password: string;
}
export interface BearerAuthConfig {
  readonly token: string;
}
export interface HeadersAuthConfig {
  readonly headers: Readonly<Record<string, string>>;
}

const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const noneAuthConfigSchema: ZodType<NoneAuthConfig> = z.object({}).strict();
export const basicAuthConfigSchema: ZodType<BasicAuthConfig> = z
  .object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
  })
  .strict();
export const bearerAuthConfigSchema: ZodType<BearerAuthConfig> = z
  .object({ token: z.string().trim().min(1) })
  .strict();
export const headersAuthConfigSchema: ZodType<HeadersAuthConfig> = z
  .object({
    headers: z.record(z.string(), z.string()).superRefine((headers, issueContext) => {
      if (Object.keys(headers).length === 0) {
        issueContext.addIssue({
          code: "custom",
          message: "At least one header is required",
        });
      }
      for (const [name, value] of Object.entries(headers)) {
        if (!HTTP_FIELD_NAME.test(name)) {
          issueContext.addIssue({
            code: "custom",
            message: "Invalid HTTP field name",
            path: [name],
          });
        }
        if (/[\r\n]/.test(value)) {
          issueContext.addIssue({
            code: "custom",
            message: "Header values must not contain CR or LF",
            path: [name],
          });
        }
      }
    }),
  })
  .strict();

interface StaticProviderOptions<TConfig> {
  readonly method: string;
  readonly schema: ZodType<TConfig>;
  readonly credential: (config: TConfig) => CredentialSnapshot;
  readonly inspectState: "not_required" | "ok";
  readonly rejectedMessage: string;
}

class StaticCredentialProvider<TConfig> implements CredentialProvider {
  readonly method: string;
  readonly #schema: ZodType<TConfig>;
  readonly #credential: (config: TConfig) => CredentialSnapshot;
  readonly #inspectState: "not_required" | "ok";
  readonly #configurationFailure: ProviderFailure;
  readonly #rejectionFailure: ProviderFailure;

  constructor(options: StaticProviderOptions<TConfig>) {
    this.method = options.method;
    this.#schema = options.schema;
    this.#credential = options.credential;
    this.#inspectState = options.inspectState;
    this.#configurationFailure = Object.freeze({
      code: "configuration_invalid",
      message: `Invalid configuration for ${options.method} authentication`,
    });
    this.#rejectionFailure = Object.freeze({
      code: "credential_rejected",
      message: options.rejectedMessage,
    });
    Object.freeze(this);
  }

  async getCredential(ctx: ProviderContext): Promise<CredentialResult> {
    const parsed = this.#parseConfig(ctx.config);
    if (parsed === undefined) {
      return { ok: false, failure: this.#configurationFailure };
    }

    return {
      ok: true,
      credential: this.#credential(parsed),
      version: staticCredentialVersion(ctx.securityRevision),
    };
  }

  async inspect(ctx: ProviderContext): Promise<CredentialInspectResult> {
    if (this.#parseConfig(ctx.config) === undefined) {
      return { state: "misconfigured", message: this.#configurationFailure.message };
    }
    return { state: this.#inspectState };
  }

  async recoverUnauthorized(
    ctx: ProviderContext,
    evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 0 },
  ): Promise<RecoveryDecision>;
  async recoverUnauthorized(
    ctx: ProviderContext,
    evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 1 },
  ): Promise<FinalUnauthorizedDecision>;
  async recoverUnauthorized(
    ctx: ProviderContext,
    _evidence: {
      readonly rejectedVersion: CredentialVersion;
      readonly attempt: 0 | 1;
    },
  ): Promise<FinalUnauthorizedDecision> {
    if (this.#parseConfig(ctx.config) === undefined) {
      return { action: "give_up", failure: this.#configurationFailure };
    }
    return { action: "give_up", failure: this.#rejectionFailure };
  }

  #parseConfig(config: unknown): TConfig | undefined {
    try {
      const parsed = this.#schema.safeParse(config);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}

function createStaticProvider<TConfig>(
  options: StaticProviderOptions<TConfig>,
): CredentialProvider {
  return new StaticCredentialProvider(options);
}

export const noneAuthMethodRegistration: AuthMethodRegistration = Object.freeze({
  method: "none",
  credentialScope: "connection",
  configSchema: noneAuthConfigSchema,
  provider: createStaticProvider({
    method: "none",
    schema: noneAuthConfigSchema,
    credential: () => ({ kind: "none" }),
    inspectState: "not_required",
    rejectedMessage: "The Agent rejected an unauthenticated request",
  }),
});

export const basicAuthMethodRegistration: AuthMethodRegistration = Object.freeze({
  method: "basic",
  credentialScope: "connection",
  configSchema: basicAuthConfigSchema,
  provider: createStaticProvider({
    method: "basic",
    schema: basicAuthConfigSchema,
    credential: ({ username, password }) => ({ kind: "basic", username, password }),
    inspectState: "ok",
    rejectedMessage: "The Agent rejected the configured Basic credentials",
  }),
});

export const bearerAuthMethodRegistration: AuthMethodRegistration = Object.freeze({
  method: "bearer",
  credentialScope: "connection",
  configSchema: bearerAuthConfigSchema,
  provider: createStaticProvider({
    method: "bearer",
    schema: bearerAuthConfigSchema,
    credential: ({ token }) => ({ kind: "bearer", token }),
    inspectState: "ok",
    rejectedMessage: "The Agent rejected the configured Bearer token",
  }),
});

export const headersAuthMethodRegistration: AuthMethodRegistration = Object.freeze({
  method: "headers",
  credentialScope: "connection",
  configSchema: headersAuthConfigSchema,
  provider: createStaticProvider({
    method: "headers",
    schema: headersAuthConfigSchema,
    credential: ({ headers }) => ({
      kind: "headers",
      headers: Object.freeze({ ...headers }),
    }),
    inspectState: "ok",
    rejectedMessage: "The Agent rejected the configured headers",
  }),
});

function staticCredentialVersion(securityRevision: number): CredentialVersion {
  return { securityRevision, rotationSeq: null };
}
