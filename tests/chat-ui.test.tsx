import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClientSessionState, MessageStreamEvent } from "eve/client";

import { ChatThread, type ChatThreadSummary } from "@/components/chat-thread";
import type { ChatEvent, PendingInputState } from "@/eve/proxy-contract";

const onTurnFinished = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

/** One stream event as an Agent emits it, before Eve stamps `meta` onto it. */
type UnstampedEvent<TEvent = MessageStreamEvent> = TEvent extends unknown
  ? Omit<TEvent, "meta">
  : never;

/**
 * Supported v23 events carry an emission time and sortable id. Fixtures spell
 * the payload; this adds the envelope the reducer deduplicates on.
 */
function stampEvents(events: readonly UnstampedEvent[]): MessageStreamEvent[] {
  return events.map(
    (event, index) =>
      ({
        ...event,
        meta: { at: new Date(index * 1000).toISOString(), id: `evt_${index + 1}` },
      }) as MessageStreamEvent,
  );
}

function chat(overrides: Partial<ChatThreadSummary & { sessionState: ClientSessionState | null }> = {}) {
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

const EMPTY_PENDING: PendingInputState = { batches: [] };

/** Ledger fixture: what the proxy says Eve is still parked on. */
function pendingBatches(
  ...batches: Array<{
    requests: Array<{ requestId: string; kind: string }>;
    answered?: string[];
  }>
): PendingInputState {
  return {
    batches: batches.map((batch, index) => ({
      eventIndex: index + 1,
      requests: batch.requests,
      answered: batch.answered ?? [],
    })),
  };
}

function pendingInputResponse(state: PendingInputState = EMPTY_PENDING): Response {
  return Response.json({ pendingInput: state });
}

const isPendingInputCall = (call: readonly unknown[]): boolean =>
  String(call[0]).includes("/pending-input");

describe("ChatThread with Eve and AI Elements", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    onTurnFinished.mockReset();
    window.sessionStorage.clear();
  });

  it("renders Eve text, files, reasoning, and completed tool calls from raw events", async () => {
    const events = stampEvents([
      {
        type: "message.received",
        data: {
          message: "Read this report",
          parts: [
            { type: "text", text: "Read this report" },
            {
              type: "file",
              filename: "1.docx",
              mediaType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: 42,
              url: "https://files.example.com/1.docx",
            },
          ],
          sequence: 1,
          turnId: "turn_1",
        },
      },
      { type: "step.started", data: { modelId: "fake/model", sequence: 2, stepIndex: 0, turnId: "turn_1" } },
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
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 8 } })}
        events={events}
        pendingInput={EMPTY_PENDING}
      />,
    );

    expect(screen.getByText("Read this report")).toBeInTheDocument();
    expect(screen.getByText("1.docx")).toBeInTheDocument();
    const mediaType = screen.getByText(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mediaType.parentElement?.parentElement).toHaveClass(
      "h-auto",
      "max-w-full",
      "py-1.5",
    );
    expect(screen.getByText("Revenue increased this quarter.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Thought for a few seconds/i }));
    expect(await screen.findByText("I should inspect the report before answering.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /read_report/i }));
    expect(await screen.findByText('"Revenue increased."')).toBeInTheDocument();
  });

  it("submits a structured HITL option through the Eve continuation route", async () => {
    const events = stampEvents([
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
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
              kind: "tool-approval",
              prompt: "Delete record 7?",
              display: "confirmation",
              options: [
                { id: "approve", label: "Allow", style: "primary" },
                { id: "cancel", label: "Cancel", style: "danger" },
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
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
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
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "ses_1" }), {
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
        pendingInput={pendingBatches({
          requests: [{ requestId: "req_1", kind: "tool-approval" }],
        })}
      />,
    );

    expect(screen.getByText("Delete record 7?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    const turnCalls = () =>
      fetchMock.mock.calls.filter((call) => !isPendingInputCall(call));
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    expect(turnCalls()[0]?.[0]).toBe("/api/chats/chat_rich/agent/eve/v1/session/ses_1");
    expect(JSON.parse(String(turnCalls()[0]?.[1]?.body))).toEqual({
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    });
    expect(turnCalls()[1]?.[0]).toBe(
      "/api/chats/chat_rich/agent/eve/v1/session/ses_1/stream?startIndex=4",
    );
  });

  it("holds a multi-question batch until every question is answered", async () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_metric",
              kind: "question",
              prompt: "Which paid-user metric?",
              display: "select",
              options: [
                { id: "subscription", label: "Subscribers" },
                {
                  id: "gmv_payors",
                  label: "Payors",
                  description: "Count unique accounts that completed a payment.",
                },
              ],
              action: {
                kind: "tool-call",
                callId: "call_metric",
                toolName: "ask_question",
                input: {},
              },
            },
            {
              requestId: "call_baseline",
              kind: "question",
              prompt: "Which comparison baseline?",
              display: "select",
              options: [
                { id: "full_last_month", label: "Whole last month" },
                { id: "same_period", label: "Same period last month" },
              ],
              action: {
                kind: "tool-call",
                callId: "call_baseline",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "turn.completed", data: { sequence: 3, turnId: "turn_1" } },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "ses_1" }), {
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
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 5 } })}
        events={events}
        pendingInput={pendingBatches({
          requests: [
            { requestId: "call_metric", kind: "question" },
            { requestId: "call_baseline", kind: "question" },
          ],
        })}
      />,
    );

    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Payors" })).toHaveClass("w-full");
    expect(
      screen.getByText("Count unique accounts that completed a payment."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Same period last month" }));
    expect(await screen.findByText(/Selected: Same period last month/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    // A draft is revisable until the batch goes out.
    expect(screen.getByRole("button", { name: "Same period last month" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Whole last month" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Payors" }));

    const turnCalls = () =>
      fetchMock.mock.calls.filter((call) => !isPendingInputCall(call));
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    expect(JSON.parse(String(turnCalls()[0]?.[1]?.body))).toEqual({
      inputResponses: [
        { requestId: "call_metric", optionId: "gmv_payors" },
        { requestId: "call_baseline", optionId: "same_period" },
      ],
    });
  });

  it("keeps a rejected batch answerable instead of stranding it", async () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_metric",
              kind: "question",
              prompt: "Which paid-user metric?",
              display: "select",
              options: [
                { id: "subscription", label: "Subscribers" },
                { id: "gmv_payors", label: "Payors" },
              ],
              action: {
                kind: "tool-call",
                callId: "call_metric",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    // The store projects the answer before it posts and never rolls that back.
    // The refetched ledger — where the batch is still open — is what puts the
    // controls back on screen with the drafts intact.
    const openBatch = pendingBatches({
      requests: [{ requestId: "call_metric", kind: "question" }],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (isPendingInputCall([input])) {
        return pendingInputResponse(openBatch);
      }
      return new Response(JSON.stringify({ error: "Unable to reach Eve agent" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={events}
        pendingInput={openBatch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Payors" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Subscribers" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Payors" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(fetchMock.mock.calls.some((call) => isPendingInputCall(call))).toBe(true);
  });

  it("unlocks a chat whose stored stream never recorded the resuming turn", () => {
    const streamed = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_metric",
              kind: "question",
              prompt: "Which paid-user metric?",
              display: "select",
              options: [{ id: "gmv_payors", label: "Payors" }],
              action: {
                kind: "tool-call",
                callId: "call_metric",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    // The proxy stores the answer when it forwards the turn, but the stream is
    // persisted as the browser reads it — a tab closed on the click records the
    // answer and never the `turn.started` that resumed the session.
    const events: ChatEvent[] = [
      ...streamed,
      {
        type: "client.input.responded",
        data: {
          createdAt: 1_760_000_000_000,
          responses: [{ requestId: "call_metric", optionId: "gmv_payors" }],
        },
      },
    ];

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={events}
        pendingInput={EMPTY_PENDING}
      />,
    );

    expect(screen.getByLabelText("Message")).toBeEnabled();
  });

  it("keeps a partly answered approval batch answerable across another turn", () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_delete",
              kind: "tool-approval",
              prompt: "Delete record 7?",
              display: "confirmation",
              options: [
                { id: "approve", label: "Allow", style: "primary" },
                { id: "cancel", label: "Cancel", style: "danger" },
              ],
              action: {
                kind: "tool-call",
                callId: "call_delete",
                toolName: "delete_record",
                input: { id: 7 },
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
      // Eve re-parks a required batch behind a fresh turn preamble, so
      // `turn.started` alone cannot mean the approval was resolved.
      { type: "turn.started", data: { sequence: 3, turnId: "turn_2" } },
      { type: "turn.completed", data: { sequence: 3, turnId: "turn_2" } },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 6 } })}
        events={events}
        pendingInput={pendingBatches({
          requests: [{ requestId: "call_delete", kind: "tool-approval" }],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByLabelText("Message")).toBeEnabled();
  });

  it("reopens the composer for a replayed batch Eve is no longer parked on", () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_metric",
              kind: "question",
              prompt: "Which paid-user metric?",
              display: "select",
              options: [{ id: "subscription", label: "Subscribers" }],
              action: {
                kind: "tool-call",
                callId: "call_metric",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "turn.completed", data: { sequence: 3, turnId: "turn_1" } },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
      // Answering the batch starts a new turn; Eve never marks the question
      // itself resolved, so the stored part stays `approval-requested`.
      { type: "turn.started", data: { sequence: 4, turnId: "turn_2" } },
      {
        type: "message.completed",
        data: {
          message: "Subscribers grew 12%.",
          finishReason: "stop",
          sequence: 5,
          stepIndex: 0,
          turnId: "turn_2",
        },
      },
      { type: "turn.completed", data: { sequence: 6, turnId: "turn_2" } },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 10 } })}
        events={events}
        pendingInput={EMPTY_PENDING}
      />,
    );

    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Subscribers" })).not.toBeInTheDocument();
    // Nothing recorded the answer, so the card must not claim one.
    expect(screen.getByText("Dismissed")).toBeInTheDocument();
    expect(screen.queryByText("Responded")).not.toBeInTheDocument();
  });

  it("replays the option a stored response picked", async () => {
    const streamed = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_metric",
              kind: "question",
              prompt: "Which paid-user metric?",
              display: "select",
              options: [
                { id: "subscription", label: "Subscribers" },
                { id: "gmv_payors", label: "Payors" },
              ],
              action: {
                kind: "tool-call",
                callId: "call_metric",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
      { type: "turn.started", data: { sequence: 3, turnId: "turn_2" } },
    ]);
    // The proxy records the answer between the parked turn and the one it starts.
    const events: ChatEvent[] = [
      ...streamed.slice(0, 4),
      {
        type: "client.input.responded",
        data: {
          createdAt: 1_760_000_000_000,
          responses: [{ requestId: "call_metric", optionId: "gmv_payors" }],
        },
      },
      ...streamed.slice(4),
    ];

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 6 } })}
        events={events}
        pendingInput={EMPTY_PENDING}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /ask_question/i }));

    expect(await screen.findByText(/Responded: Payors/)).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeEnabled();
  });

  it("submits freeform HITL text through the same continuation contract", async () => {
    const events = stampEvents([
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
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
              kind: "question",
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
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "ses_1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(ndjson([{ type: "session.waiting", data: { wait: "next-user-message" } }]));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={events}
        pendingInput={pendingBatches({
          requests: [{ requestId: "req_text", kind: "question" }],
        })}
      />,
    );

    const response = screen.getByLabelText("Response");
    expect(response.tagName).toBe("TEXTAREA");
    fireEvent.change(response, { target: { value: "Proceed carefully" } });
    fireEvent.keyDown(response, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(response, { key: "Enter" });

    const turnCalls = () =>
      fetchMock.mock.calls.filter((call) => !isPendingInputCall(call));
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    expect(JSON.parse(String(turnCalls()[0]?.[1]?.body))).toEqual({
      inputResponses: [{ requestId: "req_text", text: "Proceed carefully" }],
    });
  });

  it("renders falsy tool outputs instead of dropping valid results", async () => {
    const events = stampEvents([
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
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
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);

    render(<ChatThread chat={chat()} events={events} pendingInput={EMPTY_PENDING} />);
    fireEvent.click(screen.getByRole("button", { name: /count_rows/i }));

    expect(await screen.findByText("0")).toBeInTheDocument();
  });

  it("sends a persisted pending first message after the chat route mounts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "ses_1" }), {
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
        pendingInput={EMPTY_PENDING}
        pendingUserMessage="Hello Eve"
        onTurnFinished={onTurnFinished}
      />,
    );

    expect(await screen.findByText("Hello from Eve.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chats/chat_pending/agent/eve/v1/session");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ message: "Hello Eve" });
    await waitFor(() => expect(onTurnFinished).toHaveBeenCalledTimes(1));
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
        new Response(JSON.stringify({ sessionId: "ses_1" }), {
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
        pendingInput={EMPTY_PENDING}
        pendingUserMessage={pendingMessage}
      />,
    );

    const turnCalls = () =>
      fetchMock.mock.calls.filter((call) => !isPendingInputCall(call));
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    expect(turnCalls()[0]?.[0]).toBe(
      "/api/chats/chat_pending_file/agent/eve/v1/session",
    );
    expect(JSON.parse(String(turnCalls()[0]?.[1]?.body))).toEqual({
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
        pendingInput={EMPTY_PENDING}
        pendingUserMessage={pendingMessage}
      />,
    );

    const turnCalls = () =>
      fetchMock.mock.calls.filter((call) => !isPendingInputCall(call));
    await waitFor(() => expect(turnCalls()).toHaveLength(1));
    expect(screen.getByRole("img", { name: "diagram.png" })).toBeInTheDocument();

    resolveSession(
      new Response(JSON.stringify({ sessionId: "ses_1" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
      }),
    );
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
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
        return new Response(JSON.stringify({ sessionId: "ses_1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        });
      }
      return ndjson([{ type: "session.waiting", data: { wait: "next-user-message" } }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_file", sessionState: null })}
        events={[]}
        pendingInput={EMPTY_PENDING}
      />,
    );

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

  it("cancels the exact durable turn, authenticated like every other request", async () => {
    // The binding's durable cancel waits for the turn's `turn.started`, POSTs
    // `{ turnId }` to the
    // session cancel route under the same auth as sends, and keeps the stream
    // attached — an unattributed cancel body is no longer possible.
    const getAccessToken = vi.fn(async () => "app-token");
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/pending-input")) {
          return pendingInputResponse();
        }
        if (url.endsWith("/cancel")) {
          return Response.json({
            ok: true,
            sessionId: "ses_1",
            status: "accepted",
          });
        }
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "ses_1" },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of [
              { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
              {
                type: "message.appended",
                data: {
                  messageDelta: "Working",
                  messageSoFar: "Working",
                  sequence: 2,
                  stepIndex: 0,
                  turnId: "turn_1",
                },
              },
            ]) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
            }
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
        pendingInput={EMPTY_PENDING}
        getAccessToken={getAccessToken}
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
    expect(cancelCall?.[1]?.method).toBe("POST");
    const cancelHeaders = new Headers(cancelCall?.[1]?.headers);
    expect(cancelHeaders.get("authorization")).toBe("Bearer app-token");
    expect(cancelHeaders.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(cancelCall?.[1]?.body))).toEqual({ turnId: "turn_1" });
    // Whatever the cancel did server-side, the thread re-reads the ledger.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => isPendingInputCall(call))).toBe(true),
    );
  });

  it("names the running turn when stopping, leaving other parks alone", async () => {
    const getCallerToken = vi.fn().mockResolvedValue("caller-token");
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/pending-input")) return pendingInputResponse();
        if (url.endsWith("/cancel")) return Response.json({ ok: true, status: "accepted" });
        if (!url.includes("/stream")) {
          return Response.json(
            { sessionId: "ses_1" },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // The park an earlier turn raised is still open; only `turn_7`
            // is running, and only its parks may go with it.
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({ type: "turn.started", data: { sequence: 1, turnId: "turn_7" } })}\n`,
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
        pendingInput={EMPTY_PENDING}
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
    expect(JSON.parse(String(cancelCall?.[1]?.body))).toEqual({ turnId: "turn_7" });
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
            { sessionId: "ses_authenticated" },
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
        pendingInput={EMPTY_PENDING}
        pendingUserMessage="Authenticate me"
        getAccessToken={getAccessToken}
        getCallerToken={getCallerToken}
        respondToAuthenticationChallenge={respondToAuthenticationChallenge}
        onTurnFinished={onTurnFinished}
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
        pendingInput={EMPTY_PENDING}
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
    expect(onTurnFinished).not.toHaveBeenCalled();
  });

  it("renders connection authorization challenges without exposing credentials", () => {
    const events = stampEvents([
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
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
    ]);

    render(<ChatThread chat={chat()} events={events} pendingInput={EMPTY_PENDING} />);

    expect(screen.getByText("Connect Notion to continue.")).toBeInTheDocument();
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Authorize Notion" })).toHaveAttribute(
      "href",
      "https://auth.example.com/notion",
    );
  });

  it("keeps failed chats retryable while completed chats stay read-only", () => {
    const { rerender } = render(
      <ChatThread chat={chat({ status: "failed" })} events={[]} pendingInput={EMPTY_PENDING} />,
    );

    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();

    rerender(
      <ChatThread chat={chat({ status: "completed" })} events={[]} pendingInput={EMPTY_PENDING} />,
    );
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("shows the upstream Eve error id when session creation fails", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (isPendingInputCall([input])) return pendingInputResponse();
        if (init?.method === "POST") {
          return Response.json(
            {
              error:
                "Failed to create the session. Error ID: err_session_create_123",
              errorId: "err_session_create_123",
              ok: false,
            },
            { status: 500 },
          );
        }
        return ndjson([]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_failed_create", sessionState: null })}
        events={[]}
        pendingInput={EMPTY_PENDING}
        pendingUserMessage="Start analysis"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to create the session. Error ID: err_session_create_123",
    );
  });

  it("shows the error id when an accepted session fails in the stream", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (isPendingInputCall([input])) return pendingInputResponse();
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "ses_stream_failed" },
            {
              status: 202,
              headers: { "x-eve-session-id": "ses_stream_failed" },
            },
          );
        }
        return ndjson([
          {
            type: "session.failed",
            data: {
              code: "MODEL_CALL_FAILED",
              details: { errorId: "err_streamed_session_failure" },
              message: "Forbidden",
              sessionId: "ses_stream_failed",
            },
          },
        ]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_stream_failed", sessionState: null })}
        events={[]}
        pendingInput={EMPTY_PENDING}
        pendingUserMessage="Start analysis"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Forbidden Error ID: err_streamed_session_failure",
    );
  });

  it("answers each independently parked batch on its own", async () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_child_a",
              kind: "question",
              prompt: "Child A asks: which region?",
              display: "select",
              options: [{ id: "emea", label: "EMEA" }],
              action: {
                kind: "tool-call",
                callId: "call_child_a",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_c1",
        },
      },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_child_b",
              kind: "question",
              prompt: "Child B asks: which quarter?",
              display: "select",
              options: [{ id: "q3", label: "Q3" }],
              action: {
                kind: "tool-call",
                callId: "call_child_b",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_c2",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isPendingInputCall([input])) {
        // The proxy settled batch A at the accepted POST; B is still parked.
        return pendingInputResponse(
          pendingBatches({ requests: [{ requestId: "call_child_b", kind: "question" }] }),
        );
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "ses_1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        });
      }
      return ndjson([{ type: "session.waiting", data: { wait: "next-user-message" } }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 5 } })}
        events={events}
        pendingInput={pendingBatches(
          { requests: [{ requestId: "call_child_a", kind: "question" }] },
          { requests: [{ requestId: "call_child_b", kind: "question" }] },
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "EMEA" }));

    // Batch A goes out alone; batch B is a separate park and stays answerable.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) => !isPendingInputCall(call) && call[1]?.method === "POST",
        ),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      (call) => !isPendingInputCall(call) && call[1]?.method === "POST",
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      inputResponses: [{ requestId: "call_child_a", optionId: "emea" }],
    });
    expect(screen.getByRole("button", { name: "Q3" })).toBeEnabled();
  });

  it("keeps the composer open while only dismissable questions are parked", () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_metric",
              kind: "question",
              prompt: "Which paid-user metric?",
              display: "select",
              options: [{ id: "subscription", label: "Subscribers" }],
              action: {
                kind: "tool-call",
                callId: "call_metric",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={events}
        pendingInput={pendingBatches({
          requests: [{ requestId: "call_metric", kind: "question" }],
        })}
      />,
    );

    // A plain message is Eve's own dismiss gesture for a question batch, so
    // the composer must not lock; the option stays clickable alongside it.
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Subscribers" })).toBeEnabled();
  });

  it("keeps the composer available beside an open approval", () => {
    const parkedApproval =
      stampEvents([
        {
          type: "session.started",
          data: { runtime: { agentId: "agt_1", eveVersion: "0.44.0" } },
        },
        { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
        {
          type: "input.requested",
          data: {
            requests: [
              {
                requestId: "req_1",
                kind: "tool-approval",
                prompt: "Delete record 7?",
                display: "confirmation",
                options: [
                  { id: "approve", label: "Allow", style: "primary" },
                  { id: "cancel", label: "Cancel", style: "danger" },
                ],
                action: {
                  kind: "tool-call",
                  callId: "call_1",
                  toolName: "delete_record",
                  input: { id: 7 },
                },
              },
            ],
            sequence: 2,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
        {
          type: "session.waiting",
          data: { wait: "next-user-message", continuationToken: "ses_1" },
        },
      ]);
    const parked = pendingBatches({
      requests: [{ requestId: "req_1", kind: "tool-approval" }],
    });

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={parkedApproval}
        pendingInput={parked}
      />,
    );
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("asks for the queue turn policy for an ordinary turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: "ses_1" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={[]}
        pendingInput={EMPTY_PENDING}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "One more thing" },
    });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);

    const turnCalls = () =>
      fetchMock.mock.calls.filter((call) => !isPendingInputCall(call));
    await waitFor(() => expect(turnCalls().length).toBeGreaterThan(0));
    // The default steer policy would otherwise replace the running turn.
    expect(JSON.parse(String(turnCalls()[0]?.[1]?.body))).toMatchObject({
      turnPolicy: "queue",
    });
  });

  it("queues a message above the composer during a running turn and lets the user delete it", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/pending-input")) return pendingInputResponse();
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "ses_1" },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            for (const event of [
              {
                type: "message.received",
                data: {
                  message: "Start a long task",
                  sequence: 1,
                  turnId: "turn_1",
                },
              },
              { type: "turn.started", data: { sequence: 2, turnId: "turn_1" } },
              {
                type: "message.appended",
                data: {
                  messageDelta: "Working",
                  messageSoFar: "Working",
                  sequence: 3,
                  stepIndex: 0,
                  turnId: "turn_1",
                },
              },
            ]) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
            }
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
        chat={chat({ id: "chat_queue_delete" })}
        events={[]}
        pendingInput={EMPTY_PENDING}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Start a long task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generating" });

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Use the newer requirements" },
    });
    expect(screen.queryByRole("button", { name: "Stop generating" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));

    expect(await screen.findByRole("list", { name: "Queued messages" })).toHaveTextContent(
      "Use the newer requirements",
    );
    const turnCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(turnCalls()).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: 'Delete queued message "Use the newer requirements"',
      }),
    );
    expect(screen.queryByRole("list", { name: "Queued messages" })).not.toBeInTheDocument();
    expect(turnCalls()).toHaveLength(1);

    streamController.close();
  });

  it("steers a queued message into the running turn immediately", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/pending-input")) return pendingInputResponse();
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "ses_1" },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            for (const event of [
              {
                type: "message.received",
                data: { message: "Start", sequence: 1, turnId: "turn_1" },
              },
              { type: "turn.started", data: { sequence: 2, turnId: "turn_1" } },
            ]) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
            }
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
        chat={chat({ id: "chat_steer_now" })}
        events={[]}
        pendingInput={EMPTY_PENDING}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Start" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Start");
    await screen.findByRole("button", { name: "Stop generating" });

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Change direction now" },
    });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    fireEvent.click(
      await screen.findByRole("button", {
        name: 'Steer now with "Change direction now"',
      }),
    );

    const turnCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    expect(JSON.parse(String(turnCalls()[1]?.[1]?.body))).toMatchObject({
      message: "Change direction now",
      turnPolicy: "steer",
    });
    expect(
      screen.queryByRole("button", {
        name: 'Delete queued message "Change direction now"',
      }),
    ).not.toBeInTheDocument();

    for (const event of [
      { type: "turn.cancelled", data: { sequence: 3, turnId: "turn_1" } },
      {
        type: "message.received",
        data: { message: "Change direction now", sequence: 4, turnId: "turn_2" },
      },
      { type: "turn.started", data: { sequence: 5, turnId: "turn_2" } },
      { type: "turn.completed", data: { sequence: 6, turnId: "turn_2" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]) {
      streamController.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    }
    streamController.close();
  });

  it("retries an authenticated Steer without losing its queued row", async () => {
    const challenge =
      'Bearer realm="eveland", authorization_uri="https://identity.example.com/identity/login", project_id="project_support", display_name="Eveland"';
    const respondToAuthenticationChallenge = vi.fn(async () => "caller-token");
    const seenAuthorization: Array<string | null> = [];
    let postNumber = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/pending-input")) return pendingInputResponse();
        if (init?.method === "POST") {
          postNumber += 1;
          seenAuthorization.push(new Headers(init.headers).get("authorization"));
          if (postNumber === 2) {
            return Response.json(
              {
                code: "authentication_required",
                error: "Eveland authentication is required.",
              },
              {
                status: 401,
                headers: { "www-authenticate": challenge },
              },
            );
          }
          return Response.json(
            { sessionId: "ses_1" },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        if (postNumber < 3) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of [
                {
                  type: "message.received",
                  data: { message: "Start", sequence: 1, turnId: "turn_1" },
                },
                { type: "turn.started", data: { sequence: 2, turnId: "turn_1" } },
              ]) {
                controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
              }
              init?.signal?.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          });
          return new Response(body, {
            headers: { "content-type": "application/x-ndjson; charset=utf-8" },
          });
        }
        return ndjson([
          {
            type: "message.received",
            data: { message: "Authenticated steer", sequence: 10, turnId: "turn_2" },
          },
          { type: "turn.started", data: { sequence: 11, turnId: "turn_2" } },
          { type: "turn.completed", data: { sequence: 12, turnId: "turn_2" } },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_authenticated_steer" })}
        events={[]}
        getAccessToken={async () => "app-token"}
        getCallerToken={async () => "caller-token"}
        pendingInput={EMPTY_PENDING}
        respondToAuthenticationChallenge={respondToAuthenticationChallenge}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Start" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Start");
    await screen.findByRole("button", { name: "Stop generating" });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Authenticated steer" },
    });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    fireEvent.click(
      await screen.findByRole("button", {
        name: 'Steer now with "Authenticated steer"',
      }),
    );

    await waitFor(() => expect(seenAuthorization).toHaveLength(3));
    expect(seenAuthorization).toEqual([
      "Bearer app-token",
      "Bearer app-token",
      "Bearer caller-token",
    ]);
    expect(respondToAuthenticationChallenge).toHaveBeenCalledOnce();
    const callerRetry = fetchMock.mock.calls.find(
      ([, init]) =>
        init?.method === "POST" &&
        new Headers(init.headers).get("authorization") === "Bearer caller-token",
    );
    expect(JSON.parse(String(callerRetry?.[1]?.body))).toMatchObject({
      message: "Authenticated steer",
      turnPolicy: "queue",
    });
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Queued messages" })).not.toBeInTheDocument(),
    );
  });

  it("sends queued messages in FIFO order after each turn settles", async () => {
    let firstStreamController!: ReadableStreamDefaultController<Uint8Array>;
    let streamNumber = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/pending-input")) return pendingInputResponse();
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "ses_1" },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        streamNumber += 1;
        if (streamNumber === 1) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              firstStreamController = controller;
              for (const event of [
                {
                  type: "message.received",
                  data: { message: "First", sequence: 1, turnId: "turn_1" },
                },
                { type: "turn.started", data: { sequence: 2, turnId: "turn_1" } },
              ]) {
                controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
              }
            },
          });
          return new Response(body, {
            headers: { "content-type": "application/x-ndjson; charset=utf-8" },
          });
        }

        const queuedMessage = streamNumber === 2 ? "Second" : "Third";
        const turnId = `turn_${streamNumber}`;
        return ndjson([
          {
            type: "message.received",
            data: { message: queuedMessage, sequence: streamNumber * 10, turnId },
          },
          { type: "turn.started", data: { sequence: streamNumber * 10 + 1, turnId } },
          { type: "turn.completed", data: { sequence: streamNumber * 10 + 2, turnId } },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_queue_fifo" })}
        events={[]}
        pendingInput={EMPTY_PENDING}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generating" });
    for (const value of ["Second", "Third"]) {
      fireEvent.change(screen.getByLabelText("Message"), { target: { value } });
      fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    }
    expect(await screen.findByRole("list", { name: "Queued messages" })).toHaveTextContent(
      "Second",
    );
    expect(screen.getByRole("list", { name: "Queued messages" })).toHaveTextContent(
      "Third",
    );

    for (const event of [
      { type: "turn.completed", data: { sequence: 3, turnId: "turn_1" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]) {
      firstStreamController.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    }
    firstStreamController.close();

    const turnCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    await waitFor(() => expect(turnCalls()).toHaveLength(3));
    expect(
      turnCalls().map((call) => JSON.parse(String(call[1]?.body))),
    ).toMatchObject([
      { message: "First", turnPolicy: "queue" },
      { message: "Second", turnPolicy: "queue" },
      { message: "Third", turnPolicy: "queue" },
    ]);
  });

  it("starts draining the queue as part of turn settlement", async () => {
    let firstStreamController!: ReadableStreamDefaultController<Uint8Array>;
    let streamNumber = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/pending-input")) return pendingInputResponse();
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "ses_1" },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        streamNumber += 1;
        if (streamNumber === 1) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              firstStreamController = controller;
              for (const event of [
                {
                  type: "message.received",
                  data: { message: "First", sequence: 1, turnId: "turn_1" },
                },
                { type: "turn.started", data: { sequence: 2, turnId: "turn_1" } },
              ]) {
                controller.enqueue(
                  new TextEncoder().encode(`${JSON.stringify(event)}\n`),
                );
              }
            },
          });
          return new Response(body, {
            headers: { "content-type": "application/x-ndjson; charset=utf-8" },
          });
        }
        return ndjson([
          {
            type: "message.received",
            data: { message: "Second", sequence: 10, turnId: "turn_2" },
          },
          { type: "turn.started", data: { sequence: 11, turnId: "turn_2" } },
          { type: "turn.completed", data: { sequence: 12, turnId: "turn_2" } },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_queue_settlement" })}
        events={[]}
        pendingInput={EMPTY_PENDING}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "First" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generating" });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Second" },
    });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    await screen.findByRole("list", { name: "Queued messages" });

    const turnCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    vi.useFakeTimers();
    try {
      await act(async () => {
        for (const event of [
          { type: "turn.completed", data: { sequence: 3, turnId: "turn_1" } },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]) {
          firstStreamController.enqueue(
            new TextEncoder().encode(`${JSON.stringify(event)}\n`),
          );
        }
        firstStreamController.close();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(turnCalls()).toHaveLength(2);
      expect(JSON.parse(String(turnCalls()[1]?.[1]?.body))).toMatchObject({
        message: "Second",
        turnPolicy: "queue",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a failed queued message available for retry", async () => {
    let firstStreamController!: ReadableStreamDefaultController<Uint8Array>;
    let postNumber = 0;
    let streamNumber = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/pending-input")) return pendingInputResponse();
        if (init?.method === "POST") {
          postNumber += 1;
          if (postNumber === 2) {
            return Response.json(
              { error: "Eve is temporarily unavailable" },
              { status: 502 },
            );
          }
          return Response.json(
            { sessionId: "ses_1" },
            { headers: { "x-eve-session-id": "ses_1" } },
          );
        }
        streamNumber += 1;
        if (streamNumber === 1) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              firstStreamController = controller;
              for (const event of [
                {
                  type: "message.received",
                  data: { message: "First", sequence: 1, turnId: "turn_1" },
                },
                { type: "turn.started", data: { sequence: 2, turnId: "turn_1" } },
              ]) {
                controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
              }
            },
          });
          return new Response(body, {
            headers: { "content-type": "application/x-ndjson; charset=utf-8" },
          });
        }
        return ndjson([
          {
            type: "message.received",
            data: { message: "Retry me", sequence: 10, turnId: "turn_2" },
          },
          { type: "turn.started", data: { sequence: 11, turnId: "turn_2" } },
          { type: "turn.completed", data: { sequence: 12, turnId: "turn_2" } },
          { type: "session.waiting", data: { wait: "next-user-message" } },
        ]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_queue_retry" })}
        events={[]}
        pendingInput={EMPTY_PENDING}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generating" });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Retry me" },
    });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);

    for (const event of [
      { type: "turn.completed", data: { sequence: 3, turnId: "turn_1" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]) {
      firstStreamController.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    }
    firstStreamController.close();

    const retry = await screen.findByRole("button", {
      name: 'Retry queued message "Retry me"',
    });
    expect(screen.getByRole("list", { name: "Queued messages" })).toHaveTextContent(
      "Retry me",
    );

    fireEvent.click(retry);
    const turnCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    await waitFor(() => expect(turnCalls()).toHaveLength(3));
    expect(JSON.parse(String(turnCalls()[2]?.[1]?.body))).toMatchObject({
      message: "Retry me",
      turnPolicy: "queue",
    });
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Queued messages" })).not.toBeInTheDocument(),
    );
  });

  it("restores an unsent queued message from this chat's session storage", async () => {
    window.sessionStorage.setItem(
      "dawn:queued-turns:chat_queue_restore",
      JSON.stringify([
        {
          id: "queued_saved",
          message: { files: [], text: "Remember this after remount" },
          status: "queued",
        },
      ]),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: "ses_1" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ id: "chat_queue_restore" })}
        events={[]}
        pendingInput={EMPTY_PENDING}
      />,
    );

    const turnCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    await waitFor(() => expect(turnCalls()).toHaveLength(1));
    expect(JSON.parse(String(turnCalls()[0]?.[1]?.body))).toMatchObject({
      message: "Remember this after remount",
      turnPolicy: "queue",
    });
  });

  it("reconciles open batches when a turn boundary arrives from another actor", async () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_metric",
              kind: "question",
              prompt: "Which paid-user metric?",
              display: "select",
              options: [{ id: "subscription", label: "Subscribers" }],
              action: {
                kind: "tool-call",
                callId: "call_metric",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isPendingInputCall([input])) {
        // The other actor settled the batch; the ledger no longer holds it.
        return pendingInputResponse();
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "ses_1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        });
      }
      return ndjson([
        { type: "turn.started", data: { sequence: 3, turnId: "turn_2" } },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={events}
        pendingInput={pendingBatches({
          requests: [{ requestId: "call_metric", kind: "question" }],
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Just answer generally" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => isPendingInputCall(call))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Subscribers" })).not.toBeInTheDocument(),
    );
  });

  it("applies input.resolved while the current stream remains parked", async () => {
    const events = stampEvents([
      {
        type: "session.started",
        data: { runtime: { agentId: "agt_1", eveVersion: "0.44.0" } },
      },
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      {
        type: "step.started",
        data: {
          modelId: "fake/model",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_metric",
              kind: "question",
              prompt: "Which paid-user metric?",
              display: "select",
              options: [{ id: "subscription", label: "Subscribers" }],
              action: {
                kind: "tool-call",
                callId: "call_metric",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isPendingInputCall([input])) {
        return pendingInputResponse();
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "ses_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "ses_1",
          },
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({
                  type: "input.resolved",
                  data: {
                    resolutions: [
                      {
                        kind: "question",
                        outcome: "answered",
                        requestId: "call_metric",
                        response: {
                          requestId: "call_metric",
                          optionId: "subscription",
                        },
                      },
                    ],
                    sequence: 3,
                    stepIndex: 0,
                    turnId: "turn_1",
                  },
                })}\n`,
              ),
            );
          },
        }),
        { headers: { "content-type": "application/x-ndjson; charset=utf-8" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 5 } })}
        events={events}
        pendingInput={pendingBatches({
          requests: [{ requestId: "call_metric", kind: "question" }],
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Continue with the selected metric" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Responded: Subscribers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribers" })).not.toBeInTheDocument();
  });

  it("ignores a stale ledger response that raced a newer live batch", async () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "call_a",
              kind: "question",
              prompt: "Old question?",
              display: "select",
              options: [{ id: "old", label: "Old option" }],
              action: {
                kind: "tool-call",
                callId: "call_a",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    const currentState = pendingBatches(
      { requests: [{ requestId: "call_a", kind: "question" }] },
      { requests: [{ requestId: "call_b", kind: "question" }] },
    );
    let resolveStale!: (response: Response) => void;
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    let ledgerReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isPendingInputCall([input])) {
        ledgerReads += 1;
        // The first read races the stream: it was captured before batch B
        // existed and resolves last.
        return ledgerReads === 1 ? staleResponse : pendingInputResponse(currentState);
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "ses_1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        });
      }
      return ndjson([
        { type: "turn.started", data: { sequence: 3, turnId: "turn_2" } },
        {
          type: "input.requested",
          data: {
            requests: [
              {
                requestId: "call_b",
                kind: "question",
                prompt: "New question?",
                display: "select",
                options: [{ id: "fresh", label: "Fresh option" }],
                action: {
                  kind: "tool-call",
                  callId: "call_b",
                  toolName: "ask_question",
                  input: {},
                },
              },
            ],
            sequence: 4,
            stepIndex: 0,
            turnId: "turn_2",
          },
        },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={events}
        pendingInput={pendingBatches({
          requests: [{ requestId: "call_a", kind: "question" }],
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Also consider this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(ledgerReads).toBeGreaterThanOrEqual(2));
    expect(await screen.findByRole("button", { name: "Fresh option" })).toBeEnabled();

    resolveStale(pendingInputResponse(EMPTY_PENDING));

    // The stale read was captured before batch B opened; applying it would
    // erase a park Eve still holds.
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((call) => isPendingInputCall(call)).length)
        .toBeGreaterThanOrEqual(2),
    );
    expect(screen.getByRole("button", { name: "Fresh option" })).toBeEnabled();
  });

  it("commits first-time freeform text on blur so the batch can complete", async () => {
    const events = stampEvents([
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { modelId: "fake/model", sequence: 1, stepIndex: 0, turnId: "turn_1" } },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "q_text",
              kind: "question",
              prompt: "Anything to add?",
              display: "text",
              allowFreeform: true,
              action: {
                kind: "tool-call",
                callId: "q_text",
                toolName: "ask_question",
                input: {},
              },
            },
            {
              requestId: "q_opt",
              kind: "question",
              prompt: "Proceed?",
              display: "select",
              options: [{ id: "go", label: "Go ahead" }],
              action: {
                kind: "tool-call",
                callId: "q_opt",
                toolName: "ask_question",
                input: {},
              },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isPendingInputCall([input])) {
        return pendingInputResponse();
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "ses_1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-eve-session-id": "ses_1" },
        });
      }
      return ndjson([{ type: "session.waiting", data: { wait: "next-user-message" } }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={events}
        pendingInput={pendingBatches({
          requests: [
            { requestId: "q_text", kind: "question" },
            { requestId: "q_opt", kind: "question" },
          ],
        })}
      />,
    );

    // Fill the text card and move straight to the next one — no Enter.
    fireEvent.change(screen.getByLabelText("Response"), {
      target: { value: "All good" },
    });
    fireEvent.blur(screen.getByLabelText("Response"));
    fireEvent.click(screen.getByRole("button", { name: "Go ahead" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) => !isPendingInputCall(call) && call[1]?.method === "POST",
        ),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      (call) => !isPendingInputCall(call) && call[1]?.method === "POST",
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      inputResponses: [
        { requestId: "q_text", text: "All good" },
        { requestId: "q_opt", optionId: "go" },
      ],
    });
  });
});
