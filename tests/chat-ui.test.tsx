import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HandleMessageStreamEvent, SessionState } from "eve/client";

import { ChatThread, type ChatThreadSummary } from "@/components/chat-thread";
import { EVE_PROXY_CONTINUATION_TOKEN } from "@/eve/proxy-contract";

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

function chat(overrides: Partial<ChatThreadSummary & { sessionState: SessionState | null }> = {}) {
  return {
    id: "chat_rich",
    agentConnectionId: "agent_rich",
    agentName: "Research Eve",
    title: "Research thread",
    status: "active" as const,
    sessionState: {
      sessionId: "ses_1",
      streamIndex: 0,
    },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function ndjson(events: readonly unknown[]): Response {
  return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

describe("ChatThread with Eve and AI Elements", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    refreshMock.mockReset();
  });

  it("renders Eve text, files, reasoning, and completed tool calls from raw events", async () => {
    const events: HandleMessageStreamEvent[] = [
      {
        type: "message.received",
        data: {
          message: "Read this report",
          parts: [
            { type: "text", text: "Read this report" },
            {
              type: "file",
              filename: "report.pdf",
              mediaType: "application/pdf",
              size: 42,
              url: "https://files.example.com/report.pdf",
            },
          ],
          sequence: 1,
          turnId: "turn_1",
        },
      },
      { type: "step.started", data: { sequence: 2, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "reasoning.completed",
        data: {
          reasoning: "I should inspect the report before answering.",
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              kind: "tool-call",
              callId: "call_1",
              toolName: "read_report",
              input: { page: 1 },
            },
          ],
          sequence: 4,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "action.result",
        data: {
          result: {
            kind: "tool-result",
            callId: "call_1",
            toolName: "read_report",
            output: { summary: "Revenue increased." },
          },
          status: "completed",
          sequence: 5,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "message.completed",
        data: {
          message: "Revenue increased this quarter.",
          finishReason: "stop",
          sequence: 6,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "turn.completed", data: { sequence: 7, turnId: "turn_1" } },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: EVE_PROXY_CONTINUATION_TOKEN },
      },
    ];

    render(<ChatThread chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 8 } })} events={events} />);

    expect(screen.getByText("Read this report")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("Revenue increased this quarter.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Thought for a few seconds/i }));
    expect(await screen.findByText("I should inspect the report before answering.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /read_report/i }));
    expect(await screen.findByText('"Revenue increased."')).toBeInTheDocument();
  });

  it("submits a structured HITL option through the Eve continuation route", async () => {
    const events: HandleMessageStreamEvent[] = [
      { type: "step.started", data: { sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "actions.requested",
        data: {
          actions: [
            { kind: "tool-call", callId: "call_1", toolName: "delete_record", input: { id: 7 } },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_1",
              prompt: "Delete record 7?",
              display: "confirmation",
              options: [
                { id: "approve", label: "Allow", style: "primary" },
                { id: "deny", label: "Deny", style: "danger" },
              ],
              action: { kind: "tool-call", callId: "call_1", toolName: "delete_record", input: { id: 7 } },
            },
          ],
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: EVE_PROXY_CONTINUATION_TOKEN },
      },
    ];
    const resumedEvents = [
      {
        type: "action.result",
        data: {
          result: { kind: "tool-result", callId: "call_1", toolName: "delete_record", output: { deleted: true } },
          status: "completed",
          sequence: 4,
          stepIndex: 0,
          turnId: "turn_2",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: EVE_PROXY_CONTINUATION_TOKEN },
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "ses_1", continuationToken: "eve:2" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        }),
      )
      .mockResolvedValueOnce(ndjson(resumedEvents));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={events}
      />,
    );

    expect(screen.getByText("Delete record 7?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chats/chat_rich/agent/eve/v1/session/ses_1");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      continuationToken: EVE_PROXY_CONTINUATION_TOKEN,
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/chats/chat_rich/agent/eve/v1/session/ses_1/stream?startIndex=4",
    );
  });

  it("submits freeform HITL text through the same continuation contract", async () => {
    const events: HandleMessageStreamEvent[] = [
      { type: "step.started", data: { sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "actions.requested",
        data: {
          actions: [
            { kind: "tool-call", callId: "call_text", toolName: "ask_operator", input: {} },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_text",
              prompt: "What should I tell the operator?",
              display: "text",
              allowFreeform: true,
              action: { kind: "tool-call", callId: "call_text", toolName: "ask_operator", input: {} },
            },
          ],
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: EVE_PROXY_CONTINUATION_TOKEN },
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "ses_1",
            continuationToken: EVE_PROXY_CONTINUATION_TOKEN,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(ndjson([{ type: "session.waiting", data: { wait: "next-user-message" } }]));
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatThread chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })} events={events} />);

    fireEvent.change(screen.getByLabelText("Response"), { target: { value: "Proceed carefully" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      continuationToken: EVE_PROXY_CONTINUATION_TOKEN,
      inputResponses: [{ requestId: "req_text", text: "Proceed carefully" }],
    });
  });

  it("renders falsy tool outputs instead of dropping valid results", async () => {
    const events: HandleMessageStreamEvent[] = [
      { type: "step.started", data: { sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "actions.requested",
        data: {
          actions: [{ kind: "tool-call", callId: "call_count", toolName: "count_rows", input: {} }],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "action.result",
        data: {
          result: { kind: "tool-result", callId: "call_count", toolName: "count_rows", output: 0 },
          status: "completed",
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: EVE_PROXY_CONTINUATION_TOKEN },
      },
    ];

    render(<ChatThread chat={chat()} events={events} />);
    fireEvent.click(screen.getByRole("button", { name: /count_rows/i }));

    expect(await screen.findByText("0")).toBeInTheDocument();
  });

  it("sends a persisted pending first message after the chat route mounts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "ses_1", continuationToken: "eve:1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        }),
      )
      .mockResolvedValueOnce(
        ndjson([
          {
            type: "message.received",
            data: { message: "Hello Eve", sequence: 1, turnId: "turn_1" },
          },
          {
            type: "message.completed",
            data: {
              message: "Hello from Eve.",
              finishReason: "stop",
              sequence: 2,
              stepIndex: 0,
              turnId: "turn_1",
            },
          },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_pending", sessionState: null })}
        events={[]}
        pendingUserMessage="Hello Eve"
      />,
    );

    expect(await screen.findByText("Hello from Eve.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chats/chat_pending/agent/eve/v1/session");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ message: "Hello Eve" });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("sends persisted first-message attachments after the chat route mounts", async () => {
    const pendingMessage = [
      { type: "text" as const, text: "Review this" },
      {
        type: "file" as const,
        data: "data:text/plain;base64,aGVsbG8=",
        filename: "report.txt",
        mediaType: "text/plain",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "ses_1", continuationToken: "eve:1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        }),
      )
      .mockResolvedValueOnce(
        ndjson([{ type: "session.waiting", data: { wait: "next-user-message" } }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_pending_file", sessionState: null })}
        events={[]}
        pendingUserMessage={pendingMessage}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/chats/chat_pending_file/agent/eve/v1/session",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      message: pendingMessage,
    });
  });

  it("renders a pending first-message attachment before Eve confirms the turn", async () => {
    const pendingMessage = [
      { type: "text" as const, text: "Review this" },
      {
        type: "file" as const,
        data: "data:image/png;base64,aGVsbG8=",
        filename: "diagram.png",
        mediaType: "image/png",
      },
    ];
    let resolveSession!: (response: Response) => void;
    const sessionResponse = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => sessionResponse)
      .mockResolvedValueOnce(
        ndjson([
          {
            type: "message.received",
            data: {
              message: "Review this\n[file: diagram.png (image/png)]",
              parts: [
                { type: "text", text: "Review this" },
                {
                  type: "file",
                  filename: "diagram.png",
                  mediaType: "image/png",
                  url: "data:image/png;base64,aGVsbG8=",
                },
              ],
              sequence: 1,
              turnId: "turn_1",
            },
          },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_pending_preview", sessionState: null })}
        events={[]}
        pendingUserMessage={pendingMessage}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("img", { name: "diagram.png" })).toBeInTheDocument();

    resolveSession(
      new Response(JSON.stringify({ sessionId: "ses_1", continuationToken: "eve:1" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getAllByRole("img", { name: "diagram.png" })).toHaveLength(1),
    );
  });

  it("converts an attached file into Eve UserContent before sending", async () => {
    const file = new File(["hello"], "report.txt", { type: "text/plain" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "blob:report") {
        return new Response("hello", { headers: { "content-type": "text/plain" } });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "ses_1", continuationToken: "eve:1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        });
      }
      return ndjson([{ type: "session.waiting", data: { wait: "next-user-message" } }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatThread chat={chat({ id: "chat_file", sessionState: null })} events={[]} />);

    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Review this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) =>
          String(input).endsWith("/api/chats/chat_file/agent/eve/v1/session") && init?.method === "POST",
        ),
      ).toBe(true),
    );
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/api/chats/chat_file/agent/eve/v1/session") && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      message: [
        { type: "text", text: "Review this" },
        {
          type: "file",
          data: "data:text/plain;base64,aGVsbG8=",
          filename: "report.txt",
          mediaType: "text/plain",
        },
      ],
    });
  });

  it("requests authenticated cooperative cancellation when stopping a turn", async () => {
    const getCallerToken = vi.fn(async () => "caller-token");
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/cancel")) {
          return Response.json({
            ok: true,
            sessionId: "ses_1",
            status: "accepted",
          });
        }
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "ses_1", continuationToken: EVE_PROXY_CONTINUATION_TOKEN },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  type: "message.appended",
                  data: {
                    messageDelta: "Working",
                    messageSoFar: "Working",
                    sequence: 1,
                    stepIndex: 0,
                    turnId: "turn_1",
                  },
                })}\n`,
              ),
            );
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        });
        return new Response(body, {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 0 } })}
        events={[]}
        getCallerToken={getCallerToken}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Start a long task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop generating" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith("/cancel")),
      ).toBe(true),
    );
    const cancelCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/cancel"),
    );
    expect(cancelCall?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer caller-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
  });

  it("retries the original turn with a Caller Token after an Eveland route challenge", async () => {
    const challenge =
      'Bearer realm="eveland", authorization_uri="https://identity.example.com/identity/login", project_id="project_support", display_name="Eveland"';
    const getAccessToken = vi.fn(async () => "app-token");
    const getCallerToken = vi.fn(async () => "caller-token");
    const respondToAuthenticationChallenge = vi.fn(
      async (header: string | null) => {
        expect(header).toBe(challenge);
        return "caller-token";
      },
    );
    const seenAuthorization: Array<string | null> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const authorization = new Headers(init.headers).get("authorization");
          seenAuthorization.push(authorization);
          if (authorization === "Bearer app-token") {
            return Response.json(
              {
                code: "authentication_required",
                error: "Eveland authentication is required.",
              },
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
            {
              sessionId: "ses_authenticated",
              continuationToken: EVE_PROXY_CONTINUATION_TOKEN,
            },
            { headers: { "x-eve-session-id": "ses_authenticated" } },
          );
        }
        return ndjson([
          {
            type: "session.waiting",
            data: { wait: "next-user-message" },
          },
        ]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_auth", sessionState: null })}
        events={[]}
        pendingUserMessage="Authenticate me"
        getAccessToken={getAccessToken}
        getCallerToken={getCallerToken}
        respondToAuthenticationChallenge={respondToAuthenticationChallenge}
      />,
    );

    await waitFor(() => expect(seenAuthorization).toHaveLength(2));
    expect(seenAuthorization).toEqual([
      "Bearer app-token",
      "Bearer caller-token",
    ]);
    expect(respondToAuthenticationChallenge).toHaveBeenCalledTimes(1);
    expect(getCallerToken).toHaveBeenCalled();
  });

  it("does not repeat the Eveland authentication flow when the Caller Token is rejected", async () => {
    const challenge =
      'Bearer realm="eveland", authorization_uri="https://identity.example.com/identity/login", project_id="project_support", display_name="Eveland"';
    const respondToAuthenticationChallenge = vi
      .fn<(header: string | null) => Promise<string | null>>()
      .mockResolvedValueOnce("caller-token")
      .mockResolvedValueOnce(null);
    const seenAuthorization: Array<string | null> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          seenAuthorization.push(
            new Headers(init.headers).get("authorization"),
          );
          return Response.json(
            {
              code: "authentication_required",
              error: "Eveland authentication is required.",
            },
            {
              status: 401,
              headers: {
                "cache-control": "no-store",
                "www-authenticate": challenge,
              },
            },
          );
        }
        return ndjson([]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_rejected_caller", sessionState: null })}
        events={[]}
        pendingUserMessage="Authenticate me once"
        getAccessToken={async () => "app-token"}
        getCallerToken={async () => "caller-token"}
        respondToAuthenticationChallenge={respondToAuthenticationChallenge}
      />,
    );

    await screen.findByRole("alert");
    expect(seenAuthorization).toEqual([
      "Bearer app-token",
      "Bearer caller-token",
    ]);
    expect(respondToAuthenticationChallenge).toHaveBeenCalledTimes(1);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("renders connection authorization challenges without exposing credentials", () => {
    const events: HandleMessageStreamEvent[] = [
      { type: "step.started", data: { sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "authorization.required",
        data: {
          name: "notion",
          description: "Connect Notion to continue.",
          authorization: {
            displayName: "Notion",
            url: "https://auth.example.com/notion",
            userCode: "ABCD-1234",
          },
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
    ];

    render(<ChatThread chat={chat()} events={events} />);

    expect(screen.getByText("Connect Notion to continue.")).toBeInTheDocument();
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Authorize Notion" })).toHaveAttribute(
      "href",
      "https://auth.example.com/notion",
    );
  });

  it("keeps failed chats retryable while completed chats stay read-only", () => {
    const { rerender } = render(<ChatThread chat={chat({ status: "failed" })} events={[]} />);

    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();

    rerender(<ChatThread chat={chat({ status: "completed" })} events={[]} />);
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });
});
