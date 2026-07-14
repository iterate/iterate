/**
 * Downstream handshake reconstruction for container WebSocket egress.
 *
 * In-container clients (Node undici WebSocket, `ws`)
 * validate the HTTP 101 handshake headers (Upgrade / Connection /
 * Sec-WebSocket-Accept). workerd often injects those when serving a
 * `Response.webSocket` directly to a browser client, but the container
 * intercept path presents the Response as raw HTTP to the MITM client — so we
 * must set the handshake headers ourselves against the *caller's*
 * Sec-WebSocket-Key (not the upstream's Accept, which is for a different key).
 */

/** RFC 6455 §4.2.2 magic GUID for Sec-WebSocket-Accept. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Compute `Sec-WebSocket-Accept` for a client `Sec-WebSocket-Key` (RFC 6455).
 * Pure helper, unit-tested against the RFC example.
 */
export async function computeSecWebSocketAccept(secWebSocketKey: string): Promise<string> {
  const data = new TextEncoder().encode(secWebSocketKey + WEBSOCKET_GUID);
  const digest = await crypto.subtle.digest("SHA-1", data);
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Ensure a WebSocket Response carries a correct `Sec-WebSocket-Accept` for the
 * *caller's* key when presented as raw HTTP (container intercept MITM).
 *
 * Important: do NOT also set `Upgrade`/`Connection` here. Container intercept
 * injects those hop-by-hop headers when converting `Response.webSocket` into
 * an HTTP 101 for the in-container client. If we set them too, the client sees
 * duplicates (`Upgrade: websocket, websocket`) and undici rejects the
 * handshake with "Server did not set Upgrade header to websocket" (exact
 * equality check against the joined value).
 *
 * Container intercept's header synthesis is exercised by workerd's pinned
 * upstream test:
 * https://github.com/cloudflare/workerd/blob/e4c3d8b4557f6dc5b63315b45a61a4dd8a92a944/src/workerd/server/tests/container-client/test.js#L1180-L1246
 */
export async function withWebSocketHandshakeHeaders(
  request: Request,
  response: Response,
): Promise<Response> {
  const socket = response.webSocket;
  if (socket == null) return response;

  return new Response(null, {
    status: 101,
    statusText: "Switching Protocols",
    headers: await downstreamHandshakeHeaders(request, response.headers),
    webSocket: socket,
  });
}

/**
 * Reconstruct the handshake for the downstream WebSocket hop.
 *
 * Accept and extensions belong to the upstream connection and cannot be
 * forwarded to the caller. A selected subprotocol is safe only when it is
 * exactly one of the values that caller offered. Applying this at Secret and
 * Project boundaries prevents secret-derived negotiation values from becoming
 * response-header oracles; the final sandbox application is idempotent.
 */
export async function downstreamHandshakeHeaders(
  request: Request,
  source: Headers,
): Promise<Headers> {
  const headers = new Headers(source);
  const selectedProtocol = headers.get("sec-websocket-protocol")?.trim();

  // URL-bearing provenance and hop-specific negotiation never cross the hop.
  headers.delete("location");
  headers.delete("content-location");
  headers.delete("refresh");
  headers.delete("upgrade");
  headers.delete("connection");
  headers.delete("sec-websocket-accept");
  headers.delete("sec-websocket-extensions");
  headers.delete("sec-websocket-protocol");

  const key = request.headers.get("sec-websocket-key");
  if (key !== null && key.length > 0) {
    headers.set("sec-websocket-accept", await computeSecWebSocketAccept(key));
  }

  if (selectedProtocol !== undefined && selectedProtocol !== "") {
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
