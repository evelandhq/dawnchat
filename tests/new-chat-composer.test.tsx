import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NewChatComposer } from "@/components/new-chat-composer";

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    refresh: refreshMock,
  }),
}));

describe("NewChatComposer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    refreshMock.mockReset();
  });

  it("navigates once without starting a concurrent RSC refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ chat: { id: "chat_created" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot" }));

    fireEvent.change(screen.getByLabelText("First message"), { target: { value: "  Hello Eve  " } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent_a", message: "Hello Eve" }),
      }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/chats/chat_created"));
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("uses the app-scoped token without prefetching a Caller Token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ chat: { id: "chat_identity" } }, { status: 201 }),
    );
    const getAccessToken = vi.fn(async () => "app-token");
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NewChatComposer
        agentId="agent_a"
        agentName="Data Bot"
        getAccessToken={getAccessToken}
      />,
    );
    fireEvent.change(screen.getByLabelText("First message"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats",
      expect.objectContaining({
        headers: {
          authorization: "Bearer app-token",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("previews and submits an attachment with the first message", async () => {
    const file = new File(["hello"], "report.txt", { type: "text/plain" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "blob:report") {
        return new Response("hello", { headers: { "content-type": "text/plain" } });
      }
      return Response.json({ chat: { id: "chat_with_file" } }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot" }));

    expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [file] } });
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Review this" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/chats/chat_with_file"));
    const createCall = fetchMock.mock.calls.find(([input]) => input === "/api/chats");
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      agentId: "agent_a",
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

  it("navigates to a persisted failed chat instead of showing a creation error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ chat: { id: "chat_failed", status: "failed" }, error: "Eve turn failed" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot" }));

    fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/chats/chat_failed"));
    expect(refreshMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a successful submission latched while navigation completes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ chat: { id: "chat_created" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot" }));

    const input = screen.getByLabelText("First message");
    const submit = screen.getByRole("button", { name: "Start chat" });
    const form = submit.closest("form");
    expect(form).not.toBeNull();
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(submit);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/chats/chat_created"));
    fireEvent.submit(form!);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    expect(submit).toBeDisabled();
  });

  it("shows the API error when chat creation fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Agent is unreachable." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot" }));

    fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Agent is unreachable.");
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("First message")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start chat" })).toBeEnabled();
  });

  it("disables input and submit when disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot", disabled: true }));

    expect(screen.getByLabelText("First message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start chat" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a non-blank first message without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot" }));

    fireEvent.change(screen.getByLabelText("First message"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a first message.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
