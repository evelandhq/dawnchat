/**
 * The Eve browser client requires a continuation token before it will resume
 * a session. The per-chat proxy replaces this sentinel with the real token
 * stored server-side, so the remote capability never reaches the browser.
 */
export const EVE_PROXY_CONTINUATION_TOKEN = "eve-chats:server-managed";
