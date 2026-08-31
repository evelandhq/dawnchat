import React, { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClientSessionState } from "eve/client";

import { ChatThread, type ChatThreadSummary } from "@/components/chat-thread";
import type { PendingInputState } from "@/eve/proxy-contract";

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

function chat(
  overrides: Partial<
    ChatThreadSummary & { sessionState: ClientSessionState | null }
  > = {},
) {
  return {
    id: "chat_strict",
    agentConnectionId: "agent_strict",
    agentName: "Research Eve",
    title: "Research thread",
    status: "active" as const,
    sessionState: { sessionId: "ses_1", streamIndex: 0 },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function ndjson(events: readonly unknown[]): Response {
  return new Response(
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    },
  );
}

const EMPTY_PENDING: PendingInputState = { batches: [] };

/** Resolves after `ms`, or rejects the way real fetch does when aborted. */
function abortableDelay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) {
      fail();
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      fail();
    });
  });
}

const challenge =
  'Bearer realm="eveland", authorization_uri="https://identity.example.com/api/identity/login", project_id="project_support", display_name="Eveland"';

/**
 * Unlike the mocks in chat-ui.test.tsx, this one honors `init.signal` the way
 * a real browser does. The eve store's unmount detach aborts an in-flight
 * turn, and StrictMode's simulated remount runs that detach right after the
 * challenge remount's first effects pass — the exact combination that used to
 * swallow the first message after every page load in `next dev`.
 */
function challengeFetchMock(seenAuthorization: Array<string | null>) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(_input);
    if (url.endsWith("/pending-input")) {
      return Response.json({ pendingInput: EMPTY_PENDING });
    }
    if (init?.method === "POST") {
      await abortableDelay(15, init.signal);
      const authorization = new Headers(init.headers).get("authorization");
      seenAuthorization.push(authorization);
      if (authorization === "Bearer app-token") {
        return Response.json(
          { code: "authentication_required", error: "auth required" },
          {
            status: 401,
            headers: {
              "cache-control": "no-store",
              "www-authenticate": challenge,
            },
          },
        );
      }
      return Response.json(
        { sessionId: "ses_authenticated" },
        { headers: { "x-eve-session-id": "ses_authenticated" } },
      );
    }
    return ndjson([
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]);
  });
}

describe("ChatThread challenge retry under StrictMode (next dev parity)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    refreshMock.mockReset();
  });

  it("retries the challenged pending first message under StrictMode", async () => {
    const seenAuthorization: Array<string | null> = [];
    vi.stubGlobal("fetch", challengeFetchMock(seenAuthorization));

    render(
      <StrictMode>
        <ChatThread
          chat={chat({ sessionState: null })}
          events={[]}
          pendingInput={EMPTY_PENDING}
          pendingUserMessage="Authenticate me"
          getAccessToken={async () => "app-token"}
          getCallerToken={async () => "caller-token"}
          respondToAuthenticationChallenge={async () => "caller-token"}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(seenAuthorization).toHaveLength(2), {
      timeout: 3000,
    });
    expect(seenAuthorization).toEqual([
      "Bearer app-token",
      "Bearer caller-token",
    ]);
  });

  it("retries a challenged composer message under StrictMode", async () => {
    const seenAuthorization: Array<string | null> = [];
    vi.stubGlobal("fetch", challengeFetchMock(seenAuthorization));

    render(
      <StrictMode>
        <ChatThread
          chat={chat({ sessionState: null })}
          events={[]}
          pendingInput={EMPTY_PENDING}
          getAccessToken={async () => "app-token"}
          getCallerToken={async () => "caller-token"}
          respondToAuthenticationChallenge={async () => "caller-token"}
        />
      </StrictMode>,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "First message after load" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(seenAuthorization).toHaveLength(2), {
      timeout: 3000,
    });
    expect(seenAuthorization).toEqual([
      "Bearer app-token",
      "Bearer caller-token",
    ]);
  });
});
