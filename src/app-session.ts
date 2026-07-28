import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const COOKIE_NAME = "eve_chats_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const TOKEN_VERSION = "v1";

export type AppBrowserSession = {
  clientId: string;
  setCookie?: string;
};

export function resolveAppBrowserSession(request: Request): AppBrowserSession {
  const existing = readSessionCookie(request.headers.get("cookie"));
  if (existing) {
    return { clientId: existing };
  }

  const clientId = `client_${randomBytes(16).toString("hex")}`;
  return {
    clientId,
    setCookie: serializeSessionCookie(signClientId(clientId)),
  };
}

export function applyAppBrowserSession(
  response: Response,
  session: AppBrowserSession,
): Response {
  if (session.setCookie) {
    response.headers.append("set-cookie", session.setCookie);
  }
  return response;
}

function readSessionCookie(header: string | null): string | null {
  const value = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!value) return null;

  const [version, clientId, signature, extra] = value.split(".");
  if (
    version !== TOKEN_VERSION ||
    !clientId ||
    !/^client_[a-f0-9]{32}$/.test(clientId) ||
    !signature ||
    extra !== undefined
  ) {
    return null;
  }
  const expected = signatureFor(clientId);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
    ? clientId
    : null;
}

function signClientId(clientId: string): string {
  return `${TOKEN_VERSION}.${clientId}.${signatureFor(clientId)}`;
}

function signatureFor(clientId: string): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("AUTH_SECRET is required for EveChats browser sessions");
  }
  return createHmac("sha256", secret)
    .update(`${TOKEN_VERSION}.${clientId}`)
    .digest("base64url");
}

function serializeSessionCookie(value: string): string {
  return [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}
