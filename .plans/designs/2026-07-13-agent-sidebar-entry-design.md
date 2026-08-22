# Agent Sidebar Entry Design

Date: 2026-07-13
Status: **Implemented** (v2, revised to the agent-first chat layout).
Status checked: 2026-08-22.

## Background and Goal

Today the only way to pick an agent in eve-chats is a native `<select>` dropdown inside the composer on the `/chats` new-chat page. The goal is to switch to an agent-first model: **agent selection no longer happens inside the new-chat form; instead every agent gets its own avatar entry on the left sidebar**. The avatar is the context switcher: clicking an agent's avatar starts a new conversation with that agent, and the sidebar chat list scopes to that agent's conversations.

## Confirmed Product Decisions

1. **Clicking an agent avatar starts a new conversation with that agent**: it opens a blank new-conversation page (large avatar + name + composer). The chat is only created when the first message is sent, then the user is taken to the conversation thread. There is no "agent home" page with a history list.
2. **Sidebar = agent avatar section + chat list scoped to the current agent**: the list only shows the current agent's conversations; the list's group header has a "+" on the right that also starts a new conversation with the current agent (equivalent to clicking the avatar).
3. **No generic "new chat" button anywhere**: the old sidebar "New chat" button and the `/chats` page composer (with its agent dropdown) are removed; the `/chats` global list page is removed entirely.
4. **Auto-generated avatars**: the first character of the agent name on a preset color assigned by hashing the agent id. Zero schema changes; no custom avatar field.
5. **Unhealthy agents stay visible**: unreachable agents get a small red dot on the avatar and remain clickable; the new-conversation page disables the composer and shows a status hint plus a "check again" button.

## Chosen Approach

**A dedicated route `/agents/[agentId]` hosts the new-conversation page** (the routing skeleton of option A, with the page content revised in v2).

Rejected alternatives:
- `/chats?agent=xxx` query-param branching: one page with two shapes, poor URL semantics, awkward highlight logic.
- Merging the new-conversation page with agent management (Settings tab plus edit/delete): edit/delete is brand-new API + form work unrelated to this goal — YAGNI.
- An "agent home" page with that agent's history list (the v1 design): the history list is already covered by the agent-scoped sidebar, so repeating it in the main area adds nothing.

## Information Architecture and Routes

| Route | Change |
|---|---|
| `/` | **Changed**: redirects to the default agent's new-conversation page `/agents/[id]`; with zero agents it renders an onboarding page |
| `/chats` | **Changed**: page removed, keeps only a redirect to `/` (its listing role moves to the sidebar) |
| `/chats/[chatId]` | Unchanged (conversation thread) |
| `/agents/[agentId]` | **New**: blank new-conversation page for that agent |
| `/agents` | Unchanged (management list, footer entry stays) |
| `/agents/new` | Unchanged (Next.js static routes take precedence over `[agentId]`, no conflict) |

**Default agent resolution** (used by the `/` redirect): the agent of the most recently created chat → falls back to the first agent (by createdAt) → with zero agents, render the onboarding page (pointing to `/agents/new`).

## Sidebar (`src/components/app-sidebar.tsx`)

- **Header**: logo only; the "New chat" button is removed.
- **Content**, two `SidebarGroup`s:
  - **Agents** (top): an avatar grid (wrapping flex). Each item = round initial avatar + truncated name; unreachable agents get a red dot on the avatar corner; the last item is a dashed circle "+ New agent" linking to `/agents/new`. Clicking an avatar goes to `/agents/[agentId]`; the current agent is highlighted.
  - **Chats**: shows only the **current agent's** conversations, newest first; the group header row has a "+" on the right (the existing `SidebarGroupAction`) linking to `/agents/[currentAgentId]`.
- **Footer**: unchanged (Agents management link + ThemeToggle).
- **Client-side current-agent derivation** (in a new client component, using `usePathname` plus the passed-in data):
  - `/agents/[agentId]` → the agentId in the path;
  - `/chats/[chatId]` → look up that chat's `agentConnectionId` in the passed-in chats;
  - other routes (e.g. `/agents`, `/agents/new`) → fall back to the most recent chat's agent, then to the first agent.
- Data: app-sidebar is already an RSC querying the DB directly; it now fetches `listAgentConnections()` plus the full chat list (with `agentConnectionId`). Filtering happens on the client (the data set is small, and the layout cannot read route params).

## New-Conversation Page (`/agents/[agentId]`, new)

- RSC querying the DB directly: `getAgentConnection(agentId)`; not found → `notFound()`.
- Page, top to bottom: centered large avatar + agent name (with a `StatusBadge` when not healthy) + composer. No history list.
- Healthy: composer enabled; the first message goes through the existing `POST /api/chats {agentId, message}` to create the chat, then navigates to `/chats/[id]`.
- Not healthy: composer disabled + status hint + a "check again" button wired to the existing but previously unused `POST /api/agents/[agentId]/check`, followed by `router.refresh()` on success.

## Components and Data Flow

**New:**
- `src/components/agent-avatar.tsx` — reusable initial avatar built on the existing `ui/avatar.tsx`. Eight preset colors readable in both light and dark themes (medium saturation + white text), assigned by hashing the agentId string; the same agent always gets the same color. Size variants (small for the sidebar / large for the new-conversation page).
- `src/components/sidebar-agent-nav.tsx` — client component: agent avatar grid + the dashed "New agent" item + current-agent highlight.
- `src/components/sidebar-chat-nav.tsx` rework — client component: filters chats by the derived current agent + the group-header "+" action.
- `src/components/new-chat-composer.tsx` — client component extracted from `chat-list.tsx`, props `{ agentId, disabled }`: textarea + submit + error display, submit logic moved as-is (`POST /api/chats` → `router.push`).

**Modified:**
- `src/components/app-sidebar.tsx` — fetches agents + the full chat list (with `agentConnectionId`), renders the two groups, removes the New chat button.
- `src/app/page.tsx` — `/` redirect logic (default-agent resolution + zero-agent onboarding page).
- `src/db/repository.ts` — no changes needed (`listChats()` already returns `Chat` including `agentConnectionId`, `repository.ts:29`).

**Removed:**
- `src/components/chat-list.tsx` (removed entirely once the composer is extracted); `src/app/chats/page.tsx` becomes a bare `redirect("/")`.

**Unchanged:**
- Zero backend API changes (reuses `POST /api/chats` and `POST /api/agents/[agentId]/check`).
- The conversation thread page `/chats/[chatId]` is untouched.
- Data patterns stay "RSC queries the DB + client fetch for writes + `router.refresh()`"; no new state library.
- `native-select.tsx` stays (still used by the authType select in `agent-connection-form.tsx`).

## Edge Cases

- **Zero agents**: `/` renders the onboarding page; the sidebar Agents section shows only the New agent item; the Chats section is hidden or shows an empty state.
- **Unknown agentId**: `notFound()`.
- **Agent goes down right as a message is sent**: the existing API returns 409; the composer reuses the existing error display.
- **Deleting an agent**: the DB cascade removes its chats, unchanged behavior (no delete UI this round); if the deleted agent was current, the next visit falls back via default-agent resolution.
- **Direct visits to the removed `/chats`**: redirect to `/`.

## Testing

- Unit tests for the avatar hash function: stable for the same id, roughly spread across ids.
- Unit tests for the current-agent derivation (pure function: pathname + chats + agents → agentId).
- Component tests following the `tests/agent-ui.test.tsx` / `tests/chat-ui.test.tsx` conventions: sidebar Agents section rendering (red dot, New agent item, highlight), chat list filtered by current agent, composer disabled when not healthy, navigation after composer submit.
- Manual verification (user runs dev locally): click an avatar to start a new conversation, send the first message to create a chat, switch avatars and watch the list follow, "+" starts a new conversation, re-check an unhealthy agent.
