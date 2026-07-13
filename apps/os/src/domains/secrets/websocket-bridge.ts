/**
 * Explicit WebSocket pair-bridge for project egress.
 *
 * After policy + secret substitution open an upstream WebSocket (via `fetch`
 * with `Upgrade: websocket`), we do not pass that socket straight back to the
 * sandbox. We mint a `WebSocketPair`, return the client end as the 101 answer,
 * and pump frames between our server end and the real upstream.
 *
 * Why: pass-through relies on `Response.webSocket` surviving every hop and on
 * half-open close semantics. Owning both legs makes handshake-only secret
 * substitution, audit, and close handling explicit. Frame payloads are never
 * rewritten — only the upgrade envelope (headers / URL path) is substituted,
 * same as ordinary secret egress.
 *
 * Container intercept: in-container clients (Node undici WebSocket, `ws`)
 * validate the HTTP 101 handshake headers (Upgrade / Connection /
 * Sec-WebSocket-Accept). workerd often injects those when serving a
 * `Response.webSocket` directly to a browser client, but the container
 * intercept path presents the Response as raw HTTP to the MITM client — so we
 * must set the handshake headers ourselves against the *caller's*
 * Sec-WebSocket-Key (not the upstream's Accept, which is for a different key).
 */

/** RFC 6455 magic GUID for Sec-WebSocket-Accept. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/**
 * Compute `Sec-WebSocket-Accept` for a client `Sec-WebSocket-Key` (RFC 6455).
 * Pure helper — unit-tested; used by pair-bridge for container intercept.
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
 */
export async function withWebSocketHandshakeHeaders(
  request: Request,
  response: Response,
): Promise<Response> {
  const socket = response.webSocket;
  if (socket == null) return response;

  const headers = new Headers(response.headers);
  // Strip any hop-by-hop / wrong-key handshake fields; intercept re-adds
  // Upgrade/Connection once, and we stamp Accept for the container client key.
  headers.delete("upgrade");
  headers.delete("connection");
  headers.delete("sec-websocket-accept");

  const key = request.headers.get("Sec-WebSocket-Key");
  if (key !== null && key.length > 0) {
    headers.set("Sec-WebSocket-Accept", await computeSecWebSocketAccept(key));
  }

  // Echo a single requested subprotocol if the source did not already choose.
  const requested = request.headers.get("Sec-WebSocket-Protocol");
  if (requested !== null && !headers.has("Sec-WebSocket-Protocol")) {
    const first = requested.split(",")[0]?.trim();
    if (first) headers.set("Sec-WebSocket-Protocol", first);
  }

  return new Response(null, {
    status: 101,
    statusText: "Switching Protocols",
    headers,
    webSocket: socket,
  });
}

/**
 * If this was a WebSocket upgrade and the upstream accepted it (`webSocket`
 * present), replace the response with a pair-bridged 101. Otherwise return
 * `response` unchanged (failed handshake, ordinary HTTP, etc.).
 */
export async function maybeBridgeWebSocketResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (!isWebSocketUpgrade(request)) return response;
  const upstream = response.webSocket;
  if (upstream == null) return response;
  return bridgeUpstreamWebSocket(upstream, response, { clientRequest: request });
}

type BridgeUpstreamWebSocketOptions = {
  /**
   * When true, `upstream` was already `accept()`ed (e.g. after a trusted
   * IDENTIFY handshake in `relayWebSocket`). Workers allow accept only once.
   */
  upstreamAlreadyAccepted?: boolean;
  /**
   * Frames received on `upstream` before the bridge attached listeners.
   * Flushed to the client leg in order before live pump starts.
   */
  pendingUpstreamMessages?: Array<string | ArrayBuffer>;
  /**
   * The caller's upgrade request — used to mint Sec-WebSocket-Accept for the
   * container intercept / undici handshake. Prefer passing this whenever the
   * Response will leave workerd toward a raw-HTTP client.
   */
  clientRequest?: Request;
};

/**
 * Present `upstream` to the caller through a fresh WebSocketPair.
 * Caller must only invoke this when `upstream` is a live accepted-or-accepting socket.
 */
export async function bridgeUpstreamWebSocket(
  upstream: WebSocket,
  source?: Response,
  options?: BridgeUpstreamWebSocketOptions,
): Promise<Response> {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  // Half-open: we coordinate the close handshake while proxying (Workers
  // default auto-reply-to-close would race with bidirectional close).
  // Attach listeners immediately after accept so server-first frames are not
  // dropped before the pump is live.
  server.accept({ allowHalfOpen: true });
  if (!options?.upstreamAlreadyAccepted) {
    upstream.accept({ allowHalfOpen: true });
  }

  // Match binary framing so ArrayBuffer frames are not coerced to strings.
  try {
    server.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";
  } catch {
    // Some test doubles omit binaryType; production WebSockets support it.
  }

  // Replay frames that arrived during a pre-bridge handshake (IDENTIFY, audit).
  for (const data of options?.pendingUpstreamMessages ?? []) {
    try {
      server.send(data);
    } catch {
      // Peer already closed; close handlers will finish teardown.
    }
  }

  pipeWebSocket(server, upstream);
  pipeWebSocket(upstream, server);

  const headers = new Headers(source?.headers);
  // Hop-by-hop / URL-bearing headers must not leak credential provenance.
  headers.delete("location");
  headers.delete("content-location");
  headers.delete("refresh");
  // Upstream Accept is for a different Sec-WebSocket-Key — never forward it.
  // Strip Upgrade/Connection: container intercept re-injects them once;
  // keeping both sources produces undici-breaking duplicates.
  headers.delete("sec-websocket-accept");
  headers.delete("upgrade");
  headers.delete("connection");

  const clientKey = options?.clientRequest?.headers.get("Sec-WebSocket-Key");
  if (clientKey !== null && clientKey !== undefined && clientKey.length > 0) {
    headers.set("Sec-WebSocket-Accept", await computeSecWebSocketAccept(clientKey));
  }

  const requestedProtocol = options?.clientRequest?.headers.get("Sec-WebSocket-Protocol");
  if (
    requestedProtocol !== null &&
    requestedProtocol !== undefined &&
    !headers.has("Sec-WebSocket-Protocol")
  ) {
    const first = requestedProtocol.split(",")[0]?.trim();
    if (first) headers.set("Sec-WebSocket-Protocol", first);
  }

  return new Response(null, {
    status: 101,
    statusText: source?.statusText ?? "Switching Protocols",
    headers,
    webSocket: client,
  });
}

/** Close codes the WebSocket API forbids setting (throws RangeError). */
const NON_SETTABLE_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

/** Pure helper for tests: clamp close code/reason before `WebSocket.close`. */
export function normalizeWebSocketClose(
  code: number,
  reason: string,
): { code?: number; reason?: string } {
  const truncated =
    typeof reason === "string" && reason.length > 0
      ? // Spec: reason is at most 123 UTF-8 bytes; approximate with JS length.
        reason.length > 123
        ? reason.slice(0, 123)
        : reason
      : "";
  if (!Number.isFinite(code) || NON_SETTABLE_CLOSE_CODES.has(code) || code < 1000 || code > 4999) {
    return truncated === "" ? {} : { code: 1000, reason: truncated };
  }
  return truncated === "" ? { code } : { code, reason: truncated };
}

/** Best-effort close that never throws (failed relay teardown). */
export function closeWebSocketQuietly(
  socket: WebSocket | null | undefined,
  code = 1011,
  reason = "websocket error",
): void {
  if (socket == null) return;
  try {
    const normalized = normalizeWebSocketClose(code, reason);
    if (normalized.code === undefined) {
      socket.close();
    } else if (normalized.reason === undefined || normalized.reason === "") {
      socket.close(normalized.code);
    } else {
      socket.close(normalized.code, normalized.reason);
    }
  } catch {
    // already closed or non-settable
  }
}

function pipeWebSocket(from: WebSocket, to: WebSocket): void {
  // Listeners before any further accept-driven activity (accept already ran).
  from.addEventListener("message", (event: MessageEvent) => {
    try {
      // event.data may be string | ArrayBuffer | Blob depending on binaryType.
      to.send(event.data as string | ArrayBuffer);
    } catch {
      // Peer already closed; the close handler will finish teardown.
    }
  });
  from.addEventListener("close", (event: CloseEvent) => {
    try {
      const normalized = normalizeWebSocketClose(event.code, event.reason);
      if (normalized.code === undefined) {
        to.close();
      } else if (normalized.reason === undefined || normalized.reason === "") {
        to.close(normalized.code);
      } else {
        to.close(normalized.code, normalized.reason);
      }
    } catch {
      // already closed
    }
  });
  from.addEventListener("error", () => {
    try {
      to.close(1011, "websocket error");
    } catch {
      // already closed
    }
    try {
      from.close(1011, "websocket error");
    } catch {
      // already closed
    }
  });
}
