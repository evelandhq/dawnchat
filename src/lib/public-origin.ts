export function agentAuthCallbackUrl(requestUrl: string): string {
  const configured = process.env.APP_ORIGIN?.trim();
  const origin = configured ? normalizeAppOrigin(configured) : localRequestOrigin(requestUrl);
  return new URL("/agent-auth/oidc/callback", origin).toString();
}

function normalizeAppOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_ORIGIN must be an origin without credentials, path, query, or fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("APP_ORIGIN must use HTTPS outside local development.");
  }
  return url.origin;
}

function localRequestOrigin(requestUrl: string): string {
  const url = new URL(requestUrl);
  if (url.protocol !== "http:" || !isLoopback(url.hostname)) {
    throw new Error("APP_ORIGIN is required outside local development.");
  }
  return url.origin;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "[::1]"
    || /^127\./.test(normalized);
}
