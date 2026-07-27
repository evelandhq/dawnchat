export type IdentitySession =
  | { authenticated: false }
  | {
      authenticated: true;
      principal: {
        id: string;
        name: string | null;
        email: string | null;
      };
      activeRealm: {
        id: string;
        name: string;
      };
    };

type IdentityClientOptions = {
  baseUrl: string;
  returnTarget: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  redirect?: (url: string) => void;
};

type CachedCallerToken = {
  token: string;
  expiresAt: number;
};

export class EvelandIdentityError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EvelandIdentityError";
  }
}

export function createEvelandIdentityClient(options: IdentityClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchIdentity = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const redirect =
    options.redirect ??
    ((url: string) => {
      window.location.assign(url);
    });
  const callerTokens = new Map<string, CachedCallerToken>();
  const callerTokenPromises = new Map<string, Promise<string>>();
  let sessionPromise: Promise<IdentitySession> | undefined;

  async function getSession(force = false): Promise<IdentitySession> {
    if (force) sessionPromise = undefined;
    sessionPromise ??= (async () => {
      let response: Response;
      try {
        response = await fetchIdentity(`${baseUrl}/identity/session`, {
          credentials: "include",
          headers: { accept: "application/json" },
        });
      } catch {
        throw new EvelandIdentityError(
          "identity_unavailable",
          503,
          "Eveland Identity is unavailable.",
        );
      }
      if (!response.ok) throw await responseError(response);
      return parseIdentitySession(await response.json());
    })().catch((error) => {
      sessionPromise = undefined;
      throw error;
    });
    return sessionPromise;
  }

  async function getCallerToken(
    projectId: string,
    returnPath: string,
  ): Promise<string> {
    const cached = callerTokens.get(projectId);
    const current = now().getTime();
    if (cached && cached.expiresAt - current > 15_000) {
      return cached.token;
    }

    const pending = callerTokenPromises.get(projectId);
    if (pending) return pending;
    const request = issueCallerToken(projectId, returnPath).finally(() => {
      if (callerTokenPromises.get(projectId) === request) {
        callerTokenPromises.delete(projectId);
      }
    });
    callerTokenPromises.set(projectId, request);
    return request;
  }

  async function issueCallerToken(
    projectId: string,
    returnPath: string,
  ): Promise<string> {
    const session = await getSession();
    if (!session.authenticated) {
      beginLogin(returnPath);
    }

    let response: Response;
    try {
      response = await fetchIdentity(`${baseUrl}/identity/caller-tokens`, {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectId }),
      });
    } catch {
      throw new EvelandIdentityError(
        "identity_unavailable",
        503,
        "Eveland Identity is unavailable.",
      );
    }
    if (!response.ok) {
      const error = await responseError(response);
      if (response.status === 401) {
        callerTokens.clear();
        sessionPromise = undefined;
        beginLogin(returnPath);
      }
      throw error;
    }
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object") {
      throw invalidIdentityResponse();
    }
    const token = (body as { token?: unknown }).token;
    const expiresAtText = (body as { expiresAt?: unknown }).expiresAt;
    const expiresAt =
      typeof expiresAtText === "string" ? Date.parse(expiresAtText) : Number.NaN;
    if (typeof token !== "string" || token.length === 0 || !Number.isFinite(expiresAt)) {
      throw invalidIdentityResponse();
    }
    callerTokens.set(projectId, { token, expiresAt });
    return token;
  }

  function beginLogin(returnPath: string, switchRealm = false): never {
    const login = new URL(`${baseUrl}/identity/login`);
    login.searchParams.set("target", options.returnTarget);
    login.searchParams.set("returnPath", safeReturnPath(returnPath));
    if (switchRealm) login.searchParams.set("switchRealm", "1");
    redirect(login.toString());
    throw new EvelandIdentityError(
      "identity_redirecting",
      401,
      "Redirecting to Eveland Identity.",
    );
  }

  async function logout(): Promise<void> {
    callerTokens.clear();
    sessionPromise = undefined;
    const response = await fetchIdentity(`${baseUrl}/identity/logout`, {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw await responseError(response);
  }

  return {
    getSession,
    getCallerToken,
    login(returnPath: string): never {
      return beginLogin(returnPath);
    },
    switchRealm(returnPath: string): never {
      callerTokens.clear();
      sessionPromise = undefined;
      return beginLogin(returnPath, true);
    },
    logout,
  };
}

function parseIdentitySession(value: unknown): IdentitySession {
  if (!value || typeof value !== "object") throw invalidIdentityResponse();
  if ((value as { authenticated?: unknown }).authenticated === false) {
    return { authenticated: false };
  }
  const session = value as {
    authenticated?: unknown;
    principal?: Record<string, unknown>;
    activeRealm?: Record<string, unknown>;
  };
  if (
    session.authenticated !== true ||
    typeof session.principal?.id !== "string" ||
    typeof session.activeRealm?.id !== "string" ||
    typeof session.activeRealm?.name !== "string"
  ) {
    throw invalidIdentityResponse();
  }
  return {
    authenticated: true,
    principal: {
      id: session.principal.id,
      name:
        typeof session.principal.name === "string" ? session.principal.name : null,
      email:
        typeof session.principal.email === "string"
          ? session.principal.email
          : null,
    },
    activeRealm: {
      id: session.activeRealm.id,
      name: session.activeRealm.name,
    },
  };
}

async function responseError(response: Response): Promise<EvelandIdentityError> {
  const body = (await response.json().catch(() => null)) as
    | { code?: unknown; error?: unknown }
    | null;
  return new EvelandIdentityError(
    typeof body?.code === "string" ? body.code : "identity_request_failed",
    response.status,
    typeof body?.error === "string" ? body.error : "Eveland Identity request failed.",
  );
}

function invalidIdentityResponse(): EvelandIdentityError {
  return new EvelandIdentityError(
    "identity_response_invalid",
    502,
    "Eveland Identity returned an invalid response.",
  );
}

function safeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}
