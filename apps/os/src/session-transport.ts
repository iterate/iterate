import { WebSocketTransport, type RpcTransport } from "capnweb";

const ITX_CLIENT_DISCONNECTED_MESSAGE_PREFIX = "itx-client-disconnected: ";

/** True only for a close observed on the outer ITX WebSocket. */
export function isItxClientDisconnectedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(ITX_CLIENT_DISCONNECTED_MESSAGE_PREFIX);
}

/**
 * The outer ITX WebSocket is the authority for whether an attached client can
 * still receive a provider callback. Tag its peer close before Cap'n Web
 * fans that rejection into outstanding RPCs.
 */
export function createItxWebSocketTransport(webSocket: WebSocket): RpcTransport {
  let peerDisconnected = false;
  let locallyAborted = false;
  const markPeerDisconnected = () => {
    if (!locallyAborted) peerDisconnected = true;
  };
  // Register before WebSocketTransport so this state is available to its
  // receive() rejection in the same close-event dispatch.
  webSocket.addEventListener("close", markPeerDisconnected);
  webSocket.addEventListener("error", markPeerDisconnected);
  const transport = new WebSocketTransport(webSocket);
  return {
    abort(reason) {
      if (peerDisconnected) return;
      locallyAborted = true;
      transport.abort(reason);
    },
    receive: async () => {
      try {
        return await transport.receive();
      } catch (error) {
        if (peerDisconnected) {
          throw new Error(`${ITX_CLIENT_DISCONNECTED_MESSAGE_PREFIX}outer WebSocket closed`);
        }
        throw error;
      }
    },
    send: (message) => transport.send(message),
  };
}

/**
 * The seam between an ITX session's outer `/api` WebSocket and its RPC target
 * tree. A peer close is authoritative for caller-reply reachability, while a
 * target-tree mount loss still closes the session so the client reconnects and
 * re-runs its idempotent `projects.connect`.
 *
 * The close callback is keyed by the request ExecutionContext because that
 * object already flows through every RpcTarget in the session. Durable-
 * Object-side ITX and HTTP batch calls have no client transport, so
 * {@link closeItxSessionTransport} is a no-op for them.
 */
const transportClosers = new WeakMap<object, (code: number, reason: string) => void>();

/** Worker-side registration at WebSocket upgrade time; one per session. */
export function registerItxSessionTransport(
  ctx: object,
  close: (code: number, reason: string) => void,
): void {
  transportClosers.set(ctx, close);
}

/**
 * Close the session's client transport, if this execution context has one.
 * Returns whether a transport was registered (HTTP batch calls and
 * Durable-Object-side itx have none, and that is fine).
 */
export function closeItxSessionTransport(ctx: object, code: number, reason: string): boolean {
  const close = transportClosers.get(ctx);
  if (close === undefined) return false;
  try {
    close(code, reason);
  } catch {
    // Already closed — the invariant holds either way.
  }
  return true;
}
