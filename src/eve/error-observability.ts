import type { MessageStreamEvent } from "eve/client";

const ERROR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function readEveErrorId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const errorId = value.trim();
  return ERROR_ID_PATTERN.test(errorId) ? errorId : undefined;
}

export function sessionFailureErrorId(
  event: MessageStreamEvent | undefined,
): string | undefined {
  if (event?.type !== "session.failed") return undefined;
  return readEveErrorId(event.data.details?.errorId);
}

export function formatEveErrorMessage(
  message: string,
  errorId: string | undefined,
): string {
  if (!errorId || message.includes(`Error ID: ${errorId}`)) return message;
  return `${message} Error ID: ${errorId}`;
}
