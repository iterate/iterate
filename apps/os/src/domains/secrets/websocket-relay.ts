/**
 * Discord-shaped WebSocket relay helpers: trusted IDENTIFY after optional
 * hello, then opaque frame pump. The token never appears on the public
 * secret surface — only inside this module's trusted send path.
 *
 * Petshop proof: apps/dummy-petshop `/gateway` (see gateway.ts).
 * Design: integrations-and-secrets-design.md "WebSocket egress + relay".
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
 * Capture every upstream message from accept until the pair-bridge attaches.
 * Attach immediately after `accept()` and before any `await` so server-first
 * frames (hello / ready / dispatch) are never dropped.
 */
type UpstreamMessageBuffer = {
  readonly frames: Array<string | ArrayBuffer>;
  attach(socket: WebSocket): void;
  /** Stop capturing; remaining frames stay in `frames` for the client flush. */
  detach(socket: WebSocket): void;
};

export function createUpstreamMessageBuffer(): UpstreamMessageBuffer {
  const frames: Array<string | ArrayBuffer> = [];
  let active = true;
  const onMessage = (event: MessageEvent) => {
    if (!active) return;
    frames.push(event.data as string | ArrayBuffer);
  };
  return {
    frames,
    attach(socket) {
      active = true;
      socket.addEventListener("message", onMessage);
    },
    detach(socket) {
      active = false;
      socket.removeEventListener("message", onMessage);
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
        // Handshake-consumed: drop everything through the match.
        frames.splice(0, i + 1);
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
