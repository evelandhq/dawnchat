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

export type IdentityCatalog = {
  issuer: string;
  agents: Array<{
    projectId: string;
    name: string;
    description: string | null;
    url: string;
    capabilities: { eveChat: true };
  }>;
};

export type EvelandAuthenticationChallenge = {
  kind: "eveland";
  url: string;
  projectId: string;
  displayName: string;
};

type IdentityClientOptions = {
  baseUrl: string;
  requestBaseUrl?: string;
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
  const requestBaseUrl =
    options.requestBaseUrl === undefined
      ? undefined
      : options.requestBaseUrl.replace(/\/$/, "");
  const fetchIdentity = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const redirect =
    options.redirect ??
    ((url: string) => {
      window.location.assign(url);
    });
  const callerTokens = new Map<string, CachedCallerToken>();
  const callerTokenPromises = new Map<string, Promise<string>>();
  let appToken: CachedCallerToken | undefined;
  let appTokenPromise: Promise<string> | undefined;
  let sessionPromise: Promise<IdentitySession> | undefined;
  let loginRedirectStarted = false;

  async function getSession(force = false): Promise<IdentitySession> {
    if (force) sessionPromise = undefined;
    sessionPromise ??= (async () => {
      let response: Response;
      try {
        response = await fetchIdentity(identityRequestUrl("/identity/session"), {
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

  async function getCatalog(returnPath = "/"): Promise<IdentityCatalog> {
    let response: Response;
    try {
      response = await fetchIdentity(`${baseUrl}/agent-catalog`, {
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
    if (response.status === 401) beginLogin(returnPath);
    if (!response.ok) throw await responseError(response);
    return parseIdentityCatalog(await response.json(), baseUrl);
  }

  async function getAppToken(returnPath = "/"): Promise<string> {
    const current = now().getTime();
    if (appToken && appToken.expiresAt - current > 15_000) {
      return appToken.token;
    }
    if (appTokenPromise) return appTokenPromise;
    const request = issueAppToken(returnPath).finally(() => {
      if (appTokenPromise === request) appTokenPromise = undefined;
    });
    appTokenPromise = request;
    return request;
  }

  async function issueAppToken(returnPath: string): Promise<string> {
    const session = await getSession();
    if (!session.authenticated) beginLogin(returnPath);
    let response: Response;
    try {
      response = await fetchIdentity(identityRequestUrl("/identity/app-tokens"), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ target: options.returnTarget }),
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
      if (response.status === 401) beginLogin(returnPath);
      throw error;
    }
    const parsed = parseTokenResponse(await response.json());
    appToken = parsed;
    return parsed.token;
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
      response = await fetchIdentity(
        identityRequestUrl("/identity/caller-tokens"),
        {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectId }),
        },
      );
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

  async function respondToAuthenticationChallenge(
    header: string | null,
    expectedProjectId: string,
    returnPath: string,
  ): Promise<string | null> {
    const challenge = parseEvelandAuthenticationChallenge(header);
    if (!challenge) return null;
    const expectedLoginUrl = new URL(`${baseUrl}/identity/login`);
    const challengeUrl = new URL(challenge.url);
    if (
      challenge.projectId !== expectedProjectId ||
      challengeUrl.toString() !== expectedLoginUrl.toString()
    ) {
      throw new EvelandIdentityError(
        "identity_challenge_invalid",
        401,
        "The Agent returned invalid Eveland authentication metadata.",
      );
    }
    const session = await getSession();
    if (!session.authenticated) {
      beginLogin(returnPath, false, challenge.url);
    }
    return getCallerToken(expectedProjectId, returnPath);
  }

  function beginLogin(
    returnPath: string,
    switchRealm = false,
    loginUrl = `${baseUrl}/identity/login`,
  ): never {
    const login = new URL(loginUrl);
    login.searchParams.set("target", options.returnTarget);
    login.searchParams.set("returnPath", safeReturnPath(returnPath));
    if (switchRealm) login.searchParams.set("switchRealm", "1");
    if (!loginRedirectStarted) {
      loginRedirectStarted = true;
      redirect(login.toString());
    }
    throw new EvelandIdentityError(
      "identity_redirecting",
      401,
      "Redirecting to Eveland Identity.",
    );
  }

  async function logout(): Promise<void> {
    callerTokens.clear();
    appToken = undefined;
    sessionPromise = undefined;
    const response = await fetchIdentity(identityRequestUrl("/identity/logout"), {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw await responseError(response);
  }

  return {
    getSession,
    getCatalog,
    getAppToken,
    getCallerToken,
    respondToAuthenticationChallenge,
    login(returnPath: string): never {
      return beginLogin(returnPath);
    },
    switchRealm(returnPath: string): never {
      callerTokens.clear();
      appToken = undefined;
      sessionPromise = undefined;
      return beginLogin(returnPath, true);
    },
    logout,
  };

  function identityRequestUrl(path: `/identity/${string}`): string {
    if (requestBaseUrl !== undefined) return `${requestBaseUrl}${path}`;
    if (
      typeof window !== "undefined" &&
      window.location.hostname === new URL(baseUrl).hostname
    ) {
      return path;
    }
    return `${baseUrl}${path}`;
  }
}

export function parseEvelandAuthenticationChallenge(
  header: string | null,
): EvelandAuthenticationChallenge | null {
  if (!header) return null;
  const starts = [
    ...header.matchAll(/(?:^|,\s*)(Basic|Bearer)(?:\s+|$)/gi),
  ];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index]!;
    if (match[1]?.toLowerCase() !== "bearer") continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = starts[index + 1]?.index ?? header.length;
    const parameters = parseChallengeParameters(header.slice(start, end));
    if (parameters.realm !== "eveland") continue;
    const projectId = parameters.project_id?.trim();
    const displayName = parameters.display_name?.trim();
    const authorizationUri = parameters.authorization_uri;
    if (!projectId || !displayName || !authorizationUri) continue;
    let url: URL;
    try {
      url = new URL(authorizationUri);
    } catch {
      continue;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      continue;
    }
    return {
      kind: "eveland",
      url: url.toString(),
      projectId,
      displayName,
    };
  }
  return null;
}

function parseChallengeParameters(value: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  const pattern = /([!#$%&'*+.^_`|~0-9A-Za-z-]+)="((?:\\.|[^"])*)"/g;
  for (const match of value.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    const raw = match[2];
    if (!key || raw === undefined) continue;
    parameters[key] = raw.replace(/\\(.)/g, "$1");
  }
  return parameters;
}

function parseIdentityCatalog(
  value: unknown,
  issuer: string,
): IdentityCatalog {
  if (!value || typeof value !== "object") throw invalidIdentityResponse();
  const input = value as { agents?: unknown };
  if (!Array.isArray(input.agents)) {
    throw invalidIdentityResponse();
  }
  const agents = input.agents.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw invalidIdentityResponse();
    }
    const agent = candidate as Record<string, unknown>;
    const capabilities = agent.capabilities as Record<string, unknown> | undefined;
    if (
      typeof agent.projectId !== "string" ||
      typeof agent.name !== "string" ||
      (agent.description !== null && typeof agent.description !== "string") ||
      typeof agent.url !== "string" ||
      capabilities?.eveChat !== true
    ) {
      throw invalidIdentityResponse();
    }
    return {
      projectId: agent.projectId,
      name: agent.name,
      description: agent.description as string | null,
      url: agent.url,
      capabilities: { eveChat: true as const },
    };
  });
  return { issuer, agents };
}

function parseTokenResponse(value: unknown): CachedCallerToken {
  if (!value || typeof value !== "object") throw invalidIdentityResponse();
  const input = value as { token?: unknown; expiresAt?: unknown };
  const expiresAt =
    typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : Number.NaN;
  if (
    typeof input.token !== "string" ||
    input.token.length === 0 ||
    !Number.isFinite(expiresAt)
  ) {
    throw invalidIdentityResponse();
  }
  return { token: input.token, expiresAt };
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
