import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { setDbClientForTests } from "@/db/provider";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
}));

describe("AppSidebar", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
  });

  it("places the theme toggle beside the EveChats title without a header divider", async () => {
    const sidebar = await AppSidebar();
    const { container } = render(<SidebarProvider>{sidebar}</SidebarProvider>);
    const header = container.querySelector('[data-sidebar="header"]');

    expect(header).not.toBeNull();
    expect(header).toHaveClass("h-14", "flex-row", "items-center");
    expect(header).not.toHaveClass("border-b");
    const brandLink = within(header as HTMLElement).getByRole("link", { name: "EveChats" });
    expect(brandLink).toHaveClass("h-10");
    expect(within(header as HTMLElement).getByRole("button", { name: "Toggle theme" })).toBeInTheDocument();
    expect(container.querySelector('[data-sidebar="footer"]')).not.toBeInTheDocument();
  });

  it("offers New Chat and Agents navigation entries", async () => {
    const sidebar = await AppSidebar();
    render(<SidebarProvider>{sidebar}</SidebarProvider>);

    expect(screen.getByRole("link", { name: "New Chat" })).toHaveAttribute("href", "/chats/new");
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
  });
});
