/**
 * An OS deployment's `/api` WebSocket URL from its http(s) base — the ONE
 * place that knows the path and the ws/wss protocol swap, shared by the
 * shared session and the one-shot Node client.
 */
export function apiWebSocketUrl(baseUrl: string): URL {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("an OS deployment base URL is required (the config's APP_CONFIG_BASE_URL)");
  }
  const url = new URL("/api", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
