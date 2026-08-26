import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EveMessage, EveMessagePart } from "eve/react";
import type { InputResponse } from "eve/client";

import { EveMessageView } from "@/components/eve-message";

const SKILL_BODY = "# Deploy\nInternal step 1: ssh into the release box.";

function message(part: EveMessagePart): EveMessage {
  return { id: "msg_1", parts: [part], role: "assistant" };
}

function loadSkillPart(overrides: Record<string, unknown> = {}): EveMessagePart {
  return {
    input: { skill: "deploy" },
    output: SKILL_BODY,
    state: "output-available",
    toolCallId: "call_1",
    toolMetadata: { eve: { kind: "load-skill", name: "load_skill" } },
    toolName: "load_skill",
    type: "dynamic-tool",
    ...overrides,
  } as EveMessagePart;
}

function renderPart(part: EveMessagePart): void {
  render(
    React.createElement(EveMessageView, {
      inputRequests: {
        canRespond: false,
        drafts: new Map<string, InputResponse>(),
        pending: new Set<string>(),
        respond: vi.fn(),
      },
      isStreaming: false,
      message: message(part),
    }),
  );
}

describe("EveMessageView skill loads", () => {
  it("names the loaded skill without rendering its instructions", () => {
    renderPart(loadSkillPart());

    expect(screen.getByText(/Loaded skill · deploy/u)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Internal step 1");
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("suppresses the body for a part that carries no eve metadata", () => {
    renderPart(loadSkillPart({ toolMetadata: undefined }));

    expect(document.body.textContent).not.toContain("Internal step 1");
  });

  it("hides the failure text a missing skill reports", () => {
    renderPart(
      loadSkillPart({
        errorText: 'No skill named "deploy". Available skills: deploy-prod, rollback.',
        output: undefined,
        state: "output-error",
      }),
    );

    expect(screen.getByText(/Load skill · deploy/u)).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Available skills");
  });

  it("still expands other tools", () => {
    renderPart(
      loadSkillPart({
        input: { path: "/etc/hosts" },
        output: "127.0.0.1 localhost",
        toolMetadata: { eve: { kind: "tool-call", name: "read_file" } },
        toolName: "read_file",
      }),
    );

    expect(screen.getByRole("button", { name: /read_file/u })).toBeInTheDocument();
  });

  it("renders completed tools as compact inline activity", () => {
    renderPart(
      loadSkillPart({
        input: { path: "/etc/hosts" },
        output: "127.0.0.1 localhost",
        toolMetadata: { eve: { kind: "tool-call", name: "read_file" } },
        toolName: "read_file",
      }),
    );

    const trigger = screen.getByRole("button", { name: /read_file/u });
    expect(trigger.parentElement).not.toHaveClass("border");
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("shows active tool status without expanding the details", () => {
    renderPart(
      loadSkillPart({
        output: undefined,
        state: "input-available",
        toolMetadata: { eve: { kind: "tool-call", name: "read_file" } },
        toolName: "read_file",
      }),
    );

    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("renders bash calls as a copyable terminal transcript", () => {
    renderPart(
      loadSkillPart({
        input: { command: "pnpm test" },
        output: {
          stdout: "12 tests passed",
          stderr: "1 snapshot changed",
          exitCode: 2,
        },
        toolMetadata: { eve: { kind: "tool-call", name: "bash" } },
        toolName: "bash",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /bash/u }));

    expect(screen.getByText("$ pnpm test")).toBeInTheDocument();
    expect(screen.getByText("12 tests passed")).toBeInTheDocument();
    expect(screen.getByText("1 snapshot changed")).toBeInTheDocument();
    expect(screen.getByText("Exited with code 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy terminal transcript" })).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
  });

  it("opens a question when its pending state arrives after projection", () => {
    const request = {
      requestId: "req_rollout",
      kind: "question" as const,
      prompt: "How should we roll this out?",
      display: "select" as const,
      options: [{ id: "gradual", label: "Gradual rollout" }],
      action: {
        kind: "tool-call" as const,
        callId: "call_1",
        toolName: "ask_question",
        input: {},
      },
    };
    const part = loadSkillPart({
      approval: { id: request.requestId },
      input: {},
      output: undefined,
      state: "input-available",
      toolMetadata: {
        eve: { inputRequest: request, kind: "tool-call", name: "ask_question" },
      },
      toolName: "ask_question",
    });
    const props = (pending: ReadonlySet<string>) => ({
      inputRequests: {
        canRespond: true,
        drafts: new Map<string, InputResponse>(),
        pending,
        respond: vi.fn(),
      },
      isStreaming: false,
      message: message(part),
    });
    const { rerender } = render(React.createElement(EveMessageView, props(new Set())));

    expect(screen.getByRole("button", { name: /ask_question/u })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender(React.createElement(EveMessageView, props(new Set([request.requestId]))));

    expect(screen.getByRole("button", { name: /ask_question/u })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Gradual rollout" })).toBeInTheDocument();
  });
});
