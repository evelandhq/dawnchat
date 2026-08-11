import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EveMessage, EveMessagePart } from "eve/react";

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
      canRespond: false,
      isStreaming: false,
      message: message(part),
      onInputResponses: vi.fn(),
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
});
