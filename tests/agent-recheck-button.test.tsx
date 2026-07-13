import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgentRecheckButton } from "@/components/agent-recheck-button";

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: refreshMock,
  }),
}));

describe("AgentRecheckButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    refreshMock.mockReset();
  });

  it("posts to the health check endpoint and refreshes on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentRecheckButton, { agentId: "agent_a" }));

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent_a/check", { method: "POST" });
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("ignores a duplicate same-turn activation while a check is pending", async () => {
    let resolveRequest: (response: Response) => void = () => {};
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentRecheckButton, { agentId: "agent_a" }));

    const button = screen.getByRole("button", { name: "Check again" });
    React.act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();

    await React.act(async () => {
      resolveRequest(new Response("{}", { status: 200 }));
      await request;
    });
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("shows an error and allows retry after the health check request fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentRecheckButton, { agentId: "agent_a" }));

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Health check failed.");
    expect(refreshMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });
});
