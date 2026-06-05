import {
  streamConnectionFromWebSocket,
  toWebSocketUrl,
  type StreamConnection,
} from "../connection.ts";

/**
 * Connects from Node.js using the runtime's global WebSocket. Synchronous: capnweb
 * queues calls until the socket opens, so there is no need to await the handshake.
 */
export function withStreamConnectionFromNode(args: {
  url: string | URL;
  headers?: HeadersInit;
}): StreamConnection {
  const webSocket = new WebSocket(toWebSocketUrl(args.url), {
    // @ts-expect-error Node supports WebSocket headers; DOM lib typings do not.
    headers: args.headers,
  });
  return streamConnectionFromWebSocket(webSocket);
}
