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
 */

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/**
 * If this was a WebSocket upgrade and the upstream accepted it (`webSocket`
 * present), replace the response with a pair-bridged 101. Otherwise return
 * `response` unchanged (failed handshake, ordinary HTTP, etc.).
 */
export function maybeBridgeWebSocketResponse(request: Request, response: Response): Response {
  if (!isWebSocketUpgrade(request)) return response;
  const upstream = response.webSocket;
  if (upstream == null) return response;
  return bridgeUpstreamWebSocket(upstream, response);
}

export type BridgeUpstreamWebSocketOptions = {
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
};

/**
 * Present `upstream` to the caller through a fresh WebSocketPair.
 * Caller must only invoke this when `upstream` is a live accepted-or-accepting socket.
 */
export function bridgeUpstreamWebSocket(
  upstream: WebSocket,
  source?: Response,
  options?: BridgeUpstreamWebSocketOptions,
): Response {
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
