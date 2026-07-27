import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

export type CallerIdentity = {
  principalId: string;
  realmId: string;
  projectId: string;
  expiresAt: number;
};

type CallerTokenVerifierOptions = {
  issuer: string;
  jwksUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  cacheTtlMs?: number;
};

export type CallerTokenVerifier = {
  verifyAuthorization(
    authorization: string | null,
    expectedProjectId?: string,
  ): Promise<CallerIdentity>;
};

type JwksKey = {
  alg?: unknown;
  kid?: unknown;
  kty?: unknown;
  use?: unknown;
  [key: string]: unknown;
};

export class CallerTokenError extends Error {
  constructor(
    readonly code:
      | "caller_token_missing"
      | "caller_token_invalid"
      | "caller_token_expired"
      | "caller_token_verification_unavailable",
    readonly status: 401 | 503,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CallerTokenError";
  }
}

export function createCallerTokenVerifier(
  options: CallerTokenVerifierOptions,
): CallerTokenVerifier {
  const issuer = options.issuer.replace(/\/$/, "");
  const fetchJwks = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  let cache:
    | {
        expiresAt: number;
        keys: Map<string, KeyObject>;
      }
    | undefined;

  async function loadKeys(force = false): Promise<Map<string, KeyObject>> {
    const current = now().getTime();
    if (!force && cache && cache.expiresAt > current) {
      return cache.keys;
    }

    let response: Response;
    try {
      response = await fetchJwks(options.jwksUrl, {
        headers: { accept: "application/json" },
        redirect: "error",
      });
    } catch (error) {
      throw new CallerTokenError(
        "caller_token_verification_unavailable",
        503,
        "Eveland signing keys are unavailable.",
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new CallerTokenError(
        "caller_token_verification_unavailable",
        503,
        "Eveland signing keys are unavailable.",
      );
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new CallerTokenError(
        "caller_token_verification_unavailable",
        503,
        "Eveland signing keys are invalid.",
        { cause: error },
      );
    }
    if (!value || typeof value !== "object" || !Array.isArray((value as { keys?: unknown }).keys)) {
      throw new CallerTokenError(
        "caller_token_verification_unavailable",
        503,
        "Eveland signing keys are invalid.",
      );
    }

    const keys = new Map<string, KeyObject>();
    for (const candidate of (value as { keys: unknown[] }).keys) {
      if (!candidate || typeof candidate !== "object") continue;
      const jwk = candidate as JwksKey;
      if (
        typeof jwk.kid !== "string" ||
        jwk.alg !== "ES256" ||
        jwk.kty !== "EC" ||
        (jwk.use !== undefined && jwk.use !== "sig")
      ) {
        continue;
      }
      try {
        keys.set(
          jwk.kid,
          createPublicKey({ format: "jwk", key: jwk as JsonWebKey }),
        );
      } catch {
        // Ignore malformed or unsupported keys; a missing usable kid fails closed.
      }
    }
    cache = { expiresAt: current + cacheTtlMs, keys };
    return keys;
  }

  async function verifyAuthorization(
    authorization: string | null,
    expectedProjectId?: string,
  ): Promise<CallerIdentity> {
    const token = readBearerToken(authorization);
    const [headerText, payloadText, signatureText, extra] = token.split(".");
    if (!headerText || !payloadText || !signatureText || extra !== undefined) {
      throw invalidToken();
    }

    const header = decodeObject(headerText);
    const payload = decodeObject(payloadText);
    if (
      header.alg !== "ES256" ||
      typeof header.kid !== "string" ||
      (header.typ !== undefined && header.typ !== "JWT")
    ) {
      throw invalidToken();
    }

    let keys = await loadKeys();
    let key = keys.get(header.kid);
    if (!key) {
      keys = await loadKeys(true);
      key = keys.get(header.kid);
    }
    if (
      !key ||
      !verifySignature(
        "sha256",
        Buffer.from(`${headerText}.${payloadText}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(signatureText, "base64url"),
      )
    ) {
      throw invalidToken();
    }

    const current = Math.floor(now().getTime() / 1_000);
    if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp)) {
      throw invalidToken();
    }
    if (payload.exp <= current) {
      throw new CallerTokenError(
        "caller_token_expired",
        401,
        "The Eveland Caller Token has expired.",
      );
    }
    if (
      (payload.nbf !== undefined &&
        (typeof payload.nbf !== "number" || payload.nbf > current)) ||
      (payload.iat !== undefined &&
        (typeof payload.iat !== "number" || payload.iat > current))
    ) {
      throw invalidToken();
    }
    if (
      payload.iss !== issuer ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      payload.principal_type !== "user" ||
      typeof payload.realm_id !== "string" ||
      payload.realm_id.length === 0 ||
      typeof payload.aud !== "string"
    ) {
      throw invalidToken();
    }
    const projectId = parseProjectAudience(payload.aud);
    if (!projectId || (expectedProjectId !== undefined && projectId !== expectedProjectId)) {
      throw invalidToken();
    }

    return {
      principalId: payload.sub,
      realmId: payload.realm_id,
      projectId,
      expiresAt: payload.exp,
    };
  }

  return { verifyAuthorization };
}

let defaultVerifier:
  | ReturnType<typeof createCallerTokenVerifier>
  | undefined;

export function getCallerTokenVerifier() {
  defaultVerifier ??= createCallerTokenVerifier(identityVerifierConfig());
  return defaultVerifier;
}

export function resetCallerTokenVerifierForTests(): void {
  defaultVerifier = undefined;
}

export function setCallerTokenVerifierForTests(
  verifier: CallerTokenVerifier | null,
): void {
  defaultVerifier = verifier ?? undefined;
}

export function callerTokenErrorResponse(error: CallerTokenError): Response {
  return Response.json(
    { code: error.code, error: error.message },
    {
      status: error.status,
      headers: { "cache-control": "no-store" },
    },
  );
}

function identityVerifierConfig(): CallerTokenVerifierOptions {
  const issuer = process.env.EVELAND_IDENTITY_ISSUER?.trim();
  if (!issuer) {
    throw new CallerTokenError(
      "caller_token_verification_unavailable",
      503,
      "EVELAND_IDENTITY_ISSUER is not configured.",
    );
  }
  return {
    issuer,
    jwksUrl:
      process.env.EVELAND_IDENTITY_JWKS_URL?.trim() ||
      `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`,
  };
}

function readBearerToken(authorization: string | null): string {
  if (!authorization) {
    throw new CallerTokenError(
      "caller_token_missing",
      401,
      "An Eveland Caller Token is required.",
    );
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    authorization,
  );
  if (!match) throw invalidToken();
  return match[1]!;
}

function decodeObject(value: string): Record<string, unknown> {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("JWT value is not an object");
    }
    return decoded as Record<string, unknown>;
  } catch {
    throw invalidToken();
  }
}

function parseProjectAudience(value: string): string | null {
  const prefix = "eveland:project:";
  if (!value.startsWith(prefix)) return null;
  const projectId = value.slice(prefix.length);
  return projectId.length > 0 ? projectId : null;
}

function invalidToken(): CallerTokenError {
  return new CallerTokenError(
    "caller_token_invalid",
    401,
    "The Eveland Caller Token is invalid.",
  );
}
