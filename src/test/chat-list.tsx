import React, { type ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";

import { ChatListProvider } from "@/components/chat-list-provider";

/**
 * Renders inside the provider that owns the app's single `/api/chats` read, the
 * way the root layout wraps every page.
 */
export function renderWithChatList(ui: ReactNode): RenderResult {
  return render(<ChatListProvider>{ui}</ChatListProvider>);
}
