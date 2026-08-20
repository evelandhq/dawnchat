import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgentRecheckButton } from "@/components/agent-recheck-button";

const onChecked = vi.fn();

function checkResponse(status: "healthy" | "unreachable" = "healthy"): Response {
  return Response.json({ agent: { id: "agent_a", name: "Data Bot", status } });
}

describe("AgentRecheckButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    onChecked.mockReset();
  });

  it("posts to the health check endpoint and reports the checked agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(checkResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentRecheckButton agentId="agent_a" onChecked={onChecked} />);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent_a/check", { method: "POST" });
    await waitFor(() =>
      expect(onChecked).toHaveBeenCalledWith({
        id: "agent_a",
        name: "Data Bot",
        status: "healthy",
      }),
    );
  });

  it("ignores a duplicate same-turn activation while a check is pending", async () => {
    let resolveRequest: (response: Response) => void = () => {};
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentRecheckButton agentId="agent_a" onChecked={onChecked} />);

    const button = screen.getByRole("button", { name: "Check again" });
    React.act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();

    await React.act(async () => {
      resolveRequest(checkResponse());
      await request;
    });
    await waitFor(() => expect(onChecked).toHaveBeenCalledTimes(1));
  });

  it("shows an error and allows retry after the health check request fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(checkResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentRecheckButton agentId="agent_a" onChecked={onChecked} />);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Health check failed.");
    expect(onChecked).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onChecked).toHaveBeenCalledTimes(1));
  });
});
