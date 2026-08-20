import type { Metadata } from "next";

import { AuthenticatedChatThread } from "@/components/authenticated-chat-thread";

export const metadata: Metadata = {
  title: "Chat",
};

type ChatThreadPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function ChatThreadPage({ params }: ChatThreadPageProps): Promise<React.ReactElement> {
  const { chatId } = await params;

  return <AuthenticatedChatThread chatId={chatId} />;
}
