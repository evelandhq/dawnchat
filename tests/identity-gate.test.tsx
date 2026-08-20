import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityGate } from "@/components/identity-gate";
import { EvelandIdentityError } from "@/identity/client";

const getSession = vi.fn();
const getAppToken = vi.fn<() => Promise<string>>();
const getLoginAvailability = vi.fn();
const login = vi.fn((returnPath: string): never => {
  throw new EvelandIdentityError(
    "identity_redirecting",
    401,
    `Redirecting to Eveland Identity for ${returnPath}.`,
  );
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/chats/chat_1",
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    session: null,
    getSession,
    getAppToken,
    getLoginAvailability,
    login,
  }),
}));

describe("IdentityGate", () => {
  beforeEach(() => {
    getSession.mockReset();
    getAppToken.mockReset();
    getLoginAvailability.mockReset();
    login.mockClear();
    getAppToken.mockResolvedValue("app-token");
    getLoginAvailability.mockResolvedValue({ available: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ claimed: 0 })));
  });

  it("renders the app for an authenticated session and claims anonymous chats", async () => {
    getSession.mockResolvedValue({
      authenticated: true,
      principal: { id: "ipr_1", name: "Test User", email: null },
      activeRealm: { id: "irl_1", name: "Account 1" },
    });
    const fetchMock = vi.fn(async () => Response.json({ claimed: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IdentityGate>
        <div>App content</div>
      </IdentityGate>,
    );

    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/chats/claim", {
        method: "POST",
        headers: { authorization: "Bearer app-token" },
      });
    });
  });

  it("runs anonymously against an open-access Eveland instance", async () => {
    getSession.mockResolvedValue({ authenticated: false });
    getLoginAvailability.mockResolvedValue({
      available: false,
      code: "identity_login_not_required",
      message: "This Eveland instance is open to all callers; no identity login is used.",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IdentityGate>
        <div>App content</div>
      </IdentityGate>,
    );

    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    // No identity, no App Token, no claim.
    expect(getAppToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a login refusal instead of stranding the browser on it", async () => {
    getSession.mockResolvedValue({ authenticated: false });
    getLoginAvailability.mockResolvedValue({
      available: false,
      code: "identity_return_target_invalid",
      message: "The Identity return target is not registered.",
    });

    render(
      <IdentityGate>
        <div>App content</div>
      </IdentityGate>,
    );

    expect(
      await screen.findByText("The Identity return target is not registered."),
    ).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    expect(screen.queryByText("App content")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("redirects an unauthenticated visitor to Eveland login", async () => {
    getSession.mockResolvedValue({ authenticated: false });

    render(
      <IdentityGate>
        <div>App content</div>
      </IdentityGate>,
    );

    expect(
      await screen.findByText("Redirecting to Eveland sign-in…"),
    ).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith("/chats/chat_1");
    expect(screen.queryByText("App content")).not.toBeInTheDocument();
  });

  it("still renders the app when claiming anonymous chats fails", async () => {
    getSession.mockResolvedValue({
      authenticated: true,
      principal: { id: "ipr_1", name: "Test User", email: null },
      activeRealm: { id: "irl_1", name: "Account 1" },
    });
    getAppToken.mockRejectedValue(new Error("token issue failed"));

    render(
      <IdentityGate>
        <div>App content</div>
      </IdentityGate>,
    );

    expect(await screen.findByText("App content")).toBeInTheDocument();
  });

  it("offers a retry when Eveland Identity is unavailable", async () => {
    getSession
      .mockRejectedValueOnce(
        new EvelandIdentityError(
          "identity_unavailable",
          503,
          "Eveland Identity is unavailable.",
        ),
      )
      .mockResolvedValueOnce({
        authenticated: true,
        principal: { id: "ipr_1", name: "Test User", email: null },
        activeRealm: { id: "irl_1", name: "Account 1" },
      });

    render(
      <IdentityGate>
        <div>App content</div>
      </IdentityGate>,
    );

    expect(
      await screen.findByText("Eveland Identity is unavailable."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
