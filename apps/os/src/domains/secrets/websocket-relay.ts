/**
 * Discord-shaped WebSocket relay helpers: trusted IDENTIFY after optional
 * hello, then opaque frame pump. The token never appears on the public
 * secret surface — only inside this module's trusted send path.
 *
 * Petshop proof: apps/dummy-petshop `/gateway` (see gateway.ts).
 * Design: integrations-and-secrets-design.md "WebSocket egress + relay".
 *
 * Transport: `Response.webSocket` only survives the Durable Object **fetch**
 * hop (not arbitrary JSRPC method returns). SecretRpcTarget therefore encodes
 * the relay as an internal `stub.fetch` request; the Secret DO detects that
 * shape and runs the IDENTIFY handshake inside `fetch`.
 */

/** Internal URL used only for Secret DO fetch → relayWebSocket routing. */
export const SECRET_WS_RELAY_FETCH_URL = "https://iterate.internal/__secret_ws_relay";

/**
 * Input to `secret.relayWebSocket`: open a pinned wss, optionally send
 * IDENTIFY with material held only in the Secret DO, then return a
 * pair-bridged socket for subsequent app frames.
 */
export type SecretWebSocketRelayInput = {
  /** Absolute ws/wss (or http/https, upgraded) URL on the secret's egress pin. */
  url: string;
  /**
   * When set, after the socket opens the Secret DO waits for a server JSON
   * frame with `op === waitForOp` (default `"hello"`), then sends an IDENTIFY
   * frame whose token field is filled from secret material. Omit to open and
   * bridge immediately (header/subprotocol-auth gateways that are already
   * identified at upgrade).
   */
  identify?: {
    /** Server op to wait for before IDENTIFY. Default `"hello"`. Pass `null` to send IDENTIFY immediately after open. */
    waitForOp?: string | null;
    /** Dotted field into structured material; omit when material is a plain string token. */
    tokenField?: string;
    /**
     * JSON object template for the IDENTIFY frame. Any string equal to
     * `"$token"` is replaced with the secret token. Default:
     * `{ op: "identify", token: "$token" }` (petshop / Discord shape).
     */
    frame?: Record<string, unknown>;
  };
  /** Bound for hello wait + identify round-trip. Default 15_000. */
  timeoutMs?: number;
};

/** Header set only by encodeSecretWebSocketRelayRequest (not by sandbox egress). */
const SECRET_WS_RELAY_FETCH_HEADER = "x-iterate-secret-ws-relay";

/** Build the DO-fetch request that carries `relayWebSocket` input over the fetch hop. */
export function encodeSecretWebSocketRelayRequest(input: SecretWebSocketRelayInput): Request {
  return new Request(SECRET_WS_RELAY_FETCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SECRET_WS_RELAY_FETCH_HEADER]: "1",
    },
    body: JSON.stringify(input),
  });
}

export function isSecretWebSocketRelayRequest(request: Request): boolean {
  return (
    new URL(request.url).href === SECRET_WS_RELAY_FETCH_URL &&
    request.headers.get(SECRET_WS_RELAY_FETCH_HEADER) === "1"
  );
}

export async function parseSecretWebSocketRelayRequest(
  request: Request,
): Promise<SecretWebSocketRelayInput> {
  const body: unknown = await request.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("secret websocket relay body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.length === 0) {
    throw new Error("secret websocket relay requires a non-empty url string");
  }
  const input: SecretWebSocketRelayInput = { url: record.url };
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs)) {
      throw new Error("secret websocket relay timeoutMs must be a finite number");
    }
    input.timeoutMs = record.timeoutMs;
  }
  if (record.identify !== undefined) {
    if (
      record.identify === null ||
      typeof record.identify !== "object" ||
      Array.isArray(record.identify)
    ) {
      throw new Error("secret websocket relay identify must be an object");
    }
    input.identify = record.identify as SecretWebSocketRelayInput["identify"];
  }
  return input;
}

const DEFAULT_IDENTIFY_FRAME: Record<string, unknown> = {
  op: "identify",
  token: "$token",
};

/** Replace every string `"$token"` in a JSON-like tree with `token`. */
export function injectTokenPlaceholder(value: unknown, token: string): unknown {
  if (value === "$token") return token;
  if (Array.isArray(value)) return value.map((entry) => injectTokenPlaceholder(entry, token));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = injectTokenPlaceholder(child, token);
    }
    return out;
  }
  return value;
}

export function buildIdentifyFrame(
  token: string,
  frame: Record<string, unknown> = DEFAULT_IDENTIFY_FRAME,
): string {
  return JSON.stringify(injectTokenPlaceholder(frame, token));
}

export function messageDataToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView);
  }
  return String(data);
}

/**
 * Capture every upstream message (and close/error) from accept until the
 * pair-bridge attaches. Attach immediately after `accept()` and before any
 * `await` so server-first frames and an early hangup are never dropped.
 */
type UpstreamMessageBuffer = {
  readonly frames: Array<string | ArrayBuffer>;
  /** Set when the upstream closed before the bridge took over. */
  closed: { code: number; reason: string } | null;
  /** Set when the upstream errored before the bridge took over. */
  errored: boolean;
  attach(socket: WebSocket): void;
  /** Stop capturing; remaining frames stay in `frames` for the client flush. */
  detach(socket: WebSocket): void;
  /** Throw if the upstream died during the handshake (after a named phase). */
  throwIfClosed(phase: string): void;
};

export function createUpstreamMessageBuffer(): UpstreamMessageBuffer {
  const frames: Array<string | ArrayBuffer> = [];
  let active = true;
  let closed: { code: number; reason: string } | null = null;
  let errored = false;
  const onMessage = (event: MessageEvent) => {
    if (!active) return;
    frames.push(event.data as string | ArrayBuffer);
  };
  const onClose = (event: CloseEvent) => {
    closed = { code: event.code, reason: event.reason };
  };
  const onError = () => {
    errored = true;
  };
  return {
    frames,
    get closed() {
      return closed;
    },
    get errored() {
      return errored;
    },
    attach(socket) {
      active = true;
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
    },
    detach(socket) {
      active = false;
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    },
    throwIfClosed(phase) {
      if (errored) {
        throw new Error(`websocket closed with error during relay ${phase}`);
      }
      if (closed !== null) {
        throw new Error(
          `websocket closed during relay ${phase} (code=${closed.code}${closed.reason ? ` reason=${closed.reason}` : ""})`,
        );
      }
    },
  };
}

function parseJsonOp(data: string | ArrayBuffer): Record<string, unknown> | null {
  try {
    const text = messageDataToText(data);
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // non-JSON
  }
  return null;
}

/**
 * Wait until the buffer holds a JSON text frame with `op === expectedOp`.
 * Frames up through the match are **consumed** (handshake-only; not forwarded
 * to the client). Later frames stay in the buffer for the pair-bridge flush.
 *
 * Requires `buffer` to already be attached to `socket` so arrivals during the
 * wait are recorded even if this helper's own listener races.
 */
export function waitForJsonOp(
  socket: WebSocket,
  expectedOp: string,
  timeoutMs: number,
  buffer?: UpstreamMessageBuffer,
): Promise<Record<string, unknown>> {
  const frames = buffer?.frames;

  const tryConsume = (): Record<string, unknown> | null => {
    if (frames === undefined) return null;
    for (let i = 0; i < frames.length; i++) {
      const parsed = parseJsonOp(frames[i]!);
      if (parsed !== null && parsed.op === expectedOp) {
        // Drop pre-match noise only. Keep the matched frame (e.g. hello) so the
        // client still sees heartbeat_interval / session params after IDENTIFY.
        frames.splice(0, i);
        return parsed;
      }
    }
    return null;
  };

  const early = tryConsume();
  if (early !== null) return Promise.resolve(early);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`websocket relay timed out waiting for op=${expectedOp}`));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      // When no shared buffer, scan the live event (legacy path / tests).
      if (frames === undefined) {
        const parsed = parseJsonOp(event.data as string | ArrayBuffer);
        if (parsed !== null && parsed.op === expectedOp) {
          cleanup();
          resolve(parsed);
        }
        return;
      }
      const matched = tryConsume();
      if (matched !== null) {
        cleanup();
        resolve(matched);
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error(`websocket closed while waiting for op=${expectedOp}`));
    };

    const onError = () => {
      cleanup();
      reject(new Error(`websocket error while waiting for op=${expectedOp}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);

    // Race: frame may have landed in the buffer between tryConsume and attach.
    const raced = tryConsume();
    if (raced !== null) {
      cleanup();
      resolve(raced);
    }
  });
}

/** Resolve once the socket is open (or already OPEN). */
export function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("websocket relay timed out waiting for open"));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("websocket closed before open"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("websocket error before open"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}
