import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarAccount } from "@/components/sidebar-account";
import { SidebarProvider } from "@/components/ui/sidebar";
import { EvelandIdentityError } from "@/identity/client";

const logout = vi.fn<() => Promise<void>>();
const login = vi.fn((returnPath: string): never => {
  throw new EvelandIdentityError(
    "identity_redirecting",
    401,
    `Redirecting to Eveland Identity for ${returnPath}.`,
  );
});
const switchRealm = vi.fn((returnPath: string): never => {
  throw new EvelandIdentityError(
    "identity_redirecting",
    401,
    `Redirecting to Eveland Identity for ${returnPath}.`,
  );
});

let session: unknown = null;

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents",
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    session,
    login,
    logout,
    switchRealm,
  }),
}));

function renderAccount() {
  return render(
    <SidebarProvider>
      <SidebarAccount />
    </SidebarProvider>,
  );
}

describe("SidebarAccount", () => {
  beforeEach(() => {
    logout.mockReset();
    logout.mockResolvedValue();
    login.mockClear();
    switchRealm.mockClear();
    session = {
      authenticated: true,
      principal: { id: "ipr_1", name: "陈金洲", email: "user@example.com" },
      activeRealm: { id: "irl_1", name: "Account 1" },
    };
  });

  it("renders nothing before the session is established", () => {
    session = null;
    const { container } = renderAccount();
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows the signed-in principal and realm", () => {
    renderAccount();
    expect(screen.getByText("陈金洲")).toBeInTheDocument();
    expect(screen.getByText("Account 1")).toBeInTheDocument();
  });

  it("signs out and returns to Eveland login", async () => {
    renderAccount();
    fireEvent.keyDown(screen.getByRole("button", { name: "Account" }), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByText("Sign out"));

    await waitFor(() => expect(logout).toHaveBeenCalled());
    await waitFor(() => expect(login).toHaveBeenCalledWith("/agents"));
  });

  it("switches identity scope through Eveland", async () => {
    renderAccount();
    fireEvent.keyDown(screen.getByRole("button", { name: "Account" }), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByText("Switch identity scope"));

    expect(switchRealm).toHaveBeenCalledWith("/agents");
  });
});
