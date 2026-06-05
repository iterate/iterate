import {
  streamConnectionFromWebSocket,
  toWebSocketUrl,
  waitForOpen,
  type StreamConnection,
} from "../connection.ts";

/** Connects from Node.js using the runtime's global WebSocket. */
export async function withStreamConnectionFromNode(args: {
  url: string | URL;
  headers?: HeadersInit;
}): Promise<StreamConnection> {
  const webSocket = new WebSocket(toWebSocketUrl(args.url), {
    // @ts-expect-error Node supports WebSocket headers; DOM lib typings do not.
    headers: args.headers,
  });
  await waitForOpen(webSocket);
  return streamConnectionFromWebSocket(webSocket);
}
