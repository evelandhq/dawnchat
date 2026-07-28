import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { AuthenticatedChatThread } from "@/components/authenticated-chat-thread";

export const dynamic = "force-dynamic";

type ChatThreadPageProps = {
  params: Promise<{ chatId: string }>;
};

export async function getChatAccessHintForPage(
  chatId: string,
): Promise<{ evelandProjectId?: string } | null> {
  const repository = createRepository(getDbClient());
  const chat = await repository.getChat(chatId);
  if (
    !chat ||
    (
      !chat.ownerClientId &&
      (
        !chat.ownerIdentityPrincipalId ||
        !chat.ownerIdentityRealmId
      )
    )
  ) {
    return null;
  }
  return chat.evelandProjectId
    ? { evelandProjectId: chat.evelandProjectId }
    : {};
}

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Chat" };
}

export default async function ChatThreadPage({ params }: ChatThreadPageProps): Promise<React.ReactElement> {
  const { chatId } = await params;
  const hint = await getChatAccessHintForPage(chatId);
  if (!hint) {
    notFound();
  }

  return (
    <AuthenticatedChatThread
      chatId={chatId}
      evelandProjectId={hint.evelandProjectId}
    />
  );
}
