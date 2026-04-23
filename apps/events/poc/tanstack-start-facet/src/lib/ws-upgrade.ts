import { WebSocketResponse } from "./ws-response";

/** If a Route.server.handler returned a WebSocketResponse, upgrade the connection. */
export function maybeUpgradeWebSocket(response: Response): Response {
  if (!(response instanceof WebSocketResponse)) return response;

  const hooks = response.wsHooks;
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();

  const peer = {
    send: (d: string) => server.send(d),
    close: (code?: number, reason?: string) => server.close(code, reason),
  };

  // Fire open hook immediately after accept
  hooks.open?.(peer);

  server.addEventListener("message", (event) => {
    const data = event.data;
    const msg =
      typeof data === "string"
        ? { rawData: data, uint8Array: () => new TextEncoder().encode(data) }
        : { rawData: data, uint8Array: () => new Uint8Array(data as ArrayBuffer) };
    hooks.message?.(peer, msg);
  });
  server.addEventListener("close", () => hooks.close?.(peer));
  server.addEventListener("error", () => hooks.error?.(peer));

  return new Response(null, { status: 101, webSocket: client });
}
