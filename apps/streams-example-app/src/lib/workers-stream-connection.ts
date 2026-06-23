import {
  streamConnectionFromWebSocket,
  toWebSocketUrl,
  type StreamConnection,
} from "./stream-connection.ts";

type FetchEndpoint = (request: Request) => Promise<Response>;

/** Connects from a Worker or Durable Object using fetch plus a WebSocket upgrade. */
export async function withStreamConnectionFromWorkers(args: {
  url: string | URL;
  fetch: FetchEndpoint;
  headers?: HeadersInit;
}): Promise<StreamConnection> {
  const requestHeaders = new Headers(args.headers);
  requestHeaders.set("Upgrade", "websocket");
  const response = await args.fetch(
    new Request(toWebSocketUrl(args.url), { headers: requestHeaders }),
  );
  const webSocket = response.webSocket;
  if (webSocket === null) throw new Error("endpoint did not return a WebSocket");
  webSocket.accept();
  return streamConnectionFromWebSocket(webSocket);
}
