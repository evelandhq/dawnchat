import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  APP_BROWSER_SESSION_COOKIE,
  verifyAppBrowserSessionToken,
} from "@/app-session";
import { HomeRedirect } from "@/components/home-redirect";
import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";

export const dynamic = "force-dynamic";

/**
 * Every chat this browser started is owned by its browser session, so the
 * newest one resolves here without waiting on hydration or an Identity
 * round trip. A browser signed into an Identity that owns chats it did not
 * start falls through to the client, which can read that scope with an App
 * Token.
 */
export default async function HomePage(): Promise<React.ReactElement> {
  const cookieStore = await cookies();
  const clientId = verifyAppBrowserSessionToken(
    cookieStore.get(APP_BROWSER_SESSION_COOKIE)?.value,
  );
  if (clientId) {
    const chatId = await createRepository(
      getDbClient(),
    ).findLatestChatIdForClient(clientId);
    if (chatId) redirect(`/chats/${encodeURIComponent(chatId)}` as Route);
  }

  return <HomeRedirect />;
}
