import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
 * Eve stamps every stream event with an emission time and a sortable id from
 * stream version 20 (Eve 0.29) on. Fixtures spell the payload; this adds the
 * envelope the reducer deduplicates on.
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
                { id: "gmv_payors", label: "Payors" },
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

    // Option rows wrap instead of overflowing the card when labels are wide.
    expect(
      screen.getByRole("button", { name: "Same period last month" }).parentElement,
    ).toHaveClass("flex-wrap");

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

  it("keeps a partly answered approval batch answerable across the deferred turn", () => {
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
                { id: "deny", label: "Deny", style: "danger" },
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
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    expect(screen.getByLabelText("Message")).toBeDisabled();
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

    fireEvent.change(screen.getByLabelText("Response"), { target: { value: "Proceed carefully" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

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
      new Response(JSON.stringify({ sessionId: "ses_1", continuationToken: "eve:1" }), {
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
        return new Response(JSON.stringify({ sessionId: "ses_1", continuationToken: "eve:1" }), {
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
    // Eve 0.38 replaced the binding's local-abort stop() with cancel(): the
    // store waits for the turn's `turn.started`, POSTs `{ turnId }` to the
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

  it("locks the composer behind an open approval only for an Agent that would hold the message", () => {
    const parkedApproval = (eveVersion: string) =>
      stampEvents([
        {
          type: "session.started",
          data: { runtime: { agentId: "agt_1", eveVersion } },
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

    // Through 0.31 Eve held an unrelated message until the approval was
    // answered, so the composer had to say the chat was blocked.
    const held = render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={parkedApproval("0.31.1")}
        pendingInput={parked}
      />,
    );
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    held.unmount();

    // From 0.32 the message runs as its own turn beside the open approval,
    // which stays answerable, so there is nothing left to lock.
    render(
      <ChatThread
        chat={chat({ sessionState: { sessionId: "ses_1", streamIndex: 4 } })}
        events={parkedApproval("0.33.2")}
        pendingInput={parked}
      />,
    );
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("asks for the queue turn policy so a message never steers a running turn", async () => {
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
    // Eve 0.33 would otherwise cancel whatever turn is running and replace it.
    expect(JSON.parse(String(turnCalls()[0]?.[1]?.body))).toMatchObject({
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
