import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgentConnectionForm } from "@/components/agent-connection-form";
import { AgentList, type AgentListItem } from "@/components/agent-list";
import { getAgentsForPage } from "@/app/agents/page";
import { createRepository } from "@/db/repository";
import { setDbClientForTests } from "@/db/provider";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

describe("AgentConnectionForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
  });

  it("submits a remote Eve base URL to the agents API and navigates to the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          agent: {
            id: "agent_123",
            name: "Remote Eve",
            baseUrl: "https://eve.example.com",
            authType: "none",
            hasAuth: false,
            status: "healthy",
            lastCheckedAt: "2026-07-10T00:00:00.000Z",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentConnectionForm));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Remote Eve" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://eve.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Register agent" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Remote Eve", baseUrl: "https://eve.example.com", authType: "none" }),
      }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/agents"));
  });

  it("shows validation errors for invalid URLs and does not call fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentConnectionForm));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Remote Eve" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: "Register agent" }));

    expect(await screen.findByText("Base URL must be a valid http(s) URL."));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("shows auth fields conditionally and submits custom header credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: { id: "agent_123" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentConnectionForm));

    expect(screen.queryByLabelText("Bearer Token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Header Name")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Auth Type"), { target: { value: "bearer" } });
    expect(screen.getByLabelText("Bearer Token")).toBeInTheDocument();
    expect(screen.queryByLabelText("Header Name")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Auth Type"), { target: { value: "header" } });
    expect(screen.queryByLabelText("Bearer Token")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Header Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Header Value")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Header Eve" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://header-eve.example.com" } });
    fireEvent.change(screen.getByLabelText("Header Name"), { target: { value: "X-Eve-Key" } });
    fireEvent.change(screen.getByLabelText("Header Value"), { target: { value: "secret-test-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Register agent" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents",
      expect.objectContaining({
        body: JSON.stringify({
          name: "Header Eve",
          baseUrl: "https://header-eve.example.com",
          authType: "header",
          headerName: "X-Eve-Key",
          headerValue: "secret-test-value",
        }),
      }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/agents"));
  });

  it("rejects invalid custom header names before submitting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentConnectionForm));

    fireEvent.change(screen.getByLabelText("Auth Type"), { target: { value: "header" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Header Eve" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://header-eve.example.com" } });
    fireEvent.change(screen.getByLabelText("Header Name"), { target: { value: "Bad Header" } });
    fireEvent.change(screen.getByLabelText("Header Value"), { target: { value: "secret-test-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Register agent" }));

    expect(await screen.findByText("Header name must be a valid HTTP header name."));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("AgentsPage data loading", () => {
  let testDb: TestDbHandle;

  beforeEach(() => {
    testDb = createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(() => {
    setDbClientForTests(null);
    testDb.close();
  });

  it("loads redacted agents directly from the repository without server-side fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const repository = createRepository(testDb.db);
    await repository.createAgentConnection({
      name: "Repo Eve",
      baseUrl: "https://repo-eve.example.com",
      authType: "bearer",
      authConfigEncrypted: "encrypted-test-value",
    });

    const agents = await getAgentsForPage();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(agents).toEqual([
      expect.objectContaining({
        name: "Repo Eve",
        baseUrl: "https://repo-eve.example.com",
        authType: "bearer",
        hasAuth: true,
      }),
    ]);
    expect(JSON.stringify(agents)).not.toContain("encrypted-test-value");
  });
});

describe("AgentList", () => {
  it("renders empty state and create link", () => {
    render(React.createElement(AgentList, { agents: [] }));

    expect(screen.getByText("No agents connected yet."));
    expect(screen.getByRole("link", { name: "Connect an agent" })).toHaveAttribute("href", "/agents/new");
  });

  it("renders redacted agent rows", () => {
    const agents: AgentListItem[] = [
      {
        id: "agent_123",
        name: "Remote Eve",
        baseUrl: "https://eve.example.com",
        authType: "bearer",
        hasAuth: true,
        status: "healthy",
        lastCheckedAt: "2026-07-10T00:00:00.000Z",
      },
    ];

    render(React.createElement(AgentList, { agents }));

    expect(screen.getByText("Remote Eve"));
    expect(screen.getByText("https://eve.example.com"));
    expect(screen.getByText("healthy"));
    expect(screen.getByText("Bearer Token"));
    expect(screen.getByText("Auth configured"));
    expect(screen.getByRole("link", { name: "Connect an agent" })).toHaveAttribute("href", "/agents/new");
  });
});
