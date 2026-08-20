"use client";

import { useEffect, useState } from "react";
import type { UserContent } from "ai";
import { CircleAlert } from "lucide-react";

import {
  ChatThread,
  type ChatThreadSummary,
} from "@/components/chat-thread";
import { useChatList } from "@/components/chat-list-provider";
import { useEvelandIdentity } from "@/components/identity-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  EMPTY_PENDING_INPUT,
  type ChatEvent,
  type PendingInputState,
} from "@/eve/proxy-contract";
import { EvelandIdentityError } from "@/identity/client";

type ChatPayload = {
  chat: ChatThreadSummary & {
    evelandProjectId: string | null;
    pendingUserMessage: UserContent | null;
    pendingInput?: PendingInputState;
  };
  events: ChatEvent[];
};

export function AuthenticatedChatThread({
  chatId,
}: {
  chatId: string;
}): React.ReactElement {
  const {
    getAppToken,
    getCallerToken,
    getCatalog,
    getSession,
    respondToAuthenticationChallenge,
    switchRealm,
  } = useEvelandIdentity();
  const returnPath = `/chats/${chatId}`;
  const { refresh: refreshChatList } = useChatList();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { kind: "loading" }
    | {
        kind: "ready";
        data: ChatPayload;
        available: boolean;
        authenticated: boolean;
      }
    | { kind: "forbidden"; message: string }
    | { kind: "missing" }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await getSession();
        const token = session.authenticated
          ? await getAppToken(returnPath)
          : null;
        const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
          ...(token
            ? { headers: { authorization: `Bearer ${token}` } }
            : {}),
          cache: "no-store",
        });
        if (response.status === 404) {
          if (active) setState({ kind: "missing" });
          return;
        }
        if (!response.ok) throw await apiError(response);
        const data = (await response.json()) as ChatPayload;
        // Only a managed chat consults the Catalog — getCatalog starts login
        // on 401, which an anonymous chat must never do.
        const evelandProjectId = data.chat.evelandProjectId;
        const catalog = evelandProjectId ? await getCatalog(returnPath) : null;
        if (active) {
          setState({
            kind: "ready",
            data,
            authenticated: session.authenticated,
            available:
              !evelandProjectId ||
              Boolean(
                catalog?.agents.some(
                  (agent) => agent.projectId === evelandProjectId,
                ),
              ),
          });
        }
      } catch (error) {
        if (
          !active ||
          (error instanceof EvelandIdentityError &&
            error.code === "identity_redirecting")
        ) {
          return;
        }
        if (error instanceof EvelandIdentityError && error.status === 403) {
          setState({ kind: "forbidden", message: error.message });
        } else {
          setState({
            kind: "error",
            message:
              error instanceof Error ? error.message : "Unable to load this chat.",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [
    attempt,
    chatId,
    getAppToken,
    getCatalog,
    getSession,
    returnPath,
  ]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading conversation…
      </div>
    );
  }
  if (state.kind === "missing") {
    return (
      <CenteredAlert
        title="Chat not found"
        message="This conversation does not exist or belongs to another identity scope."
      />
    );
  }
  if (state.kind === "forbidden") {
    return (
      <div className="mx-auto w-full max-w-xl p-6">
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Eveland rejected access to this chat</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{state.message}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => switchRealm(returnPath)}
            >
              Switch identity scope
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mx-auto w-full max-w-xl p-6">
        <Alert>
          <CircleAlert />
          <AlertTitle>Unable to load chat</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{state.message}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setState({ kind: "loading" });
                setAttempt((current) => current + 1);
              }}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!state.available ? (
        <Alert className="m-4 mb-0">
          <CircleAlert />
          <AlertTitle>This Agent is currently unavailable</AlertTitle>
          <AlertDescription>
            Your conversation history is preserved, but new messages are disabled.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="min-h-0 flex-1">
        <ChatThread
          chat={state.data.chat}
          events={state.data.events}
          pendingInput={state.data.chat.pendingInput ?? EMPTY_PENDING_INPUT}
          pendingUserMessage={state.data.chat.pendingUserMessage}
          readOnly={!state.available}
          getAccessToken={
            state.authenticated
              ? () => getAppToken(returnPath)
              : undefined
          }
          getCallerToken={
            state.data.chat.evelandProjectId
              ? () => {
                  const projectId = state.data.chat.evelandProjectId!;
                  return getCallerToken(projectId, returnPath);
                }
              : undefined
          }
          respondToAuthenticationChallenge={
            state.data.chat.evelandProjectId
              ? (header) =>
                  respondToAuthenticationChallenge(
                    header,
                    state.data.chat.evelandProjectId!,
                    returnPath,
                  )
              : undefined
          }
          // A finished turn changes the chat's title and preview, nothing the
          // server render owns.
          onTurnFinished={() => void refreshChatList()}
        />
      </div>
    </div>
  );
}

function CenteredAlert({
  title,
  message,
}: {
  title: string;
  message: string;
}): React.ReactElement {
  return (
    <div className="mx-auto w-full max-w-xl p-6">
      <Alert>
        <CircleAlert />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
}

async function apiError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | null;
  return new Error(
    typeof body?.error === "string" ? body.error : "Unable to load this chat.",
  );
}
