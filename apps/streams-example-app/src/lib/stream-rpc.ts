import {
  streamConnectionFromWebSocket,
  toWebSocketUrl,
  type StreamConnection,
} from "./stream-connection.ts";

/** Connects browser JavaScript to one stream URL over capnweb-WebSocket. */
export async function withStreamConnectionFromBrowser(args: {
  url: string | URL;
  onConnectionStatusChange?: (
    status: "connecting" | "connected" | "closed" | "error",
    error: string | undefined,
  ) => void;
}): Promise<StreamConnection> {
  const browserUrl = new URL(
    args.url,
    typeof window === "undefined" ? "http://localhost/" : window.location.href,
  );
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

export const DEFAULT_STREAM_PROJECT_ID = "default";

export function normalizeStreamPath(args: { path?: string | null }) {
  const value = args.path;
  if (value == null || value.trim() === "") return "/";
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function streamDurableObjectName(args: { projectId: string; path: string }) {
  return `${args.projectId}:${args.path}`;
}

/** Parse `/api/streams?path=...&projectId=...` into stream DO identity parts. */
export function parseStreamRpcRequest(args: { url: URL }) {
  if (args.url.pathname !== "/api/streams") {
    throw new Error(`Unexpected stream RPC path: ${args.url.pathname}`);
  }
  const path = normalizeStreamPath({ path: args.url.searchParams.get("path") });
  const projectIdRaw = args.url.searchParams.get("projectId")?.trim();
  const projectId =
    projectIdRaw === undefined || projectIdRaw === "" ? DEFAULT_STREAM_PROJECT_ID : projectIdRaw;
  return { projectId, path };
}

/** HTTP path + query for the browser Stream Durable Object RPC endpoint. */
export function streamRpcPath(args: { path: string; projectId?: string }) {
  const path = normalizeStreamPath({ path: args.path });
  const url = new URL("/api/streams", "http://placeholder");
  url.searchParams.set("path", path);
  const projectId = args.projectId?.trim();
  if (projectId && projectId !== DEFAULT_STREAM_PROJECT_ID) {
    url.searchParams.set("projectId", projectId);
  }
  return `${url.pathname}${url.search}`;
}
