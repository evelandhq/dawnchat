"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  createEvelandIdentityClient,
  type IdentityCatalog,
  type IdentityLoginAvailability,
  type IdentitySession,
} from "@/identity/client";

type IdentityContextValue = {
  session: IdentitySession | null;
  getSession(force?: boolean): Promise<IdentitySession>;
  getCatalog(returnPath?: string): Promise<IdentityCatalog>;
  getAppToken(returnPath?: string): Promise<string>;
  getCallerToken(projectId: string, returnPath: string): Promise<string>;
  getLoginAvailability(returnPath?: string): Promise<IdentityLoginAvailability>;
  respondToAuthenticationChallenge(
    header: string | null,
    expectedProjectId: string,
    returnPath: string,
  ): Promise<string | null>;
  login(returnPath: string): never;
  switchRealm(returnPath: string): never;
  logout(): Promise<void>;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function IdentityProvider({
  baseUrl,
  requestBaseUrl,
  returnTarget,
  children,
}: {
  baseUrl: string;
  requestBaseUrl?: string;
  returnTarget: string;
  children: ReactNode;
}): React.ReactElement {
  const client = useMemo(
    () =>
      createEvelandIdentityClient({
        baseUrl,
        requestBaseUrl,
        returnTarget,
      }),
    [baseUrl, requestBaseUrl, returnTarget],
  );
  const [session, setSession] = useState<IdentitySession | null>(null);
  const getSession = useCallback(
    async (force = false) => {
      const next = await client.getSession(force);
      setSession(next);
      return next;
    },
    [client],
  );
  const getCallerToken = useCallback(
    async (projectId: string, returnPath: string) => {
      const token = await client.getCallerToken(projectId, returnPath);
      const resolvedSession = await client.getSession();
      setSession(resolvedSession);
      return token;
    },
    [client],
  );

  const value = useMemo<IdentityContextValue>(
    () => ({
      session,
      getSession,
      getCatalog: client.getCatalog,
      getAppToken: client.getAppToken,
      getCallerToken,
      respondToAuthenticationChallenge:
        client.respondToAuthenticationChallenge,
      getLoginAvailability: client.getLoginAvailability,
      login: client.login,
      switchRealm: client.switchRealm,
      async logout() {
        await client.logout();
        setSession({ authenticated: false });
      },
    }),
    [client, getCallerToken, getSession, session],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useEvelandIdentity(): IdentityContextValue {
  const value = useContext(IdentityContext);
  if (!value) {
    throw new Error("useEvelandIdentity must be used inside IdentityProvider");
  }
  return value;
}
