import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { verifyOidc } from "eve/channels/auth";
import * as oidc from "openid-client";

import type {
  AgentAuthCredential,
  AgentAuthCredentialKey,
  AgentConnection,
  Repository,
} from "@/db/repository";
import { openAgentAuthState, parseAuthConfig, sealAgentAuthState } from "@/eve/auth";
import {
  normalizeAgentAuthConfig,
  type OidcAuthorizationCodeConfig,
} from "@/eve/auth-methods";
import { parseAgentAuthReturnPath } from "@/lib/agent-auth-callback";

const SINGLE_USER_PRINCIPAL_ID = "eve-chats-local-user";
const OIDC_EXPIRATION_BUFFER_MS = 30_000;
const OIDC_REFRESH_LEASE_MS = 15_000;
const OIDC_REFRESH_WAIT_MS = 50;
const OIDC_REFRESH_WAIT_ATTEMPTS = 320;

const refreshFlights = new Map<string, Promise<AgentAuthCredential>>();

export type OidcTransaction = {
  state: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  agentConnectionId: string;
  securityRevision: number;
  callerPrincipalId: string;
  authMethod: "oidc";
  returnPath: string;
};

export type OidcTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  issuer: string;
  subject: string;
};

export type OidcProtocol = {
  preflight(config: OidcAuthorizationCodeConfig): Promise<void>;
  buildAuthorizationUrl(config: OidcAuthorizationCodeConfig, transaction: OidcTransaction): Promise<URL>;
  exchangeAuthorizationCode(
    config: OidcAuthorizationCodeConfig,
    transaction: OidcTransaction,
    currentUrl: URL,
  ): Promise<OidcTokenSet>;
  refresh(
    config: OidcAuthorizationCodeConfig,
    refreshToken: string,
    subject: string,
  ): Promise<OidcTokenSet>;
  fetchUserInfo(
    config: OidcAuthorizationCodeConfig,
    accessToken: string,
    expectedSubject: string,
  ): Promise<{ subject: string }>;
};

type ActiveCredential = {
  verificationState?: "verified";
  accessToken: string;
  refreshToken?: string;
  agentIssuer: string;
  agentSubject: string;
  idTokenIssuer: string;
  idTokenSubject: string;
  obtainedAt: string;
};

type PendingCredential = {
  verificationState: "pending";
  accessToken: string;
  refreshToken?: string;
  idTokenIssuer: string;
  idTokenSubject: string;
  obtainedAt: string;
};

type StoredCredential = ActiveCredential | PendingCredential;

export type ResolvedOidcCredential = {
  token: string;
  rotationSeq: number;
};

export class AgentAuthorizationRequiredError extends Error {
  readonly interactionUrl: string;

  constructor(agentConnectionId: string, returnPath: string) {
    const interactionUrl = `/api/agents/${encodeURIComponent(agentConnectionId)}/auth/oidc/start?returnPath=${encodeURIComponent(returnPath)}`;
    super("Authorize this Agent Connection before sending a message.");
    this.name = "AgentAuthorizationRequiredError";
    this.interactionUrl = interactionUrl;
  }
}

export class OidcAccessTokenRejectedError extends Error {}
export class OidcReauthorizationRequiredError extends Error {}

export type AgentOidcServiceOptions = {
  repository: Repository;
  protocol?: OidcProtocol;
  now?: () => Date;
};

export function createAgentOidcService(options: AgentOidcServiceOptions) {
  const protocol = options.protocol ?? defaultOidcProtocol;
  const now = options.now ?? (() => new Date());
  const refreshOwner = randomUUID();

  const credentialKey = (connection: AgentConnection): AgentAuthCredentialKey => ({
    agentConnectionId: connection.id,
    securityRevision: connection.securityRevision,
    authMethod: "oidc",
    credentialScope: "principal",
    scopeSubject: SINGLE_USER_PRINCIPAL_ID,
    credentialKey: "",
  });

  const readConfig = (connection: AgentConnection): OidcAuthorizationCodeConfig => {
    if (connection.authType !== "oidc") throw new Error("OIDC Agent Connection is not available.");
    return normalizeAgentAuthConfig("oidc", {}, parseAuthConfig(connection)) as OidcAuthorizationCodeConfig;
  };

  const readCredential = (credential: AgentAuthCredential, key: AgentAuthCredentialKey): StoredCredential =>
    openAgentAuthState<StoredCredential>(credential.payloadEncrypted, "credential", credentialBinding(key));

  const verifyAccessToken = async (
    token: OidcTokenSet,
    config: OidcAuthorizationCodeConfig,
  ): Promise<ActiveCredential> => {
    let verified: { issuer: string; subject: string };
    if (config.accessTokenVerification === "userinfo") {
      const userInfo = await protocol.fetchUserInfo(config, token.accessToken, token.subject);
      if (userInfo.subject !== token.subject) {
        throw new OidcAccessTokenRejectedError("OIDC UserInfo subject does not match the verified ID token subject.");
      }
      verified = { issuer: config.issuer, subject: userInfo.subject };
    } else {
      if (!config.audience) throw new OidcAccessTokenRejectedError("OIDC JWT verification requires an audience.");
      const result = await verifyOidc(token.accessToken, { issuer: config.issuer, audiences: [config.audience] });
      if (!result.ok) throw new OidcAccessTokenRejectedError("OIDC access token is not accepted by Eve's verifier.");
      verified = {
        issuer: result.sessionAuth.issuer ?? config.issuer,
        subject: result.sessionAuth.subject ?? result.sessionAuth.principalId,
      };
    }
    return {
      verificationState: "verified",
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      agentIssuer: verified.issuer,
      agentSubject: verified.subject,
      idTokenIssuer: token.issuer,
      idTokenSubject: token.subject,
      obtainedAt: now().toISOString(),
    };
  };

  const storeCredential = async (
    connection: AgentConnection,
    payload: StoredCredential,
    expiresAt: Date,
  ): Promise<AgentAuthCredential> => {
    const key = credentialKey(connection);
    return options.repository.putAgentAuthCredential({
      ...key,
      payloadEncrypted: sealAgentAuthState(payload, "credential", credentialBinding(key)),
      expiresAt,
    });
  };

  const verifyPendingCredential = async (
    connection: AgentConnection,
    credential: AgentAuthCredential,
    pending: PendingCredential,
  ): Promise<AgentAuthCredential> => {
    const key = credentialKey(connection);
    if (isExpiringSoon(credential, now())) {
      await options.repository.deleteAgentAuthCredential(key, credential.rotationSeq);
      throw new OidcReauthorizationRequiredError();
    }
    try {
      const verified = await verifyAccessToken({
        accessToken: pending.accessToken,
        ...(pending.refreshToken ? { refreshToken: pending.refreshToken } : {}),
        expiresAt: credential.expiresAt ?? new Date(now().getTime() + 300_000),
        issuer: pending.idTokenIssuer,
        subject: pending.idTokenSubject,
      }, readConfig(connection));
      const replaced = await options.repository.replaceAgentAuthCredential({
        ...key,
        expectedRotationSeq: credential.rotationSeq,
        payloadEncrypted: sealAgentAuthState(verified, "credential", credentialBinding(key)),
        expiresAt: credential.expiresAt,
      });
      if (replaced) return replaced;
      const winner = await options.repository.getAgentAuthCredential(key);
      if (winner && winner.rotationSeq > credential.rotationSeq) return winner;
      throw new Error("The Agent credential changed while access-token verification was retried.");
    } catch (error) {
      if (error instanceof OidcAccessTokenRejectedError) {
        await options.repository.deleteAgentAuthCredential(key, credential.rotationSeq);
        throw new OidcReauthorizationRequiredError();
      }
      throw error;
    }
  };

  const refreshCredentialWithLease = async (
    connection: AgentConnection,
    credential: AgentAuthCredential,
    payload: ActiveCredential,
  ): Promise<AgentAuthCredential> => {
    if (!payload.refreshToken) throw new OidcReauthorizationRequiredError();
    const key = credentialKey(connection);
    const claimedAt = now();
    const refreshLeaseId = randomUUID();
    const claimed = await options.repository.claimAgentAuthRefreshLease({
      ...key,
      expectedRotationSeq: credential.rotationSeq,
      refreshOwner,
      refreshLeaseId,
      now: claimedAt,
      leaseUntil: new Date(claimedAt.getTime() + OIDC_REFRESH_LEASE_MS),
    });
    if (!claimed) {
      return waitForRefreshWinner(connection, credential.rotationSeq);
    }
    try {
      const claimedPayload = readCredential(claimed, key);
      if (claimedPayload.verificationState === "pending") {
        throw new Error("An unverified Agent credential cannot be refreshed.");
      }
      if (!claimedPayload.refreshToken) throw new OidcReauthorizationRequiredError();
      const token = await protocol.refresh(
        readConfig(connection),
        claimedPayload.refreshToken,
        claimedPayload.idTokenSubject,
      );
      const nextPayload = await verifyAccessToken(token, readConfig(connection));
      nextPayload.refreshToken ??= claimedPayload.refreshToken;
      const replaced = await options.repository.completeAgentAuthRefresh({
        ...key,
        expectedRotationSeq: credential.rotationSeq,
        refreshOwner,
        refreshLeaseId,
        now: now(),
        payloadEncrypted: sealAgentAuthState(nextPayload, "credential", credentialBinding(key)),
        expiresAt: token.expiresAt,
      });
      if (replaced) return replaced;
      const winner = await options.repository.getAgentAuthCredential(key);
      if (winner && winner.rotationSeq > credential.rotationSeq) return winner;
      throw new Error("The Agent credential changed while it was being refreshed.");
    } catch (error) {
      const winner = await options.repository.getAgentAuthCredential(key);
      if (winner && winner.rotationSeq > credential.rotationSeq) return winner;
      if (isInvalidGrant(error)) {
        const deleted = await options.repository.deleteAgentAuthCredentialWithRefreshLease({
          ...key,
          expectedRotationSeq: credential.rotationSeq,
          refreshOwner,
          refreshLeaseId,
          now: now(),
        });
        if (deleted) throw new OidcReauthorizationRequiredError();
      } else {
        await options.repository.releaseAgentAuthRefreshLease({
          ...key,
          expectedRotationSeq: credential.rotationSeq,
          refreshOwner,
          refreshLeaseId,
        });
      }
      throw error;
    }
  };

  const waitForRefreshWinner = async (
    connection: AgentConnection,
    rejectedRotationSeq: number,
  ): Promise<AgentAuthCredential> => {
    const key = credentialKey(connection);
    for (let attempt = 0; attempt < OIDC_REFRESH_WAIT_ATTEMPTS; attempt += 1) {
      const current = await options.repository.getAgentAuthCredential(key);
      if (!current) throw new OidcReauthorizationRequiredError();
      if (current.rotationSeq > rejectedRotationSeq) return current;
      if (
        current.refreshLeaseUntil === null
        || current.refreshLeaseUntil.getTime() <= now().getTime()
      ) {
        const currentPayload = readCredential(current, key);
        if (currentPayload.verificationState === "pending") {
          return verifyPendingCredential(connection, current, currentPayload);
        }
        return refreshCredentialWithLease(connection, current, currentPayload);
      }
      await wait(OIDC_REFRESH_WAIT_MS);
    }
    throw new Error("Timed out waiting for another process to refresh the Agent credential.");
  };

  const refreshCredential = (
    connection: AgentConnection,
    credential: AgentAuthCredential,
    payload: ActiveCredential,
  ): Promise<AgentAuthCredential> => {
    const key = JSON.stringify([...credentialBinding(credentialKey(connection)), credential.rotationSeq]);
    const existing = refreshFlights.get(key);
    if (existing) return existing;
    const pending = refreshCredentialWithLease(connection, credential, payload).finally(() => {
      if (refreshFlights.get(key) === pending) refreshFlights.delete(key);
    });
    refreshFlights.set(key, pending);
    return pending;
  };

  const resolve = async (
    connection: AgentConnection,
    returnPath = `/agents/${connection.id}/edit`,
  ): Promise<ResolvedOidcCredential> => {
    const key = credentialKey(connection);
    let credential = await options.repository.getAgentAuthCredential(key);
    if (!credential) throw new AgentAuthorizationRequiredError(connection.id, returnPath);
    let payload: StoredCredential;
    try {
      payload = readCredential(credential, key);
    } catch {
      throw new Error("The stored Agent credential could not be decrypted.");
    }
    if (payload.verificationState === "pending") {
      try {
        credential = await verifyPendingCredential(connection, credential, payload);
        payload = readCredential(credential, key);
      } catch (error) {
        if (error instanceof OidcReauthorizationRequiredError) {
          throw new AgentAuthorizationRequiredError(connection.id, returnPath);
        }
        throw error;
      }
    }
    if (payload.verificationState === "pending") {
      throw new Error("The Agent credential is still pending verification.");
    }
    if (isExpiringSoon(credential, now())) {
      try {
        credential = await refreshCredential(connection, credential, payload);
        payload = readCredential(credential, key);
      } catch (error) {
        if (error instanceof OidcReauthorizationRequiredError) {
          throw new AgentAuthorizationRequiredError(connection.id, returnPath);
        }
        throw error;
      }
    }
    return { token: payload.accessToken, rotationSeq: credential.rotationSeq };
  };

  return {
    credentialKey,
    async preflight(connection: AgentConnection): Promise<void> {
      await protocol.preflight(readConfig(connection));
    },
    async start(input: {
      connection: AgentConnection;
      callbackUrl: string;
      returnPath: string;
    }): Promise<{ state: string; authorizationUrl: string }> {
      await assertReturnPath(input.returnPath, input.connection.id, options.repository);
      const callbackUrl = normalizeCallbackUrl(input.callbackUrl);
      await protocol.preflight(readConfig(input.connection));
      await options.repository.deleteExpiredAgentAuthTransactions(now(), 100);
      const state = oidc.randomState();
      const transaction: OidcTransaction = {
        state,
        codeVerifier: oidc.randomPKCECodeVerifier(),
        nonce: oidc.randomNonce(),
        redirectUri: callbackUrl,
        agentConnectionId: input.connection.id,
        securityRevision: input.connection.securityRevision,
        callerPrincipalId: SINGLE_USER_PRINCIPAL_ID,
        authMethod: "oidc",
        returnPath: input.returnPath,
      };
      const stateHash = hashState(state);
      await options.repository.createAgentAuthTransaction({
        agentConnectionId: input.connection.id,
        stateHash,
        payloadEncrypted: sealAgentAuthState(transaction, "transaction", [stateHash]),
        expiresAt: new Date(now().getTime() + 10 * 60_000),
      });
      const authorizationUrl = await protocol.buildAuthorizationUrl(readConfig(input.connection), transaction);
      return { state, authorizationUrl: authorizationUrl.toString() };
    },
    async callback(input: { search: string }): Promise<{ returnPath: string; agentConnectionId: string }> {
      const callbackUrl = new URL("https://callback.invalid");
      callbackUrl.search = input.search;
      const state = callbackUrl.searchParams.get("state");
      if (!state) throw new Error("OIDC state is required.");
      const stateHash = hashState(state);
      const stored = await options.repository.consumeAgentAuthTransaction(stateHash, now());
      if (!stored) throw new Error("OIDC authorization transaction is invalid, expired, or already used.");
      const transaction = openAgentAuthState<OidcTransaction>(stored.payloadEncrypted, "transaction", [stateHash]);
      if (transaction.state !== state) throw new Error("OIDC authorization state does not match.");
      if (transaction.callerPrincipalId !== SINGLE_USER_PRINCIPAL_ID) {
        throw new Error("OIDC authorization belongs to a different caller.");
      }
      const connection = await options.repository.getAgentConnection(transaction.agentConnectionId);
      if (!connection || connection.authType !== "oidc" || connection.securityRevision !== transaction.securityRevision) {
        throw new Error("Agent Connection changed while OIDC authorization was in progress.");
      }
      const currentUrl = new URL(transaction.redirectUri);
      currentUrl.search = input.search;
      const token = await protocol.exchangeAuthorizationCode(readConfig(connection), transaction, currentUrl);
      let payload: StoredCredential;
      try {
        payload = await verifyAccessToken(token, readConfig(connection));
      } catch (error) {
        if (error instanceof OidcAccessTokenRejectedError) throw error;
        payload = {
          verificationState: "pending",
          accessToken: token.accessToken,
          ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
          idTokenIssuer: token.issuer,
          idTokenSubject: token.subject,
          obtainedAt: now().toISOString(),
        };
      }
      const currentConnection = await options.repository.getAgentConnection(transaction.agentConnectionId);
      if (!currentConnection || currentConnection.authType !== "oidc" || currentConnection.securityRevision !== transaction.securityRevision) {
        throw new Error("Agent Connection changed while OIDC authorization was in progress.");
      }
      await storeCredential(currentConnection, payload, token.expiresAt);
      return { returnPath: transaction.returnPath, agentConnectionId: connection.id };
    },
    resolve,
    async recoverUnauthorized(input: {
      connection: AgentConnection;
      rejectedRotationSeq: number;
      attempt: 0 | 1;
      returnPath?: string;
    }): Promise<ResolvedOidcCredential> {
      const returnPath = input.returnPath ?? `/agents/${input.connection.id}/edit`;
      const key = credentialKey(input.connection);
      const credential = await options.repository.getAgentAuthCredential(key);
      if (!credential) throw new AgentAuthorizationRequiredError(input.connection.id, returnPath);
      if (credential.rotationSeq > input.rejectedRotationSeq) return resolve(input.connection, returnPath);
      if (credential.rotationSeq !== input.rejectedRotationSeq) {
        throw new Error("The Agent credential changed; retry the request.");
      }
      if (input.attempt === 1) {
        const deleted = await options.repository.deleteAgentAuthCredential(key, credential.rotationSeq);
        if (deleted) throw new AgentAuthorizationRequiredError(input.connection.id, returnPath);
        const winner = await options.repository.getAgentAuthCredential(key);
        if (winner && winner.rotationSeq > credential.rotationSeq) return resolve(input.connection, returnPath);
        if (winner && winner.rotationSeq === credential.rotationSeq && winner.refreshLeaseId) {
          const winnerPayload = readCredential(winner, key);
          if (winnerPayload.verificationState === "pending") return resolve(input.connection, returnPath);
          try {
            await refreshCredential(input.connection, winner, winnerPayload);
          } catch (error) {
            if (error instanceof OidcReauthorizationRequiredError) {
              throw new AgentAuthorizationRequiredError(input.connection.id, returnPath);
            }
            throw error;
          }
          return resolve(input.connection, returnPath);
        }
        throw new Error("The Agent credential changed while it was being invalidated.");
      }
      const payload = readCredential(credential, key);
      if (payload.verificationState === "pending") return resolve(input.connection, returnPath);
      try {
        await refreshCredential(input.connection, credential, payload);
        return resolve(input.connection, returnPath);
      } catch (error) {
        if (error instanceof OidcReauthorizationRequiredError) {
          throw new AgentAuthorizationRequiredError(input.connection.id, returnPath);
        }
        throw error;
      }
    },
  };
}

const defaultOidcProtocol = createOpenIdClientProtocol();

export async function preflightOidcConfig(config: OidcAuthorizationCodeConfig): Promise<void> {
  await defaultOidcProtocol.preflight(config);
}

export function createOpenIdClientProtocol(options: { allowInsecureIssuer?: boolean } = {}): OidcProtocol {
  const cache = new Map<string, Promise<oidc.Configuration>>();
  const allowInsecure = options.allowInsecureIssuer === true;
  const getConfiguration = (config: OidcAuthorizationCodeConfig) => {
    const secretFingerprint = config.clientSecret
      ? createHash("sha256").update(config.clientSecret).digest("base64url")
      : null;
    const key = JSON.stringify({ ...config, clientSecret: secretFingerprint });
    let pending = cache.get(key);
    if (!pending) {
      assertOidcUrl(new URL(config.issuer), allowInsecure);
      const clientAuth = config.tokenEndpointAuthMethod === "client_secret_basic"
        ? oidc.ClientSecretBasic(config.clientSecret)
        : config.tokenEndpointAuthMethod === "client_secret_post"
          ? oidc.ClientSecretPost(config.clientSecret)
          : oidc.None();
      pending = oidc.discovery(
        new URL(config.issuer),
        config.clientId,
        { token_endpoint_auth_method: config.tokenEndpointAuthMethod },
        clientAuth,
        {
          timeout: 10,
          ...(allowInsecure ? { execute: [oidc.allowInsecureRequests] } : {}),
        },
      ).then((configuration) => {
        validateDiscoveredEndpoints(configuration, allowInsecure);
        configuration[oidc.customFetch] = safeOidcFetch(allowInsecure);
        return configuration;
      });
      cache.set(key, pending);
      void pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    return pending;
  };
  const audienceParams = (config: OidcAuthorizationCodeConfig) => {
    if (!config.audience) return {};
    return {
      ...(config.audienceMode === "resource" || config.audienceMode === "both" ? { resource: config.audience } : {}),
      ...(config.audienceMode === "audience" || config.audienceMode === "both" ? { audience: config.audience } : {}),
    };
  };
  return {
    async preflight(config) {
      await getConfiguration(config);
    },
    async buildAuthorizationUrl(config, transaction) {
      return oidc.buildAuthorizationUrl(await getConfiguration(config), {
        redirect_uri: transaction.redirectUri,
        response_type: "code",
        scope: config.scopes.join(" "),
        state: transaction.state,
        nonce: transaction.nonce,
        code_challenge: calculatePkceCodeChallenge(transaction.codeVerifier),
        code_challenge_method: "S256",
        ...config.authorizationParams,
        ...audienceParams(config),
      });
    },
    async exchangeAuthorizationCode(config, transaction, currentUrl) {
      const tokens = await oidc.authorizationCodeGrant(await getConfiguration(config), currentUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      }, audienceParams(config));
      const claims = tokens.claims();
      if (!tokens.access_token || !claims?.iss || !claims.sub) {
        throw new Error("OIDC token response is missing an access token or verified ID token identity.");
      }
      return {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: new Date(Date.now() + (tokens.expires_in ?? 300) * 1000),
        issuer: claims.iss,
        subject: claims.sub,
      };
    },
    async refresh(config, refreshToken, subject) {
      const tokens = await oidc.refreshTokenGrant(await getConfiguration(config), refreshToken, audienceParams(config));
      if (!tokens.access_token) throw new Error("OIDC refresh response is missing an access token.");
      const claims = tokens.claims();
      if (claims?.sub && claims.sub !== subject) {
        throw new OidcAccessTokenRejectedError("OIDC refresh changed the authorized subject.");
      }
      return {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: new Date(Date.now() + (tokens.expires_in ?? 300) * 1000),
        issuer: claims?.iss ?? config.issuer,
        subject,
      };
    },
    async fetchUserInfo(config, accessToken, expectedSubject) {
      const result = await oidc.fetchUserInfo(await getConfiguration(config), accessToken, expectedSubject);
      return { subject: result.sub };
    },
  };
}

export function calculatePkceCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function credentialBinding(key: AgentAuthCredentialKey): readonly unknown[] {
  return [
    key.agentConnectionId,
    key.securityRevision,
    key.authMethod,
    key.credentialScope,
    key.scopeSubject,
    key.credentialKey,
  ];
}

function isExpiringSoon(credential: AgentAuthCredential, now: Date): boolean {
  return credential.expiresAt !== null
    && credential.expiresAt.getTime() <= now.getTime() + OIDC_EXPIRATION_BUFFER_MS;
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

async function assertReturnPath(
  returnPath: string,
  agentConnectionId: string,
  repository: Repository,
): Promise<void> {
  const target = parseAgentAuthReturnPath(returnPath);
  if (target?.type === "agent" && target.id === agentConnectionId) return;
  if (target?.type === "chat") {
    const chat = await repository.getChat(target.id);
    if (chat?.agentConnectionId === agentConnectionId) return;
  }
  throw new Error("OIDC return path is not allowed.");
}

function normalizeCallbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error("OIDC callback URL must use HTTPS outside local development.");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function validateDiscoveredEndpoints(configuration: oidc.Configuration, allowInsecure: boolean): void {
  const metadata = configuration.serverMetadata();
  for (const candidate of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.userinfo_endpoint,
    metadata.jwks_uri,
  ]) {
    if (candidate) assertOidcUrl(new URL(candidate), allowInsecure);
  }
}

function assertOidcUrl(url: URL, allowInsecure: boolean): void {
  if (url.username || url.password || url.hash) throw new Error("OIDC URLs must not contain userinfo or fragments.");
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error("OIDC URLs must use HTTPS.");
  }
  const hostname = url.hostname.toLowerCase();
  if (!allowInsecure && (isLoopbackHostname(hostname) || hostname.endsWith(".local") || isPrivateIp(hostname))) {
    throw new Error("OIDC URLs must not target loopback or private network addresses.");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "[::1]"
    || /^127\./.test(hostname);
}

function isPrivateIp(hostname: string): boolean {
  if (isIP(hostname) === 4) {
    return /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname);
  }
  if (isIP(hostname) === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
  }
  return false;
}

function safeOidcFetch(allowInsecure: boolean): oidc.CustomFetch {
  return async (url, init) => {
    assertOidcUrl(new URL(url), allowInsecure);
    return fetch(url, { ...init, body: init.body as BodyInit, redirect: "error" });
  };
}

function isInvalidGrant(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { error?: unknown; code?: unknown; cause?: { error?: unknown } };
  return candidate.error === "invalid_grant"
    || candidate.code === "invalid_grant"
    || candidate.cause?.error === "invalid_grant";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
