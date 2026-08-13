// Container intercept presents Response.webSocket as raw HTTP. Reconstruct the
// handshake for the downstream client's key, never the upstream connection's.
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Compute RFC 6455 `Sec-WebSocket-Accept` for a client key. */
export async function computeSecWebSocketAccept(secWebSocketKey: string): Promise<string> {
  const data = new TextEncoder().encode(secWebSocketKey + WEBSOCKET_GUID);
  const digest = await crypto.subtle.digest("SHA-1", data);
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Rebuild a WebSocket response for its downstream caller. */
export async function withWebSocketHandshakeHeaders(
  request: Request,
  response: Response,
): Promise<Response> {
  const socket = response.webSocket;
  if (!socket) return response;

  return new Response(null, {
    status: 101,
    statusText: "Switching Protocols",
    headers: await downstreamHandshakeHeaders(request, response.headers),
    webSocket: socket,
  });
}

/** Strip upstream negotiation and allow only a subprotocol the caller offered. */
export async function downstreamHandshakeHeaders(
  request: Request,
  source: Headers,
): Promise<Headers> {
  const headers = new Headers(source);
  const selectedProtocol = headers.get("sec-websocket-protocol")?.trim();

  // Container intercept injects Upgrade/Connection; forwarding them duplicates values.
  headers.delete("location");
  headers.delete("content-location");
  headers.delete("refresh");
  headers.delete("upgrade");
  headers.delete("connection");
  headers.delete("sec-websocket-accept");
  headers.delete("sec-websocket-extensions");
  headers.delete("sec-websocket-protocol");

  const key = request.headers.get("sec-websocket-key");
  if (key && key.length > 0) {
    headers.set("sec-websocket-accept", await computeSecWebSocketAccept(key));
  }

  if (selectedProtocol && selectedProtocol !== "") {
    const offeredProtocols = new Set(
      (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim())
        .filter(Boolean),
    );
    if (!selectedProtocol.includes(",") && offeredProtocols.has(selectedProtocol)) {
      headers.set("sec-websocket-protocol", selectedProtocol);
    }
  }

  return headers;
}
