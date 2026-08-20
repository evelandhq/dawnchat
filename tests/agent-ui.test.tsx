import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgentConnectionForm } from "@/components/agent-connection-form";
import { AgentDeleteDialog } from "@/components/agent-delete-dialog";
import { AgentList, type AgentListItem } from "@/components/agent-list";
import { GET as GET_AGENT } from "@/app/api/agents/[agentId]/route";
import { createRepository } from "@/db/repository";
import { setDbClientForTests } from "@/db/provider";
import { encryptAuthConfig } from "@/eve/auth";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    refresh: refreshMock,
  }),
}));

describe("AgentConnectionForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    refreshMock.mockReset();
  });

  it("submits a remote Eve base URL and navigates to the new agent chat entry", async () => {
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
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/agents/agent_123"));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("shows a specific error when the agent URL is already registered", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Agent URL already registered" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentConnectionForm));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Duplicate Eve" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://eve.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Register agent" }));

    expect(await screen.findByText("An agent with this URL is already registered.")).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
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
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/agents/agent_123"));
    expect(refreshMock).toHaveBeenCalledTimes(1);
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

  it("submits safe edit defaults while preserving an existing bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: { id: "agent_123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(AgentConnectionForm, {
        initialAgent: {
          id: "agent_123",
          name: "Remote Eve",
          baseUrl: "https://eve.example.com",
          authType: "bearer",
          hasAuth: true,
          headerName: "",
        },
      }),
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Remote Eve");
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://eve.example.com");
    expect(screen.getByText("Leave blank to keep the current bearer token.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed Eve" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent_123", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Eve",
        baseUrl: "https://eve.example.com",
        authType: "bearer",
      }),
    });
    expect(pushMock).toHaveBeenCalledWith("/agents");
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("ignores duplicate edit submissions while the request is pending", async () => {
    let resolveRequest: (response: Response) => void = () => {};
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(AgentConnectionForm, {
        initialAgent: {
          id: "agent_123",
          name: "Remote Eve",
          baseUrl: "https://eve.example.com",
          authType: "none",
          hasAuth: false,
          headerName: "",
        },
      }),
    );

    const form = screen.getByRole("button", { name: "Save changes" }).closest("form");
    expect(form).not.toBeNull();
    React.act(() => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/agent_123",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    await React.act(async () => {
      resolveRequest(
        new Response(JSON.stringify({ agent: { id: "agent_123" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await request;
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/agents"));
  });

  it("requires a new secret after switching authentication type", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(AgentConnectionForm, {
        initialAgent: {
          id: "agent_123",
          name: "Remote Eve",
          baseUrl: "https://eve.example.com",
          authType: "header",
          hasAuth: true,
          headerName: "X-Agent-Key",
        },
      }),
    );

    fireEvent.change(screen.getByLabelText("Auth Type"), { target: { value: "bearer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Bearer token is required.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the shared duplicate URL error in edit mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Agent URL already registered" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(AgentConnectionForm, {
        initialAgent: {
          id: "agent_123",
          name: "Remote Eve",
          baseUrl: "https://eve.example.com",
          authType: "none",
          hasAuth: false,
          headerName: "",
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("An agent with this URL is already registered.")).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("AgentsPage data loading", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
  });

  it("serves a redacted agent with safe edit defaults over the API", async () => {
    const repository = createRepository(testDb.db);
    const secret = "header-secret-not-for-client";
    const agent = await repository.createAgentConnection({
      name: "Header Eve",
      baseUrl: "https://header.example.com",
      authType: "header",
      authConfigEncrypted: encryptAuthConfig({
        headerName: "X-Agent-Key",
        headerValue: secret,
      }),
    });

    const response = await GET_AGENT(
      new Request(`http://localhost/api/agents/${agent.id}`),
      { params: Promise.resolve({ agentId: agent.id }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      agent: expect.objectContaining({
        id: agent.id,
        name: "Header Eve",
        baseUrl: "https://header.example.com",
        authType: "header",
        hasAuth: true,
        status: "unknown",
      }),
      editDefaults: {
        id: agent.id,
        name: "Header Eve",
        baseUrl: "https://header.example.com",
        authType: "header",
        hasAuth: true,
        headerName: "X-Agent-Key",
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it("returns 404 for an unknown agent read", async () => {
    const response = await GET_AGENT(
      new Request("http://localhost/api/agents/agent_missing"),
      { params: Promise.resolve({ agentId: "agent_missing" }) },
    );

    expect(response.status).toBe(404);
  });
});

describe("AgentList", () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
    refreshMock.mockReset();
  });

  it("renders empty state and create link", () => {
    render(React.createElement(AgentList, { agents: [] }));

    expect(screen.getByText("No agents connected yet."));
    expect(screen.getByRole("link", { name: "Connect an agent" })).toHaveAttribute("href", "/agents/new");
  });

  it("renders a table row with the agent name and URL only", () => {
    render(React.createElement(AgentList, { agents }));

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Remote Eve"));
    expect(screen.getByText("https://eve.example.com"));
    expect(screen.queryByText("Bearer Token")).not.toBeInTheDocument();
    expect(screen.queryByText("Auth configured")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect an agent" })).toHaveAttribute("href", "/agents/new");
  });

  it("renders Detail and Start Chat actions for a connected agent", () => {
    render(React.createElement(AgentList, { agents }));

    expect(screen.getByRole("link", { name: "Detail Remote Eve" })).toHaveAttribute(
      "href",
      "/agents/agent_123/edit",
    );
    expect(screen.getByRole("link", { name: "Start chat with Remote Eve" })).toHaveAttribute(
      "href",
      "/agents/agent_123",
    );
  });

  it("requires the exact agent name before deleting and refreshes on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    render(React.createElement(AgentDeleteDialog, { agentId: "agent_123", agentName: "Remote Eve" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete Remote Eve" }));
    const confirmation = screen.getByLabelText('Type "Remote Eve" to confirm');
    const deleteButton = screen.getByRole("button", { name: "Delete agent" });

    expect(deleteButton).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "remote eve" } });
    expect(deleteButton).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "Remote Eve" } });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent_123", {
        method: "DELETE",
      }),
    );
    expect(refreshMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("navigates to the redirect target instead of refreshing after deletion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      React.createElement(AgentDeleteDialog, {
        agentId: "agent_123",
        agentName: "Remote Eve",
        redirectTo: "/agents",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Remote Eve" }));
    fireEvent.change(screen.getByLabelText('Type "Remote Eve" to confirm'), {
      target: { value: "Remote Eve" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete agent" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/agents"));
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("keeps the delete dialog and confirmation value when deletion fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(React.createElement(AgentDeleteDialog, { agentId: "agent_123", agentName: "Remote Eve" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete Remote Eve" }));
    const confirmation = screen.getByLabelText('Type "Remote Eve" to confirm');
    fireEvent.change(confirmation, { target: { value: "Remote Eve" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete agent" }));

    expect(await screen.findByText("Unable to delete agent. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(confirmation).toHaveValue("Remote Eve");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("ignores duplicate delete activation while the request is pending", async () => {
    let resolveRequest: (response: Response) => void = () => {};
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal("fetch", fetchMock);
    render(React.createElement(AgentDeleteDialog, { agentId: "agent_123", agentName: "Remote Eve" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete Remote Eve" }));
    fireEvent.change(screen.getByLabelText('Type "Remote Eve" to confirm'), {
      target: { value: "Remote Eve" },
    });
    const deleteButton = screen.getByRole("button", { name: "Delete agent" });
    React.act(() => {
      deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();

    await React.act(async () => {
      resolveRequest(new Response(null, { status: 204 }));
      await request;
    });
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });
});
