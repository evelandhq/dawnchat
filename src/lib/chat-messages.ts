import type { UserContent } from "ai";

export const CHAT_ATTACHMENT_MAX_FILES = 8;
export const CHAT_ATTACHMENT_MAX_FILE_SIZE = 20 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH =
  Math.ceil((CHAT_ATTACHMENT_MAX_FILE_SIZE * 4) / 3) + 1024;

const PENDING_USER_CONTENT_PREFIX = "eve-chats:user-content:v1:";
const PENDING_USER_TEXT_PREFIX = "eve-chats:text:v1:";

type PromptMessage = {
  text: string;
  files: Array<{
    filename?: string;
    mediaType?: string;
    url: string;
  }>;
};

export function promptMessageToUserContent(message: PromptMessage): UserContent {
  const text = message.text.trim();
  if (message.files.length === 0) {
    return text;
  }

  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...message.files.map((file) => ({
      type: "file" as const,
      data: file.url,
      filename: file.filename?.trim() || "Attachment",
      mediaType: file.mediaType?.trim() || "application/octet-stream",
    })),
  ];
}

export function serializePendingUserContent(message: UserContent): string {
  if (typeof message !== "string") {
    return `${PENDING_USER_CONTENT_PREFIX}${JSON.stringify(message)}`;
  }

  return message.startsWith(PENDING_USER_CONTENT_PREFIX) ||
    message.startsWith(PENDING_USER_TEXT_PREFIX)
    ? `${PENDING_USER_TEXT_PREFIX}${JSON.stringify(message)}`
    : message;
}

export function deserializePendingUserContent(value: string | null): UserContent | null {
  if (!value) {
    return value;
  }

  try {
    if (value.startsWith(PENDING_USER_TEXT_PREFIX)) {
      const message = JSON.parse(value.slice(PENDING_USER_TEXT_PREFIX.length)) as unknown;
      return typeof message === "string" ? message : value;
    }
    if (value.startsWith(PENDING_USER_CONTENT_PREFIX)) {
      const content = JSON.parse(value.slice(PENDING_USER_CONTENT_PREFIX.length)) as unknown;
      return Array.isArray(content) ? (content as UserContent) : value;
    }
  } catch {
    return value;
  }
  return value;
}

export function userContentText(message: UserContent): string {
  if (typeof message === "string") {
    return message;
  }
  return message
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
