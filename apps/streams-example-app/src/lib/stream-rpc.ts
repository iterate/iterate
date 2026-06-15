import {
  streamConnectionFromWebSocket,
  toWebSocketUrl,
  type StreamConnection,
} from "./stream-connection.ts";

type StreamBrowserConnectionStatus = "connecting" | "connected" | "closed" | "error";

/** Connects browser JavaScript to one stream URL over capnweb-WebSocket. */
export async function withStreamConnectionFromBrowser(args: {
  url: string | URL;
  onConnectionStatusChange?: (
    status: StreamBrowserConnectionStatus,
    error: string | undefined,
  ) => void;
}): Promise<StreamConnection> {
  const browserUrl = new URL(args.url, window.location.href);
  const webSocket = new WebSocket(toWebSocketUrl(browserUrl));
  args.onConnectionStatusChange?.("connecting", undefined);
  webSocket.addEventListener("open", () => args.onConnectionStatusChange?.("connected", undefined));
  webSocket.addEventListener("close", (event) =>
    args.onConnectionStatusChange?.(
      "closed",
      event.reason === ""
        ? `WebSocket closed with code ${event.code}`
        : `WebSocket closed with code ${event.code}: ${event.reason}`,
    ),
  );
  webSocket.addEventListener("error", () =>
    args.onConnectionStatusChange?.("error", "WebSocket error"),
  );
  return streamConnectionFromWebSocket(webSocket);
}

export const DEFAULT_STREAM_NAMESPACE = "default";

export function normalizeStreamPath(args: { path?: string | null }) {
  const value = args.path;
  if (value == null || value.trim() === "") return "/";
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function streamDurableObjectName(args: { namespace: string; path: string }) {
  return `${args.namespace}:${args.path}`;
}

/** Parse `/api/streams?path=...&namespace=...` into stream DO identity parts. */
export function parseStreamRpcRequest(args: { url: URL }) {
  if (args.url.pathname !== "/api/streams") {
    throw new Error(`Unexpected stream RPC path: ${args.url.pathname}`);
  }
  const path = normalizeStreamPath({ path: args.url.searchParams.get("path") });
  const namespaceRaw = args.url.searchParams.get("namespace")?.trim();
  const namespace =
    namespaceRaw === undefined || namespaceRaw === "" ? DEFAULT_STREAM_NAMESPACE : namespaceRaw;
  return { namespace, path };
}

/** HTTP path + query for the browser Stream Durable Object RPC endpoint. */
export function streamRpcPath(args: { path: string; namespace?: string }) {
  const path = normalizeStreamPath({ path: args.path });
  const url = new URL("/api/streams", "http://placeholder");
  url.searchParams.set("path", path);
  const namespace = args.namespace?.trim();
  if (namespace && namespace !== DEFAULT_STREAM_NAMESPACE) {
    url.searchParams.set("namespace", namespace);
  }
  return `${url.pathname}${url.search}`;
}
