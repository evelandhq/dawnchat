# Agent Sidebar Entry Implementation Plan

> Status: **Completed.** The planned routes, components, and test coverage are
> present in the current repository.
> Status checked: 2026-08-22.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the agent dropdown in the new-chat form with agent-first sidebar avatar entries: clicking an avatar starts a new conversation with that agent, and the sidebar chat list scopes to the current agent.

**Architecture:** Frontend-only rework (zero backend API and drizzle schema changes). Two pure-function libs (avatar visuals, current-agent derivation) + three presentation/interaction components (AgentAvatar, NewChatComposer, AgentRecheckButton) + one sidebar client component (SidebarNav, rendering the agent grid and the agent-scoped chat list) + one new RSC page (`/agents/[agentId]`, the blank new-conversation page). `/` redirects to the default agent; `/chats` keeps only a redirect.

**Tech Stack:** Next.js App Router (typedRoutes), React 19 RSC, Tailwind v4, shadcn/ui (radix-nova), drizzle, vitest + @testing-library/react.

**Spec:** `.plans/designs/2026-07-13-agent-sidebar-entry-design.md`

## Global Constraints

- Backend API routes, `src/db/schema.ts`, and migrations must not change.
- TypeScript strict + `typedRoutes: true`: dynamic-path `Link href` and `router.push` need `as Route` assertions (follow existing code style).
- Style with Tailwind classes + the existing `cn()` (`src/lib/utils.ts`, twMerge semantics: later classes win on conflicts).
- All UI copy in English (matches the existing UI).
- No code comments by default (user preference).
- Test command: `pnpm test <file>` (vitest run); DB-backed tests require `pnpm db:up` first (Postgres 127.0.0.1:55433; `src/test/db.ts` creates an isolated schema per test).
- Do not start long-running services: the user runs `pnpm dev` themselves; this plan only uses one-shot commands (typecheck / test).

## Existing Facts an Implementer Needs

- `repository.listChats()` returns `Chat[]` ordered by `createdAt` **ascending**; `Chat` includes `agentConnectionId` (`src/db/repository.ts:29,74`).
- `repository.listAgentConnections()` is ordered by `createdAt` ascending (`src/db/repository.ts:139-141`).
- Chat creation: `POST /api/chats`, body `{ agentId, message }`, returns `{ chat: { id } }`; 409 `{ error }` when the agent is unreachable.
- Health check: `POST /api/agents/[agentId]/check` (exists, currently has no UI caller).
- `src/components/ui/avatar.tsx` exports `Avatar` (size: `"sm" | "default" | "lg"`, lg=size-10), `AvatarFallback`, `AvatarBadge` (bottom-right dot, className overridable).
- `src/components/ui/sidebar.tsx` exports `SidebarGroup/SidebarGroupLabel/SidebarGroupAction(asChild)/SidebarGroupContent/SidebarMenu/SidebarMenuButton(isActive)/SidebarMenuItem/SidebarProvider`. `SidebarMenuButton` uses `useSidebar()` internally, so tests must wrap renders in `SidebarProvider` (`src/test/setup.ts` already stubs `matchMedia`).
- Existing UI test conventions live in `tests/chat-ui.test.tsx` / `tests/agent-ui.test.tsx`: `vi.mock("next/navigation")`, `vi.mock("next/link")`, `vi.stubGlobal("fetch", …)`, and calling page data functions directly.

---

### Task 1: Agent avatar visual pure functions (initial + hashed color)

**Files:**
- Create: `src/lib/agent-visuals.ts`
- Test: `tests/agent-visuals.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `AGENT_AVATAR_COLOR_CLASSES: readonly string[]` (8 Tailwind background classes)
  - `agentInitial(name: string): string` (first character uppercased, `"?"` for blank names)
  - `agentColorClass(agentId: string): string` (stable hash → one of the preset classes)

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent-visuals.test.ts
import { describe, expect, it } from "vitest";

import { AGENT_AVATAR_COLOR_CLASSES, agentColorClass, agentInitial } from "@/lib/agent-visuals";

describe("agentInitial", () => {
  it("uses the first character uppercased", () => {
    expect(agentInitial("data bot")).toBe("D");
  });

  it("handles CJK names", () => {
    expect(agentInitial("数据助手")).toBe("数");
  });

  it("falls back to ? for blank names", () => {
    expect(agentInitial("   ")).toBe("?");
  });
});

describe("agentColorClass", () => {
  it("is stable for the same id", () => {
    expect(agentColorClass("agent_abc")).toBe(agentColorClass("agent_abc"));
  });

  it("always returns one of the preset classes", () => {
    for (const id of ["agent_a", "agent_b", "agent_c", "agent_中文", ""]) {
      expect(AGENT_AVATAR_COLOR_CLASSES).toContain(agentColorClass(id));
    }
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm test tests/agent-visuals.test.ts`
Expected: FAIL (`Cannot find module '@/lib/agent-visuals'` or equivalent)

- [ ] **Step 3: Minimal implementation**

```ts
// src/lib/agent-visuals.ts
export const AGENT_AVATAR_COLOR_CLASSES = [
  "bg-blue-600",
  "bg-emerald-600",
  "bg-violet-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-cyan-600",
  "bg-indigo-600",
  "bg-teal-600",
] as const;

export function agentInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

export function agentColorClass(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  }
  return AGENT_AVATAR_COLOR_CLASSES[Math.abs(hash) % AGENT_AVATAR_COLOR_CLASSES.length];
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test tests/agent-visuals.test.ts`
Expected: PASS (5 tests)

---

### Task 2: Current-agent / default-agent derivation pure functions

**Files:**
- Create: `src/lib/current-agent.ts`
- Test: `tests/current-agent.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `type CurrentAgentChat = { id: string; agentConnectionId: string }`
  - `pickDefaultAgentId(chats: CurrentAgentChat[], agentIds: string[]): string | null` — **chats passed newest first**; picks the most recent chat's agent, falls back to the first agent, null with no agents
  - `deriveCurrentAgentId(pathname: string, chats: CurrentAgentChat[], agentIds: string[]): string | null` — `/agents/[id]` (not `new` and known) → that id; `/chats/[chatId]` → that chat's agent; otherwise `pickDefaultAgentId`

- [ ] **Step 1: Write the failing test**

```ts
// tests/current-agent.test.ts
import { describe, expect, it } from "vitest";

import { deriveCurrentAgentId, pickDefaultAgentId, type CurrentAgentChat } from "@/lib/current-agent";

const agentIds = ["agent_a", "agent_b"];
const chats: CurrentAgentChat[] = [
  { id: "chat_3", agentConnectionId: "agent_b" },
  { id: "chat_2", agentConnectionId: "agent_a" },
  { id: "chat_1", agentConnectionId: "agent_a" },
];

describe("pickDefaultAgentId", () => {
  it("prefers the agent of the most recent chat", () => {
    expect(pickDefaultAgentId(chats, agentIds)).toBe("agent_b");
  });

  it("falls back to the first agent when there are no chats", () => {
    expect(pickDefaultAgentId([], agentIds)).toBe("agent_a");
  });

  it("skips chats whose agent no longer exists", () => {
    expect(pickDefaultAgentId([{ id: "chat_x", agentConnectionId: "agent_gone" }], agentIds)).toBe("agent_a");
  });

  it("returns null when there are no agents", () => {
    expect(pickDefaultAgentId(chats, [])).toBeNull();
  });
});

describe("deriveCurrentAgentId", () => {
  it("uses the agent id from /agents/[agentId]", () => {
    expect(deriveCurrentAgentId("/agents/agent_a", chats, agentIds)).toBe("agent_a");
  });

  it("does not treat /agents/new as an agent", () => {
    expect(deriveCurrentAgentId("/agents/new", chats, agentIds)).toBe("agent_b");
  });

  it("ignores unknown agent ids in the path", () => {
    expect(deriveCurrentAgentId("/agents/agent_gone", chats, agentIds)).toBe("agent_b");
  });

  it("uses the chat's agent on /chats/[chatId]", () => {
    expect(deriveCurrentAgentId("/chats/chat_2", chats, agentIds)).toBe("agent_a");
  });

  it("falls back to the default agent elsewhere", () => {
    expect(deriveCurrentAgentId("/agents", chats, agentIds)).toBe("agent_b");
  });

  it("returns null with no agents at all", () => {
    expect(deriveCurrentAgentId("/", [], [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm test tests/current-agent.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Minimal implementation**

```ts
// src/lib/current-agent.ts
export type CurrentAgentChat = {
  id: string;
  agentConnectionId: string;
};

export function pickDefaultAgentId(chats: CurrentAgentChat[], agentIds: string[]): string | null {
  const known = new Set(agentIds);
  const recent = chats.find((chat) => known.has(chat.agentConnectionId));
  return recent?.agentConnectionId ?? agentIds[0] ?? null;
}

export function deriveCurrentAgentId(
  pathname: string,
  chats: CurrentAgentChat[],
  agentIds: string[],
): string | null {
  const agentMatch = pathname.match(/^\/agents\/([^/]+)\/?$/);
  if (agentMatch && agentMatch[1] !== "new" && agentIds.includes(agentMatch[1])) {
    return agentMatch[1];
  }

  const chatMatch = pathname.match(/^\/chats\/([^/]+)\/?$/);
  if (chatMatch) {
    const chat = chats.find((item) => item.id === chatMatch[1]);
    if (chat && agentIds.includes(chat.agentConnectionId)) {
      return chat.agentConnectionId;
    }
  }

  return pickDefaultAgentId(chats, agentIds);
}
```

(Contract: both functions take `chats` **newest first**; callers are responsible for reversing.)

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test tests/current-agent.test.ts`
Expected: PASS (10 tests)

---

### Task 3: AgentAvatar component

**Files:**
- Create: `src/components/agent-avatar.tsx`
- Test: `tests/agent-avatar.test.tsx`

**Interfaces:**
- Consumes: `agentInitial` / `agentColorClass` from Task 1; `Avatar` (size prop) / `AvatarFallback` / `AvatarBadge` from `ui/avatar`
- Produces:
  - `AgentAvatar(props: { agentId: string; name: string; size?: "sm" | "default" | "lg"; showUnreachableDot?: boolean; className?: string; fallbackClassName?: string }): React.ReactElement`
  - The unreachable dot contains `<span className="sr-only">unreachable</span>` (for tests and screen readers)

- [ ] **Step 1: Write the failing test**

```tsx
// tests/agent-avatar.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AgentAvatar } from "@/components/agent-avatar";

describe("AgentAvatar", () => {
  it("renders the uppercased initial of the agent name", () => {
    render(React.createElement(AgentAvatar, { agentId: "agent_1", name: "data bot" }));
    expect(screen.getByText("D")).toBeInTheDocument();
  });

  it("shows an unreachable dot only when asked", () => {
    const { rerender } = render(
      React.createElement(AgentAvatar, { agentId: "agent_1", name: "Data Bot", showUnreachableDot: true }),
    );
    expect(screen.getByText("unreachable")).toBeInTheDocument();

    rerender(React.createElement(AgentAvatar, { agentId: "agent_1", name: "Data Bot" }));
    expect(screen.queryByText("unreachable")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm test tests/agent-avatar.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Minimal implementation**

```tsx
// src/components/agent-avatar.tsx
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar";
import { agentColorClass, agentInitial } from "@/lib/agent-visuals";
import { cn } from "@/lib/utils";

type AgentAvatarProps = {
  agentId: string;
  name: string;
  size?: "sm" | "default" | "lg";
  showUnreachableDot?: boolean;
  className?: string;
  fallbackClassName?: string;
};

export function AgentAvatar({
  agentId,
  name,
  size = "default",
  showUnreachableDot = false,
  className,
  fallbackClassName,
}: AgentAvatarProps): React.ReactElement {
  return (
    <Avatar size={size} className={className}>
      <AvatarFallback className={cn("font-medium text-white", agentColorClass(agentId), fallbackClassName)}>
        {agentInitial(name)}
      </AvatarFallback>
      {showUnreachableDot ? (
        <AvatarBadge className="bg-destructive">
          <span className="sr-only">unreachable</span>
        </AvatarBadge>
      ) : null}
    </Avatar>
  );
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test tests/agent-avatar.test.tsx`
Expected: PASS (2 tests)

---

### Task 4: NewChatComposer component (extracted from chat-list, select removed)

**Files:**
- Create: `src/components/new-chat-composer.tsx`
- Test: `tests/new-chat-composer.test.tsx`

(This task only adds the component; deleting `chat-list.tsx` happens in Task 8.)

**Interfaces:**
- Consumes: `POST /api/chats` (body `{ agentId, message }` → `{ chat: { id } }`); `ui/button`, `ui/label`
- Produces:
  - `NewChatComposer(props: { agentId: string; agentName: string; disabled?: boolean }): React.ReactElement`
  - The textarea's accessible name is `"First message"` (sr-only label); submit button copy `"Start chat"` / `"Starting…"` while pending; failures render a `role="alert"` message

- [ ] **Step 1: Write the failing test**

```tsx
// tests/new-chat-composer.test.tsx
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

  it("posts the first message for the bound agent and navigates to the created chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ chat: { id: "chat_created" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot" }));

    fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Hello Eve" } });
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
  });

  it("disables input and submit when disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(NewChatComposer, { agentId: "agent_a", agentName: "Data Bot", disabled: true }));

    expect(screen.getByLabelText("First message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start chat" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm test tests/new-chat-composer.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Minimal implementation**

```tsx
// src/components/new-chat-composer.tsx
"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type NewChatComposerProps = {
  agentId: string;
  agentName: string;
  disabled?: boolean;
};

type CreateChatResponse = {
  chat?: {
    id: string;
  };
  error?: string;
};

export function NewChatComposer({ agentId, agentName, disabled = false }: NewChatComposerProps): React.ReactElement {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError("Enter a first message.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, message: trimmedMessage }),
      });
      const body = (await response.json()) as CreateChatResponse;
      if (!response.ok || !body.chat?.id) {
        setError(body.error ?? "Unable to start chat.");
        return;
      }
      router.push(`/chats/${body.chat.id}` as Route);
      router.refresh();
    } catch {
      setError("Unable to start chat.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="w-full space-y-3">
      <form
        onSubmit={onSubmit}
        className="border-border/60 bg-muted/30 focus-within:border-border flex flex-col gap-2 rounded-3xl border p-3 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08)] transition-colors"
      >
        <Label htmlFor="new-chat-message" className="sr-only">
          First message
        </Label>
        <textarea
          id="new-chat-message"
          value={message}
          disabled={disabled || isSubmitting}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={3}
          placeholder={`Message ${agentName}...`}
          className="placeholder:text-muted-foreground/80 max-h-48 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="flex items-center justify-end">
          <Button type="submit" size="sm" disabled={disabled || isSubmitting} className="rounded-full">
            <ArrowUp />
            {isSubmitting ? "Starting…" : "Start chat"}
          </Button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-destructive text-center text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test tests/new-chat-composer.test.tsx`
Expected: PASS (3 tests)

---

### Task 5: AgentRecheckButton component (wires up the health-check API)

**Files:**
- Create: `src/components/agent-recheck-button.tsx`
- Test: `tests/agent-recheck-button.test.tsx`

**Interfaces:**
- Consumes: `POST /api/agents/[agentId]/check` (existing route)
- Produces:
  - `AgentRecheckButton(props: { agentId: string }): React.ReactElement`
  - Button copy `"Check again"` / `"Checking…"` while pending; `router.refresh()` on success; failures render `role="alert"`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/agent-recheck-button.test.tsx
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
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent_a/check", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("shows an error when the health check request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(AgentRecheckButton, { agentId: "agent_a" }));

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Health check failed.");
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm test tests/agent-recheck-button.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Minimal implementation**

```tsx
// src/components/agent-recheck-button.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export function AgentRecheckButton({ agentId }: { agentId: string }): React.ReactElement {
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCheck(): Promise<void> {
    setError(null);
    setIsChecking(true);
    try {
      const response = await fetch(`/api/agents/${agentId}/check`, { method: "POST" });
      if (!response.ok) {
        setError("Health check failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Health check failed.");
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button type="button" variant="outline" size="sm" onClick={onCheck} disabled={isChecking}>
        <RefreshCw />
        {isChecking ? "Checking…" : "Check again"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test tests/agent-recheck-button.test.tsx`
Expected: PASS (2 tests)

---

### Task 6: SidebarNav (agent grid + agent-scoped chat list) wired into AppSidebar

**Files:**
- Create: `src/components/sidebar-nav.tsx`
- Modify: `src/components/app-sidebar.tsx` (full replacement, see Step 5)
- Delete: `src/components/sidebar-chat-nav.tsx`
- Test: `tests/sidebar-nav.test.tsx`

**Interfaces:**
- Consumes: `deriveCurrentAgentId` from Task 2, `AgentAvatar` from Task 3, `ui/sidebar` primitives
- Produces:
  - `type SidebarAgentItem = { id: string; name: string; status: "unknown" | "healthy" | "unreachable" }`
  - `type SidebarChatItem = { id: string; title: string; agentConnectionId: string }`
  - `SidebarNav(props: { agents: SidebarAgentItem[]; chats: SidebarChatItem[] }): React.ReactElement` — **chats passed newest first**
  - The "+" in the Chats group header is a link with `aria-label="New chat"` pointing to `/agents/[currentAgentId]`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/sidebar-nav.test.tsx
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SidebarNav, type SidebarAgentItem, type SidebarChatItem } from "@/components/sidebar-nav";
import { SidebarProvider } from "@/components/ui/sidebar";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement("a", { href, ...props }, children),
}));

const agents: SidebarAgentItem[] = [
  { id: "agent_a", name: "Data Bot", status: "healthy" },
  { id: "agent_b", name: "Ops Bot", status: "unreachable" },
];

const chats: SidebarChatItem[] = [
  { id: "chat_3", title: "Deploy check", agentConnectionId: "agent_b" },
  { id: "chat_2", title: "Weekly report", agentConnectionId: "agent_a" },
  { id: "chat_1", title: "Sales analysis", agentConnectionId: "agent_a" },
];

function renderNav(): void {
  render(
    React.createElement(SidebarProvider, null, React.createElement(SidebarNav, { agents, chats })),
  );
}

describe("SidebarNav", () => {
  afterEach(() => {
    pathname = "/";
  });

  it("renders one entry per agent plus a New agent link", () => {
    renderNav();
    expect(screen.getByRole("link", { name: /Data Bot/ })).toHaveAttribute("href", "/agents/agent_a");
    expect(screen.getByRole("link", { name: /Ops Bot/ })).toHaveAttribute("href", "/agents/agent_b");
    expect(screen.getByRole("link", { name: /New agent/ })).toHaveAttribute("href", "/agents/new");
  });

  it("marks unreachable agents with a dot", () => {
    renderNav();
    expect(screen.getByText("unreachable")).toBeInTheDocument();
  });

  it("scopes the chat list to the agent in the path", () => {
    pathname = "/agents/agent_a";
    renderNav();
    expect(screen.getByText("Weekly report")).toBeInTheDocument();
    expect(screen.getByText("Sales analysis")).toBeInTheDocument();
    expect(screen.queryByText("Deploy check")).not.toBeInTheDocument();
  });

  it("scopes the chat list to the open chat's agent", () => {
    pathname = "/chats/chat_2";
    renderNav();
    expect(screen.getByText("Weekly report")).toBeInTheDocument();
    expect(screen.queryByText("Deploy check")).not.toBeInTheDocument();
  });

  it("points the group + action at the current agent's new chat page", () => {
    pathname = "/agents/agent_b";
    renderNav();
    expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/agents/agent_b");
  });

  it("falls back to the most recent chat's agent on unrelated routes", () => {
    pathname = "/agents";
    renderNav();
    expect(screen.getByText("Deploy check")).toBeInTheDocument();
    expect(screen.queryByText("Weekly report")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm test tests/sidebar-nav.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement SidebarNav**

```tsx
// src/components/sidebar-nav.tsx
"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { MessageSquare, Plus } from "lucide-react";

import { AgentAvatar } from "@/components/agent-avatar";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { deriveCurrentAgentId } from "@/lib/current-agent";
import { cn } from "@/lib/utils";

export type SidebarAgentItem = {
  id: string;
  name: string;
  status: "unknown" | "healthy" | "unreachable";
};

export type SidebarChatItem = {
  id: string;
  title: string;
  agentConnectionId: string;
};

type SidebarNavProps = {
  agents: SidebarAgentItem[];
  chats: SidebarChatItem[];
};

export function SidebarNav({ agents, chats }: SidebarNavProps): React.ReactElement {
  const pathname = usePathname();
  const currentAgentId = deriveCurrentAgentId(
    pathname,
    chats,
    agents.map((agent) => agent.id),
  );
  const currentAgentChats = chats.filter((chat) => chat.agentConnectionId === currentAgentId);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="flex flex-wrap gap-1 px-1 py-1">
            {agents.map((agent) => (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}` as Route}
                title={agent.name}
                className={cn(
                  "hover:bg-sidebar-accent flex w-16 flex-col items-center gap-1 rounded-lg p-2 transition-colors",
                  agent.id === currentAgentId && "bg-sidebar-accent",
                )}
              >
                <AgentAvatar
                  agentId={agent.id}
                  name={agent.name}
                  size="lg"
                  showUnreachableDot={agent.status === "unreachable"}
                />
                <span className="text-sidebar-foreground/80 w-full truncate text-center text-xs">{agent.name}</span>
              </Link>
            ))}
            <Link
              href={"/agents/new" as Route}
              className="hover:bg-sidebar-accent flex w-16 flex-col items-center gap-1 rounded-lg p-2 transition-colors"
            >
              <span className="border-sidebar-foreground/30 text-sidebar-foreground/60 flex size-10 items-center justify-center rounded-full border border-dashed">
                <Plus className="size-4" />
              </span>
              <span className="text-sidebar-foreground/60 w-full truncate text-center text-xs">New agent</span>
            </Link>
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Chats</SidebarGroupLabel>
        {currentAgentId ? (
          <SidebarGroupAction asChild title="New chat">
            <Link href={`/agents/${currentAgentId}` as Route} aria-label="New chat">
              <Plus />
            </Link>
          </SidebarGroupAction>
        ) : null}
        <SidebarGroupContent>
          {currentAgentChats.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">No chats yet.</p>
          ) : (
            <SidebarMenu>
              {currentAgentChats.map((chat) => (
                <SidebarMenuItem key={chat.id}>
                  <SidebarMenuButton asChild isActive={pathname === `/chats/${chat.id}`} title={chat.title}>
                    <Link href={`/chats/${chat.id}` as Route}>
                      <MessageSquare />
                      <span className="truncate">{chat.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test tests/sidebar-nav.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Rewrite AppSidebar and delete sidebar-chat-nav**

Replace `src/components/app-sidebar.tsx` entirely with:

```tsx
import Link from "next/link";
import type { Route } from "next";
import { Bot, Sparkles } from "lucide-react";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { SidebarNav, type SidebarAgentItem, type SidebarChatItem } from "@/components/sidebar-nav";
import { ThemeToggle } from "@/components/theme-toggle";

export async function AppSidebar(): Promise<React.ReactElement> {
  const repository = createRepository(getDbClient());
  const [agents, chats] = await Promise.all([repository.listAgentConnections(), repository.listChats()]);
  const agentItems: SidebarAgentItem[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
  }));
  const chatItems: SidebarChatItem[] = chats
    .map((chat) => ({ id: chat.id, title: chat.title, agentConnectionId: chat.agentConnectionId }))
    .reverse();

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <Link href={"/" as Route}>
                <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
                  <Sparkles className="size-4" />
                </div>
                <span className="text-base font-semibold">Eve Chats</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarNav agents={agentItems} chats={chatItems} />
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between gap-2">
          <SidebarMenu className="flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/agents">
                  <Bot />
                  Agents
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
```

(Changes: the "New chat" button and the `Button`/`MessageSquarePlus` imports are gone; the logo link goes `/chats` → `/`; the single Chats group is replaced by `SidebarNav`.)

Then delete the old component:

Run: `rm src/components/sidebar-chat-nav.tsx`

- [ ] **Step 6: Confirm no dangling references**

Run: `grep -rn "sidebar-chat-nav\|SidebarChatNav" src tests`
Expected: no output

---

### Task 7: `/agents/[agentId]` new-conversation page

**Files:**
- Create: `src/app/agents/[agentId]/page.tsx`
- Test: `tests/agent-new-chat-page.test.ts`

**Interfaces:**
- Consumes: `AgentAvatar` (Task 3), `NewChatComposer` (Task 4), `AgentRecheckButton` (Task 5), `StatusBadge`, `repository.getAgentConnection`
- Produces:
  - `getAgentForNewChatPage(agentId: string): Promise<{ id: string; name: string; status: "unknown" | "healthy" | "unreachable" } | null>` (callable from tests, following the `getChatThreadForPage` convention)
  - Default export: async RSC page; unknown agent → `notFound()`

- [ ] **Step 1: Write the failing test** (requires `pnpm db:up`)

```ts
// tests/agent-new-chat-page.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAgentForNewChatPage } from "@/app/agents/[agentId]/page";
import { createRepository } from "@/db/repository";
import { setDbClientForTests } from "@/db/provider";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

describe("getAgentForNewChatPage", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
  });

  it("returns id, name and status for an existing agent", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Data Bot",
      baseUrl: "https://data-bot.example.com",
      authType: "none",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });

    await expect(getAgentForNewChatPage(agent.id)).resolves.toEqual({
      id: agent.id,
      name: "Data Bot",
      status: "healthy",
    });
  });

  it("returns null for an unknown agent id", async () => {
    await expect(getAgentForNewChatPage("agent_missing")).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm db:up && pnpm test tests/agent-new-chat-page.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the page**

```tsx
// src/app/agents/[agentId]/page.tsx
import { notFound } from "next/navigation";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentRecheckButton } from "@/components/agent-recheck-button";
import { NewChatComposer } from "@/components/new-chat-composer";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

type AgentNewChatPageProps = {
  params: Promise<{ agentId: string }>;
};

type AgentNewChatPageData = {
  id: string;
  name: string;
  status: "unknown" | "healthy" | "unreachable";
};

export async function getAgentForNewChatPage(agentId: string): Promise<AgentNewChatPageData | null> {
  const repository = createRepository(getDbClient());
  const agent = await repository.getAgentConnection(agentId);
  if (!agent) {
    return null;
  }

  return { id: agent.id, name: agent.name, status: agent.status };
}

export default async function AgentNewChatPage({ params }: AgentNewChatPageProps): Promise<React.ReactElement> {
  const { agentId } = await params;
  const agent = await getAgentForNewChatPage(agentId);
  if (!agent) {
    notFound();
  }

  const isHealthy = agent.status === "healthy";

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 px-6 py-12 sm:py-20">
      <AgentAvatar
        agentId={agent.id}
        name={agent.name}
        size="lg"
        className="size-16"
        fallbackClassName="text-2xl"
        showUnreachableDot={agent.status === "unreachable"}
      />
      <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
      {isHealthy ? null : (
        <div className="flex flex-col items-center gap-3">
          <StatusBadge status={agent.status} />
          <p className="text-muted-foreground text-center text-sm">
            This agent is not available right now. Run a health check before starting a chat.
          </p>
          <AgentRecheckButton agentId={agent.id} />
        </div>
      )}
      <NewChatComposer agentId={agent.id} agentName={agent.name} disabled={!isHealthy} />
    </section>
  );
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test tests/agent-new-chat-page.test.ts`
Expected: PASS (2 tests)

---

### Task 8: `/` default landing, `/chats` redirect, delete ChatList, clean up old tests

**Files:**
- Modify: `src/app/page.tsx` (full replacement)
- Modify: `src/app/chats/page.tsx` (full replacement)
- Delete: `src/components/chat-list.tsx`
- Modify: `tests/chat-ui.test.tsx` (remove the ChatList-related parts)

**Interfaces:**
- Consumes: `pickDefaultAgentId` from Task 2
- Produces: no new interfaces (page layer)

- [ ] **Step 1: Rewrite the root page**

```tsx
// src/app/page.tsx
import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { pickDefaultAgentId } from "@/lib/current-agent";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<React.ReactElement> {
  const repository = createRepository(getDbClient());
  const [agents, chats] = await Promise.all([repository.listAgentConnections(), repository.listChats()]);
  const defaultAgentId = pickDefaultAgentId(
    chats.map((chat) => ({ id: chat.id, agentConnectionId: chat.agentConnectionId })).reverse(),
    agents.map((agent) => agent.id),
  );

  if (defaultAgentId) {
    redirect(`/agents/${defaultAgentId}`);
  }

  return (
    <section className="mx-auto flex w-full max-w-md flex-col items-center gap-6 px-6 py-24 text-center">
      <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-2xl">
        <Sparkles className="size-6" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome to Eve Chats</h1>
      <p className="text-muted-foreground text-sm">Connect your first Eve agent to start chatting.</p>
      <Button asChild>
        <Link href={"/agents/new" as Route}>Connect an agent</Link>
      </Button>
    </section>
  );
}
```

- [ ] **Step 2: Reduce `/chats` to a redirect**

```tsx
// src/app/chats/page.tsx
import { redirect } from "next/navigation";

export default function ChatsPage(): never {
  redirect("/");
}
```

- [ ] **Step 3: Delete ChatList**

Run: `rm src/components/chat-list.tsx`

- [ ] **Step 4: Clean up `tests/chat-ui.test.tsx`**

Remove the following (all three `ChatThread` describe blocks stay):
- Import line: `import { ChatList, type ChatListAgent, type ChatListSummary } from "@/components/chat-list";`
- Import line: `import { getChatsForPage } from "@/app/chats/page";`
- The whole `describe("ChatsPage data loading", …)` block (old L28-75)
- The whole `describe("ChatList", …)` block (old L77-131)

(Their coverage is taken over by `tests/new-chat-composer.test.tsx` and `tests/sidebar-nav.test.tsx`.)

- [ ] **Step 5: Confirm no dangling references**

Run: `grep -rn "chat-list\|ChatList\|getChatsForPage" src tests`
Expected: no output

- [ ] **Step 6: Run the affected tests**

Run: `pnpm test tests/chat-ui.test.tsx`
Expected: PASS (only the ChatThread tests remain)

---

### Task 9: Full verification

**Files:** no new changes

- [ ] **Step 1: Type check**

Run: `pnpm typecheck`
Expected: zero errors (watch for typedRoutes recognition of `/agents/[agentId]`; if the route types have not been generated yet, run `pnpm build` instead to verify)

- [ ] **Step 2: Full test suite**

Run: `pnpm db:up && pnpm test`
Expected: all PASS (including the existing repository / api / chat-flow / agent-ui / chat-ui suites)

- [ ] **Step 3: Manual verification checklist (handed to the user, who runs `pnpm dev`)**

1. Open `/`: with agents present it redirects to the default agent's new-conversation page; with none it shows the "Welcome to Eve Chats" onboarding.
2. Sidebar: the Agents grid shows every agent (unreachable ones with a red dot) plus the dashed "New agent" item; there is no "New chat" button.
3. Click another agent's avatar: its new-conversation page opens and the Chats list below switches to that agent's conversations.
4. Send a first message on the new-conversation page: a chat is created and the app navigates to `/chats/[id]`, with that item highlighted in the sidebar.
5. The "+" in the Chats group header: returns to the current agent's new-conversation page.
6. An unhealthy agent: composer disabled, status badge and hint shown, "Check again" triggers a health check and the page refreshes.
7. Visit `/chats`: redirects to `/`.

---

## Plan Self-Review Notes

- **Spec coverage**: product decision 1 (avatar click starts a new conversation) → Tasks 6/7; decision 2 (scoped list + "+") → Task 6; decision 3 (remove generic new-chat entries and /chats) → Task 6 Step 5, Task 8; decision 4 (initial + hashed-color avatars) → Tasks 1/3; decision 5 (unhealthy agents stay visible + hint/recheck) → Task 6 (dot) / Tasks 5/7; default landing rules → Tasks 2/8; edge cases (zero agents, 404, 409, /chats redirect) → Tasks 7/8 plus the NewChatComposer error branch; testing requirements → embedded per task.
- **No placeholders**: every step carries complete code and commands.
- **Type consistency**: `SidebarAgentItem`/`SidebarChatItem` (defined in Task 6, consumed by AppSidebar), `CurrentAgentChat` (defined in Task 2, consumed by Tasks 6/8), `AgentAvatar` props (defined in Task 3, consumed by Tasks 6/7), `NewChatComposer` props (defined in Task 4, consumed by Task 7) all cross-checked.
- **One declared deviation from the spec (implementation detail)**: the spec lists "new `sidebar-agent-nav.tsx` + reworked `sidebar-chat-nav.tsx`"; the plan merges them into a single `sidebar-nav.tsx` — both sections share the same current-agent derivation, and splitting them would either duplicate the derivation or add a wrapper component. Interaction and information architecture match the spec exactly.
