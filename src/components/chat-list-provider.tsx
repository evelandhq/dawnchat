"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useEvelandIdentity } from "@/components/identity-provider";

export type ChatListItem = {
  id: string;
  agentConnectionId: string;
  agentName: string;
  evelandProjectId: string | null;
  title: string;
  lastMessage: string | null;
};

export type ChatListState = {
  status: "loading" | "ready" | "error";
  /**
   * The last list that loaded, kept across a later failure so identity
   * navigation and transient errors do not blank the navigation.
   */
  chats: ChatListItem[] | null;
  authenticated: boolean;
  error: unknown;
};

type ChatListContextValue = {
  state: ChatListState;
  /** Re-reads the list, sharing one request with any concurrent reader. */
  refresh(): Promise<void>;
};

const ChatListContext = createContext<ChatListContextValue | null>(null);

const INITIAL_STATE: ChatListState = {
  status: "loading",
  chats: null,
  authenticated: false,
  error: null,
};

/**
 * Owns the single `/api/chats` read the whole app shares. The sidebar, the home
 * redirect, the Agent Catalog, and an Agent's entry page all render from the
 * same identity-scoped list, so one navigation costs one request instead of one
 * per component.
 */
export function ChatListProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const { getAppToken, getSession } = useEvelandIdentity();
  const [state, setState] = useState<ChatListState>(INITIAL_STATE);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const pending = inFlight.current;
    if (pending) return pending;

    const request = (async () => {
      try {
        const session = await getSession();
        const token = session.authenticated ? await getAppToken(pathname) : null;
        const response = await fetch("/api/chats", {
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
          cache: "no-store",
        });
        if (!response.ok) throw await chatListError(response);
        const body = (await response.json()) as { chats?: ChatListItem[] };
        if (mounted.current) {
          setState({
            status: "ready",
            chats: body.chats ?? [],
            authenticated: session.authenticated,
            error: null,
          });
        }
      } catch (error) {
        if (mounted.current) {
          setState((current) => ({ ...current, status: "error", error }));
        }
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  }, [getAppToken, getSession, pathname]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ChatListContext.Provider value={{ state, refresh }}>
      {children}
    </ChatListContext.Provider>
  );
}

export function useChatList(): ChatListContextValue {
  const value = useContext(ChatListContext);
  if (!value) {
    throw new Error("useChatList must be used inside ChatListProvider");
  }
  return value;
}

async function chatListError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | null;
  return new Error(
    typeof body?.error === "string"
      ? body.error
      : "Unable to load conversations.",
  );
}
