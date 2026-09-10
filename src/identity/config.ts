export type EvelandConfig = {
  publicOrigin: string;
  issuer: string;
  internalOrigin: string;
  jwksUrl: string;
  returnTarget: string;
};

type EvelandEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_PUBLIC_ORIGIN = "http://localhost:17300";
const DEFAULT_RETURN_TARGET = "eve-chats";

export function resolveEvelandConfig(
  environment: EvelandEnvironment = process.env,
): EvelandConfig {
  const publicOrigin = normalizeOrigin(
    firstValue(
      environment.EVELAND_PUBLIC_ORIGIN,
      environment.NEXT_PUBLIC_EVELAND_IDENTITY_URL,
    ) ?? DEFAULT_PUBLIC_ORIGIN,
  );
  const issuer = normalizeOrigin(
    firstValue(environment.EVELAND_IDENTITY_ISSUER) ?? publicOrigin,
  );
  const internalOrigin = normalizeOrigin(
    firstValue(
      environment.EVELAND_INTERNAL_ORIGIN,
      environment.EVELAND_IDENTITY_URL,
    ) ?? publicOrigin,
  );
  const jwksUrl =
    firstValue(environment.EVELAND_IDENTITY_JWKS_URL) ??
    `${internalOrigin}/.well-known/jwks.json`;
  const returnTarget =
    firstValue(
      environment.EVELAND_IDENTITY_RETURN_TARGET,
      environment.NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET,
    ) ?? DEFAULT_RETURN_TARGET;

  return { publicOrigin, issuer, internalOrigin, jwksUrl, returnTarget };
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}
