export const agentAuthMethods = [
  "local-dev",
  "none",
  "basic",
  "bearer",
  "vercel-oidc",
  "oidc",
  "headers",
] as const;

export type AgentAuthMethod = (typeof agentAuthMethods)[number];

export type AgentAuthMethodFieldDescriptor = {
  key: string;
  label: string;
  input: "text" | "password" | "textarea" | "select";
  required: boolean;
  secret: boolean;
  valueType: "string" | "string-list" | "json-record";
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
};

export type AgentAuthMethodDescriptor = {
  method: AgentAuthMethod;
  label: string;
  description: string;
  credentialScope: "connection" | "principal";
  interactive: boolean;
  fields: AgentAuthMethodFieldDescriptor[];
};

export type OidcAuthorizationCodeConfig = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  audience?: string;
  audienceMode?: "resource" | "audience" | "both";
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  authorizationParams?: Record<string, string>;
  accessTokenVerification: "eve-jwt" | "userinfo";
};

export const agentAuthMethodDescriptors: AgentAuthMethodDescriptor[] = [
  {
    method: "local-dev",
    label: "Local development",
    description: "Use Eve's loopback-only local development identity without a credential.",
    credentialScope: "connection",
    interactive: false,
    fields: [],
  },
  {
    method: "none",
    label: "No authentication",
    description: "Call the canonical Agent route without a credential.",
    credentialScope: "connection",
    interactive: false,
    fields: [],
  },
  {
    method: "basic",
    label: "HTTP Basic",
    description: "Send a configured username and password using HTTP Basic authentication.",
    credentialScope: "connection",
    interactive: false,
    fields: [
      { key: "username", label: "Username", input: "text", required: true, secret: false, valueType: "string" },
      { key: "password", label: "Password", input: "password", required: true, secret: true, valueType: "string" },
    ],
  },
  {
    method: "bearer",
    label: "Bearer token",
    description: "Send an externally issued JWT or opaque access token as a Bearer credential.",
    credentialScope: "connection",
    interactive: false,
    fields: [
      { key: "token", label: "Token", input: "password", required: true, secret: true, valueType: "string" },
    ],
  },
  {
    method: "vercel-oidc",
    label: "Vercel OIDC",
    description: "Send a Vercel-issued OIDC token using Eve 0.25.1's trusted deployment and Agent headers.",
    credentialScope: "connection",
    interactive: false,
    fields: [
      { key: "token", label: "Vercel OIDC token", input: "password", required: true, secret: true, valueType: "string" },
    ],
  },
  {
    method: "oidc",
    label: "OIDC Authorization Code",
    description: "Let each Playground caller authorize with the Agent's OIDC provider using Authorization Code and PKCE.",
    credentialScope: "principal",
    interactive: true,
    fields: [
      { key: "issuer", label: "Issuer", input: "text", required: true, secret: false, valueType: "string" },
      { key: "clientId", label: "Client ID", input: "text", required: true, secret: false, valueType: "string" },
      { key: "clientSecret", label: "Client secret", input: "password", required: false, secret: true, valueType: "string" },
      { key: "scopes", label: "Scopes", input: "text", required: true, secret: false, valueType: "string-list", defaultValue: "openid offline_access" },
      { key: "audience", label: "Audience", input: "text", required: false, secret: false, valueType: "string" },
      {
        key: "audienceMode",
        label: "Audience parameter mode",
        input: "select",
        required: false,
        secret: false,
        valueType: "string",
        options: [
          { value: "resource", label: "Resource indicator" },
          { value: "audience", label: "Audience parameter" },
          { value: "both", label: "Both parameters" },
        ],
      },
      {
        key: "tokenEndpointAuthMethod",
        label: "Token endpoint auth method",
        input: "select",
        required: true,
        secret: false,
        valueType: "string",
        defaultValue: "none",
        options: [
          { value: "client_secret_basic", label: "Client secret basic" },
          { value: "client_secret_post", label: "Client secret post" },
          { value: "none", label: "None (public client)" },
        ],
      },
      {
        key: "authorizationParams",
        label: "Additional authorization parameters (JSON)",
        input: "textarea",
        required: false,
        secret: false,
        valueType: "json-record",
      },
      {
        key: "accessTokenVerification",
        label: "Access token verification",
        input: "select",
        required: true,
        secret: false,
        valueType: "string",
        defaultValue: "userinfo",
        options: [
          { value: "eve-jwt", label: "Eve OIDC JWT verification" },
          { value: "userinfo", label: "OIDC UserInfo" },
        ],
      },
    ],
  },
  {
    method: "headers",
    label: "Custom headers",
    description: "Send configured credential headers for a custom Eve route AuthFn.",
    credentialScope: "connection",
    interactive: false,
    fields: [
      { key: "headers", label: "Headers (JSON)", input: "textarea", required: true, secret: true, valueType: "json-record" },
    ],
  },
];

const descriptorsByMethod = new Map(agentAuthMethodDescriptors.map((descriptor) => [descriptor.method, descriptor]));

const reservedCredentialHeaders = new Set([
  "connection",
  "content-length",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const reservedOidcAuthorizationParameters = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "audience",
  "nonce",
  "redirect_uri",
  "response_type",
  "resource",
  "scope",
  "state",
]);

export function getAgentAuthMethodDescriptor(method: AgentAuthMethod): AgentAuthMethodDescriptor {
  const descriptor = descriptorsByMethod.get(method);
  if (!descriptor) throw new Error(`Unsupported Agent Auth Method: ${method}.`);
  return descriptor;
}

export function agentAuthMethodStoresConfig(method: AgentAuthMethod): boolean {
  return getAgentAuthMethodDescriptor(method).fields.length > 0;
}

export function validateAgentAuthTarget(method: AgentAuthMethod, baseUrl: string): void {
  if (method !== "local-dev") return;
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  const loopback = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "[::1]"
    || /^127\./.test(hostname);
  if (!loopback) throw new Error("Local development requires a loopback Agent URL");
}

export function normalizeAgentAuthConfig(
  method: AgentAuthMethod,
  input: unknown,
  existing?: unknown,
): Record<string, unknown> {
  const next = record(input, `${getAgentAuthMethodDescriptor(method).label} configuration must be an object.`);
  const previous = optionalRecord(existing);

  if (method === "local-dev" || method === "none") return {};

  if (method === "basic") {
    const username = requiredString(next.username ?? previous?.username, "Basic username is required.");
    if (username.includes(":")) throw new Error("Basic username must not contain a colon.");
    const password = requiredString(next.password ?? previous?.password, "Basic password is required.");
    return { username, password };
  }

  if (method === "bearer" || method === "vercel-oidc") {
    const legacyToken = method === "bearer" ? previous?.bearerToken : undefined;
    const token = requiredString(next.token ?? previous?.token ?? legacyToken, method === "bearer"
      ? "Bearer token is required."
      : "Vercel OIDC token is required.");
    return { token };
  }

  if (method === "headers") {
    const legacyHeaders = legacyCustomHeaders(previous);
    const configured = record(next.headers ?? previous?.headers ?? legacyHeaders, "Custom credential headers must be an object.");
    return { headers: normalizeCredentialHeaders(configured) };
  }

  return normalizeOidcConfig(next, previous);
}

export function redactAgentAuthConfig(
  method: AgentAuthMethod,
  config: unknown,
): Record<string, unknown> {
  const value = optionalRecord(config);
  if (method === "local-dev" || method === "none") return {};
  if (method === "basic") {
    return {
      username: typeof value?.username === "string" ? value.username : "",
      passwordConfigured: typeof value?.password === "string" && value.password.length > 0,
    };
  }
  if (method === "bearer" || method === "vercel-oidc") {
    return {
      tokenConfigured:
        (typeof value?.token === "string" && value.token.length > 0)
        || (method === "bearer" && typeof value?.bearerToken === "string" && value.bearerToken.length > 0),
    };
  }
  if (method === "headers") {
    const headers = optionalRecord(value?.headers) ?? legacyCustomHeaders(value);
    return { headerNames: Object.keys(headers ?? {}).map((name) => name.toLowerCase()).sort() };
  }
  return {
    issuer: value?.issuer,
    clientId: value?.clientId,
    clientSecretConfigured: typeof value?.clientSecret === "string" && value.clientSecret.length > 0,
    scopes: value?.scopes,
    ...(value?.audience === undefined ? {} : { audience: value.audience, audienceMode: value.audienceMode }),
    tokenEndpointAuthMethod: value?.tokenEndpointAuthMethod,
    authorizationParams: value?.authorizationParams,
    accessTokenVerification: value?.accessTokenVerification,
  };
}

export function agentAuthConfigsEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeCredentialHeaders(configured: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(configured);
  if (entries.length > 32) throw new Error("Custom credential headers must contain at most 32 entries.");
  const seen = new Set<string>();
  const normalized: Array<readonly [string, string]> = [];
  for (const [name, value] of entries) {
    const normalizedName = name.toLowerCase();
    if (
      name.length > 256
      || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || reservedCredentialHeaders.has(normalizedName)
      || normalizedName.startsWith("proxy-")
      || normalizedName.startsWith("x-forwarded-")
      || normalizedName.startsWith("x-eveland-")
    ) throw new Error(`Agent credential header ${normalizedName} is not allowed.`);
    if (seen.has(normalizedName)) throw new Error(`Duplicate Agent credential header ${normalizedName}.`);
    if (typeof value !== "string" || value.length > 16_384 || /[\u0000-\u0008\u000A-\u001F\u007F]/.test(value)) {
      throw new Error(`Agent credential header ${normalizedName} is not allowed.`);
    }
    seen.add(normalizedName);
    normalized.push([normalizedName, value]);
  }
  return Object.fromEntries(normalized.sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeOidcConfig(
  next: Record<string, unknown>,
  previous: Record<string, unknown> | null,
): OidcAuthorizationCodeConfig {
  const issuer = normalizeHttpsIssuer(requiredString(next.issuer ?? previous?.issuer, "OIDC issuer is required."));
  const clientId = requiredString(next.clientId ?? previous?.clientId, "OIDC client ID is required.").trim();
  if (!clientId) throw new Error("OIDC client ID is required.");
  const tokenEndpointAuthMethod = oneOf(
    next.tokenEndpointAuthMethod ?? previous?.tokenEndpointAuthMethod ?? "none",
    ["client_secret_basic", "client_secret_post", "none"] as const,
    "Unsupported OIDC token endpoint auth method.",
  );
  const accessTokenVerification = oneOf(
    next.accessTokenVerification ?? previous?.accessTokenVerification ?? "userinfo",
    ["eve-jwt", "userinfo"] as const,
    "Unsupported OIDC access-token verification mode.",
  );
  const clientSecretInput = next.clientSecret ?? previous?.clientSecret;
  const clientSecret = clientSecretInput === undefined
    ? undefined
    : requiredString(clientSecretInput, "OIDC client secret must not be empty.");
  if (tokenEndpointAuthMethod !== "none" && !clientSecret) {
    throw new Error(`OIDC ${tokenEndpointAuthMethod} authentication requires a client secret.`);
  }

  const configuredScopes = next.scopes ?? previous?.scopes ?? ["openid", "offline_access"];
  if (!Array.isArray(configuredScopes) || configuredScopes.some((scope) => typeof scope !== "string" || !scope.trim())) {
    throw new Error("OIDC scopes must be a list of non-empty strings.");
  }
  const uniqueScopes = new Set(configuredScopes.map((scope) => (scope as string).trim()));
  uniqueScopes.delete("openid");
  const scopes = ["openid", ...[...uniqueScopes].sort()];

  const audienceInput = next.audience ?? previous?.audience;
  const audience = audienceInput === undefined
    ? undefined
    : requiredString(audienceInput, "OIDC audience must not be empty.").trim();
  const audienceModeInput = next.audienceMode ?? previous?.audienceMode;
  if (!audience && audienceModeInput !== undefined) throw new Error("OIDC audience mode requires an audience.");
  const audienceMode = audience
    ? oneOf(audienceModeInput ?? "resource", ["resource", "audience", "both"] as const, "Unsupported OIDC audience mode.")
    : undefined;
  if (accessTokenVerification === "eve-jwt" && !audience) {
    throw new Error("OIDC eve-jwt access-token verification requires an audience.");
  }

  const authorizationParamsInput = next.authorizationParams ?? previous?.authorizationParams;
  const authorizationParams = authorizationParamsInput === undefined
    ? undefined
    : normalizeAuthorizationParams(authorizationParamsInput);
  return {
    issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes,
    ...(audience ? { audience, audienceMode } : {}),
    tokenEndpointAuthMethod,
    ...(authorizationParams && Object.keys(authorizationParams).length > 0 ? { authorizationParams } : {}),
    accessTokenVerification,
  };
}

function normalizeHttpsIssuer(value: string): string {
  const issuer = new URL(value);
  if (issuer.protocol !== "https:") throw new Error("OIDC issuer must use HTTPS.");
  if (issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error("OIDC issuer must not contain userinfo, query, or fragment components.");
  }
  issuer.pathname = issuer.pathname.replace(/\/$/, "");
  return issuer.toString().replace(/\/$/, "");
}

function normalizeAuthorizationParams(value: unknown): Record<string, string> {
  const params = record(value, "OIDC authorization parameters must be an object.");
  return Object.fromEntries(Object.entries(params).sort(([left], [right]) => left.localeCompare(right)).map(([key, candidate]) => {
    if (reservedOidcAuthorizationParameters.has(key)) {
      throw new Error(`OIDC authorization parameter ${key} is managed by eve-chats.`);
    }
    return [key, requiredString(candidate, `OIDC authorization parameter ${key} must be a string.`)];
  }));
}

function legacyCustomHeaders(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (typeof value?.headerName !== "string") return null;
  const headerValue = value.headerValue ?? value.value;
  return typeof headerValue === "string" ? { [value.headerName]: headerValue } : null;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, message: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(message);
  return value as T[number];
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  const object = optionalRecord(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortValue(object[key])]));
}
