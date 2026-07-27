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
  type IdentitySession,
} from "@/identity/client";

type IdentityContextValue = {
  session: IdentitySession | null;
  getSession(force?: boolean): Promise<IdentitySession>;
  getCallerToken(projectId: string, returnPath: string): Promise<string>;
  switchRealm(returnPath: string): never;
  logout(): Promise<void>;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function IdentityProvider({
  baseUrl,
  returnTarget,
  children,
}: {
  baseUrl: string;
  returnTarget: string;
  children: ReactNode;
}): React.ReactElement {
  const client = useMemo(
    () => createEvelandIdentityClient({ baseUrl, returnTarget }),
    [baseUrl, returnTarget],
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
      getCallerToken,
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
