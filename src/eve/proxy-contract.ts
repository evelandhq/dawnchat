/**
 * Eve 0.29/0.30 agents address a session by continuation token; Eve 0.31
 * addresses it by session ID alone. EveChats keeps the real token server-side
 * for both generations, so it is dropped from every browser-facing payload
 * before it leaves the per-chat proxy.
 */
export function withoutContinuationToken<T extends Record<string, unknown>>(
  payload: T,
): Omit<T, "continuationToken"> {
  const { continuationToken: _redacted, ...rest } = payload;
  return rest;
}
