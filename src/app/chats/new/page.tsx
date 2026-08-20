import type { Metadata } from "next";

import { NewChatPicker } from "@/components/new-chat-picker";

export const metadata: Metadata = {
  title: "New Chat",
};

export default function NewChatPage(): React.ReactElement {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">New chat</h1>
        <p className="text-muted-foreground text-sm">Choose an agent to start a new chat with.</p>
      </div>
      <NewChatPicker />
    </section>
  );
}
