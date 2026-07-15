import type { ZodType } from "zod";

export type CredentialScope = "connection" | "principal";

export interface AgentAuthTarget {
  readonly agentConnectionId: string;
  readonly principalId: string;
}

export type CredentialSnapshot =
  | { readonly kind: "none" }
  | { readonly kind: "basic"; readonly username: string; readonly password: string }
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "headers"; readonly headers: Readonly<Record<string, string>> };

export interface CredentialVersion {
  readonly securityRevision: number;
  readonly rotationSeq: number | null;
}

export type AgentAuthFailureCode =
  | "interaction_required"
  | "credential_rejected"
  | "forbidden"
  | "configuration_invalid"
  | "provider_unavailable"
  | "upstream_unavailable"
  | "retry_required";

export interface ProviderFailure {
  readonly code: AgentAuthFailureCode;
  readonly message: string;
}

export type CredentialResult =
  | {
      readonly ok: true;
      readonly credential: CredentialSnapshot;
      readonly version: CredentialVersion;
    }
  | { readonly ok: false; readonly failure: ProviderFailure };

export type CredentialInspectResult =
  | { readonly state: "not_required" }
  | { readonly state: "ok" | "recoverable" }
  | { readonly state: "interaction_required" }
  | { readonly state: "misconfigured"; readonly message: string };

export type RecoveryDecision =
  | { readonly action: "retry" }
  | { readonly action: "give_up"; readonly failure: ProviderFailure };

export type FinalUnauthorizedDecision = {
  readonly action: "give_up";
  readonly failure: ProviderFailure;
};

/**
 * Module-owned provider input. `config` has already been decrypted and validated
 * by the catalog schema; providers still fail closed when called directly with a
 * malformed value. The target and resolved scope fields are stable identifiers.
 */
export interface ProviderContext<TConfig = unknown> {
  readonly target: AgentAuthTarget;
  readonly config: TConfig;
  readonly securityRevision: number;
  readonly credentialScope: CredentialScope;
  readonly scopeSubject: string;
}

export interface CredentialProvider<TConfig = unknown> {
  readonly method: string;
  getCredential(ctx: ProviderContext<TConfig>): Promise<CredentialResult>;
  inspect(ctx: ProviderContext<TConfig>): Promise<CredentialInspectResult>;
  recoverUnauthorized(
    ctx: ProviderContext<TConfig>,
    evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 0 },
  ): Promise<RecoveryDecision>;
  recoverUnauthorized(
    ctx: ProviderContext<TConfig>,
    evidence: { readonly rejectedVersion: CredentialVersion; readonly attempt: 1 },
  ): Promise<FinalUnauthorizedDecision>;
}

export interface AuthMethodRegistration<TConfig = unknown> {
  readonly method: string;
  readonly credentialScope: CredentialScope;
  readonly configSchema: ZodType<TConfig>;
  readonly interaction?: { readonly authorizePath: string };
  readonly provider: CredentialProvider<TConfig>;
}

export type FieldDescriptor =
  | {
      readonly name: string;
      readonly label: string;
      readonly type: "text" | "secret";
      readonly required: boolean;
      readonly placeholder?: string;
      readonly autocomplete?: string;
    }
  | {
      readonly name: string;
      readonly label: string;
      readonly type: "key-value";
      readonly required: boolean;
      readonly keyLabel: string;
      readonly valueLabel: string;
    };

export interface AuthMethodFormDescriptor {
  readonly method: string;
  readonly label: string;
  readonly interactive: boolean;
  readonly fields: readonly FieldDescriptor[];
}

export interface AuthMethodCatalogEntry {
  readonly key: string;
  readonly registration: AuthMethodRegistration;
  readonly descriptor: AuthMethodFormDescriptor;
}
