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
 * Wait until the socket delivers a JSON text frame with `op === expectedOp`.
 * Non-matching frames are ignored (not forwarded — caller has not bridged yet).
 */
export function waitForJsonOp(
  socket: WebSocket,
  expectedOp: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`websocket relay timed out waiting for op=${expectedOp}`));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      try {
        const text = messageDataToText(event.data);
        const parsed: unknown = JSON.parse(text);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          (parsed as { op?: unknown }).op === expectedOp
        ) {
          cleanup();
          resolve(parsed as Record<string, unknown>);
        }
      } catch {
        // non-JSON or parse error — keep waiting
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
