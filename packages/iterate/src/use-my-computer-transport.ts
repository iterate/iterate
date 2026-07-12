// ─────────────────────────────────────────────────────────────────────────────
// The two transports `iterate use-my-computer` lends a project: an HTTP reverse
// proxy to a local server (getFetcher) and a WebSocket frame bridge
// (connectSocket). Both run in the CLI process — capnweb ships the call here, so
// the fetch / the socket happen on the human's machine. Kept in their own module
// (with direct unit tests) because the lifecycle is subtle: Request/Response copies
// cross capability dispatch fine, but a live socket cannot cross workerd's RPC
// hops (apps/os/docs/dynamic-worker-dispatch.md), so the WebSocket lane bridges
// frames as callbacks instead.
// ─────────────────────────────────────────────────────────────────────────────

import WebSocket from "ws";

import {
  disposeIgnoredRpcResult,
  isThenable,
  retainCallback,
} from "../../../apps/os/src/lib/rpc/retain.ts";

// ── HTTP: reverse proxy to a local server ────────────────────────────────────

/** Hop-by-hop headers are connection-scoped and must not cross a proxy hop (RFC 9110 §7.6.1). */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Delete hop-by-hop headers in place, including any named by the `Connection` header. */
export function stripHopByHop(headers: Headers): Headers {
  for (const named of headers.get("connection")?.split(",") ?? []) {
    headers.delete(named.trim());
  }
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  return headers;
}

/**
 * Proxy one HTTP request to a server on this machine and return its response,
 * faithfully enough to serve a real dev server on a project host:
 * - WebSocket upgrades are refused with a teaching error (the socket can't cross
 *   RPC — that's what connectSocket is for).
 * - Hop-by-hop headers are stripped both directions; the original host travels as
 *   `x-forwarded-host` (undici drops a bare `host` override).
 * - A `Location` whose origin is the local server is rewritten onto the public
 *   origin (parsed, not string-prefix-matched, so `:3000` doesn't match `:30001`),
 *   so a dev server's `302 → /login` doesn't send the browser to its own loopback.
 * - Any upstream failure — refused connection, or a reset mid-body — becomes a
 *   `502`, never an opaque exception escaping through capability dispatch.
 * Bodies are buffered (fine for a spike); the stale framing headers undici leaves
 * after decompression are dropped only when a body was actually buffered, so
 * bodyless responses (HEAD/204/205/304) keep their representation metadata.
 */
export async function proxyLocalHttp(origin: string, request: Request): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    throw new Error(
      `getFetcher().fetch cannot carry a WebSocket upgrade: the 101 response's socket ` +
        `cannot cross RPC hops between the platform and this machine. ` +
        `Terminate the socket in a Durable Object app and bridge frames with ` +
        `connectSocket({ port, path }) instead.`,
    );
  }
  const incoming = new URL(request.url);
  const headers = stripHopByHop(new Headers(request.headers));
  headers.set("x-forwarded-host", incoming.host);
  headers.delete("host");
  const requestBody =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  const upstreamUrl = `${origin}${incoming.pathname}${incoming.search}`;
  // Everything that can fail against the local server stays inside the 502
  // boundary: the initial connection AND streaming the body (a server that
  // sends headers then resets must not surface as an opaque worker error).
  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: requestBody,
      redirect: "manual", // pass redirects through so the browser sees them
    });
  } catch (error) {
    return unreachable(origin, error);
  }

  const nullBody =
    request.method === "HEAD" ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  let responseBody: ArrayBuffer | null = null;
  if (!nullBody) {
    try {
      responseBody = await response.arrayBuffer();
    } catch (error) {
      return unreachable(origin, error);
    }
  }

  const outHeaders = stripHopByHop(new Headers(response.headers));
  if (!nullBody) {
    // undici decompressed the buffered body but left the encoding/length framing.
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
  }
  rewriteLocalRedirect(outHeaders, origin, upstreamUrl, incoming.origin);
  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders,
  });
}

function unreachable(origin: string, error: unknown): Response {
  return new Response(`local server at ${origin} is unreachable: ${String(error)}`, {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Rewrite a `Location` that resolves to the local origin onto the public origin.
 * Resolving against the upstream URL (not just parsing absolute) also catches
 * protocol-relative (`//127.0.0.1:port/…`) and path-relative redirects, which
 * would otherwise silently point the public browser at the Mac's loopback.
 */
function rewriteLocalRedirect(
  headers: Headers,
  localOrigin: string,
  upstreamUrl: string,
  publicOrigin: string,
): void {
  const location = headers.get("location");
  if (!location) return;
  let target: URL;
  try {
    target = new URL(location, upstreamUrl);
  } catch {
    return;
  }
  if (target.origin === new URL(localOrigin).origin) {
    headers.set("location", `${publicOrigin}${target.pathname}${target.search}${target.hash}`);
  }
}

// ── WebSocket: a frame bridge to a local server ──────────────────────────────

export type SocketBridgeInput = {
  port: number;
  path?: string;
  host?: string;
  onMessage?: (data: string) => unknown;
  onClose?: (info: { code: number; reason: string }) => unknown;
};

/** The bridge the caller drives — plain data + functions so it serializes over capnweb. */
export type SocketBridge = {
  send(data: string): Promise<{ ok: true }>;
  close(input?: { code?: number; reason?: string }): Promise<{ ok: true }>;
};

/** Every open bridge's shutdown, so CLI teardown can close them all at once. */
const activeBridges = new Set<() => void>();

/** Close every open frame bridge — the CLI runs this when its own socket to OS drops. */
export function closeAllBridges(): void {
  for (const shutdown of [...activeBridges]) shutdown();
}

/**
 * Open a WebSocket to a local server and bridge FRAMES over capability dispatch.
 * The bridge exclusively owns the socket and the retained callbacks, with ONE
 * idempotent `shutdown()` that closes the socket and disposes the callbacks. The
 * ordering that matters: the socket's own `close` event delivers `onClose`
 * BEFORE shutdown disposes it (a `disposed` guard makes every other terminal
 * path — `close()`, a socket error, `closeAllBridges` — skip a late delivery
 * against a released stub rather than call it). If a callback's transport breaks
 * (the DO/session holding it dies), that tears the bridge down too.
 *
 * A Durable Object app terminates the browser's WebSocket with WebSocketPair and
 * pumps frames both ways through this bridge — the socket itself can never cross
 * the RPC mesh. The DO drives teardown by calling `close()` on browser
 * disconnect (a returned value's `[Symbol.dispose]` is dropped by capnweb's
 * by-value serialization, so `close()` is the only cross-RPC teardown).
 */
export async function openSocketBridge({
  port,
  path = "/",
  host = "127.0.0.1",
  onMessage,
  onClose,
}: SocketBridgeInput): Promise<SocketBridge> {
  const socket = new WebSocket(`ws://${host}:${port}${path}`);
  // Callbacks are stubs capnweb releases when this call returns; retainCallback
  // dup()s them for the socket's life (idempotent dispose, onRpcBroken-aware).
  const onFrame = onMessage ? retainCallback(onMessage) : undefined;
  const onSocketClose = onClose ? retainCallback(onClose) : undefined;

  let disposed = false;
  const shutdown = () => {
    if (disposed) return;
    disposed = true;
    activeBridges.delete(shutdown);
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "");
      }
    } catch {}
    onFrame?.[Symbol.dispose]();
    onSocketClose?.[Symbol.dispose]();
  };
  activeBridges.add(shutdown);

  // A callback whose transport has broken can never be delivered again — tear
  // the bridge down so the local socket doesn't linger.
  onFrame?.onRpcBroken?.(() => shutdown());
  onSocketClose?.onRpcBroken?.(() => shutdown());

  // Deliver one value to a retained callback, following the canonical sink
  // discipline (subscriber-sinks.ts): a synchronous throw or a rejected delivery
  // means the stub is a corpse — tear the bridge down rather than swallowing it;
  // and the ignored RPC result is disposed (dropping it leaks a remote
  // reference, one per frame otherwise).
  const deliver = (callback: ((arg: never) => unknown) | undefined, arg: unknown) => {
    if (disposed || !callback) return;
    let result: unknown;
    try {
      result = callback(arg as never);
    } catch {
      shutdown();
      return;
    }
    if (isThenable(result)) {
      void Promise.resolve(result)
        .then(undefined, () => shutdown())
        .finally(() => disposeIgnoredRpcResult(result));
    } else {
      disposeIgnoredRpcResult(result);
    }
  };

  socket.on("message", (data) => deliver(onFrame, String(data)));
  socket.on("close", (code, reason) => {
    deliver(onSocketClose, { code, reason: String(reason) });
    shutdown();
  });
  // After-open errors are usually followed by `close`, but wire this directly so
  // an error that never emits `close` still tears the bridge down.
  socket.on("error", () => shutdown());

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
  } catch (error) {
    shutdown();
    throw error;
  }

  return {
    /** Push one text frame to the local server; resolves once the write is accepted. */
    send: async (data: string) => {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error(`socket not open (readyState ${socket.readyState})`);
      }
      await new Promise<void>((resolve, reject) => {
        socket.send(data, (error) => (error ? reject(error) : resolve()));
      });
      return { ok: true as const };
    },
    /**
     * Close the local socket. If it's live, the socket's own `close` event drives
     * delivery + shutdown. While it's already CLOSING, this is a no-op — the
     * pending `close` event will still deliver `onClose` (running shutdown here
     * would dispose the callback before that fires). Only if it's fully CLOSED
     * (no `close` event coming) do we shut down directly to release callbacks.
     */
    close: async (input?: { code?: number; reason?: string }) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(input?.code ?? 1000, input?.reason ?? "");
      } else if (socket.readyState === WebSocket.CLOSED) {
        shutdown();
      }
      return { ok: true as const };
    },
  };
}
