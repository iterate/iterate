import { StreamEvent as StreamEventSchema, type StreamEvent } from "./schemas.ts";
import {
  isDurableObjectLifecycleError,
  STREAM_UNAVAILABLE_MESSAGE_PREFIX,
} from "./stream-unavailable.ts";

/** Direct-DO fetch protocol. This URL never leaves the OS Worker. */
const STREAM_IDEMPOTENCY_WAIT_URL =
  "https://stream.iterate.internal/__iterate/wait-for-idempotency-key";
export const STREAM_IDEMPOTENCY_WAIT_PATH = new URL(STREAM_IDEMPOTENCY_WAIT_URL).pathname;
export const STREAM_IDEMPOTENCY_KEY_HEADER = "x-iterate-stream-idempotency-key";
export const STREAM_IDEMPOTENCY_WAIT_SOCKET_TAG = "iterate:idempotency-wait";

const MAX_CONNECTION_ATTEMPTS = 4;

class WaitSocketDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaitSocketDisconnectedError";
  }
}

export class StreamIdempotencyWaitTimeoutError extends Error {
  constructor(timeoutMs: number, idempotencyKey: string) {
    super(
      `Timed out waiting ${timeoutMs}ms for stream event with idempotency key ${JSON.stringify(idempotencyKey)}.`,
    );
    this.name = "StreamIdempotencyWaitTimeoutError";
  }
}

/**
 * Open the private hibernation-safe wait lane on one Stream Durable Object.
 * The returned client socket is accepted here, exactly once, before callers
 * attach listeners.
 */
export async function connectStreamIdempotencyWaitSocket(
  fetcher: Pick<Fetcher, "fetch">,
  idempotencyKey: string,
): Promise<WebSocket> {
  const response = await fetcher.fetch(
    new Request(STREAM_IDEMPOTENCY_WAIT_URL, {
      headers: {
        [STREAM_IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        Upgrade: "websocket",
      },
    }),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    await response.body?.cancel();
    throw new Error(
      `Stream idempotency wait handshake failed with HTTP ${response.status}; expected a WebSocket upgrade.`,
    );
  }
  socket.accept();
  return socket;
}

/**
 * Wait for one exact durable event without polling the Stream Durable Object.
 *
 * One hibernatable WebSocket spans the whole wait, so a 15-minute script does
 * not turn into hundreds of Worker/DO invocations in one request lineage.
 * If a deploy, explicit kill, or eviction drops the socket, a fresh connection
 * first point-reads the idempotency key and therefore cannot miss a commit in
 * the reconnect gap. Reconnects share one absolute deadline and are bounded;
 * application/protocol errors are never retried.
 */
export async function waitForStreamIdempotencyKey(input: {
  connect: (idempotencyKey: string) => Promise<WebSocket>;
  idempotencyKey: string;
  timeoutMs: number;
  /** Test seam only. */
  maxConnectionAttempts?: number;
  /** Test seam only. */
  now?: () => number;
}): Promise<StreamEvent> {
  if (input.idempotencyKey.trim().length === 0) {
    throw new Error("Stream idempotency wait requires a non-empty idempotency key.");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Stream idempotency wait timeoutMs must be a positive number.");
  }
  const maxConnectionAttempts = input.maxConnectionAttempts ?? MAX_CONNECTION_ATTEMPTS;
  if (!Number.isSafeInteger(maxConnectionAttempts) || maxConnectionAttempts < 1) {
    throw new Error("maxConnectionAttempts must be a positive safe integer.");
  }

  const now = input.now ?? Date.now;
  const deadline = now() + input.timeoutMs;
  let lastDisconnect: unknown;

  for (let attempt = 1; attempt <= maxConnectionAttempts; attempt += 1) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw idempotencyWaitTimeout(input.timeoutMs, input.idempotencyKey);

    try {
      const socket = await input.connect(input.idempotencyKey);
      const socketRemainingMs = deadline - now();
      if (socketRemainingMs <= 0) {
        try {
          socket.close(1000, "absolute wait deadline reached");
        } catch {
          // The peer may have closed while the handshake was completing.
        }
        throw idempotencyWaitTimeout(input.timeoutMs, input.idempotencyKey);
      }
      return await receiveExactEvent({
        idempotencyKey: input.idempotencyKey,
        socket,
        timeoutErrorMs: input.timeoutMs,
        timeoutMs: Math.max(1, Math.ceil(socketRemainingMs)),
      });
    } catch (error) {
      if (
        !(error instanceof WaitSocketDisconnectedError) &&
        !isDurableObjectLifecycleError(error)
      ) {
        throw error;
      }
      lastDisconnect = error;
      if (attempt === maxConnectionAttempts) break;
    }
  }

  const detail = lastDisconnect instanceof Error ? lastDisconnect.message : String(lastDisconnect);
  throw new Error(
    `${STREAM_UNAVAILABLE_MESSAGE_PREFIX}idempotency wait disconnected ${maxConnectionAttempts} consecutive times: ${detail}`,
    { cause: lastDisconnect },
  );
}

function receiveExactEvent(input: {
  idempotencyKey: string;
  socket: WebSocket;
  timeoutErrorMs: number;
  timeoutMs: number;
}): Promise<StreamEvent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.socket.removeEventListener("message", onMessage);
      input.socket.removeEventListener("close", onClose);
      input.socket.removeEventListener("error", onError);
    };
    const settle = (outcome: { event: StreamEvent } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("event" in outcome) resolve(outcome.event);
      else reject(outcome.error);
    };
    const onMessage = (message: MessageEvent) => {
      if (typeof message.data !== "string") {
        settle({ error: new Error("Stream idempotency wait received a non-text frame.") });
        closeProtocolDefect(input.socket);
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(message.data);
      } catch (error) {
        settle({
          error: new Error("Stream idempotency wait received invalid JSON.", { cause: error }),
        });
        closeProtocolDefect(input.socket);
        return;
      }
      const parsed = StreamEventSchema.safeParse(decoded);
      if (!parsed.success) {
        settle({
          error: new Error("Stream idempotency wait received an invalid StreamEvent.", {
            cause: parsed.error,
          }),
        });
        closeProtocolDefect(input.socket);
        return;
      }
      if (parsed.data.idempotencyKey !== input.idempotencyKey) {
        settle({
          error: new Error(
            `Stream idempotency wait received key ${JSON.stringify(parsed.data.idempotencyKey)}; expected ${JSON.stringify(input.idempotencyKey)}.`,
          ),
        });
        closeProtocolDefect(input.socket);
        return;
      }
      settle({ event: parsed.data });
    };
    const onClose = (event: CloseEvent) => {
      settle({
        error: new WaitSocketDisconnectedError(
          `socket closed before delivery (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        ),
      });
    };
    const onError = () => {
      settle({ error: new WaitSocketDisconnectedError("socket errored before delivery") });
    };
    const timer = setTimeout(() => {
      settle({
        error: idempotencyWaitTimeout(input.timeoutErrorMs, input.idempotencyKey),
      });
      try {
        input.socket.close(1000, "absolute wait deadline reached");
      } catch {
        // A peer may close concurrently with the deadline. The timeout is the
        // authoritative outcome either way.
      }
    }, input.timeoutMs);

    input.socket.addEventListener("message", onMessage);
    input.socket.addEventListener("close", onClose);
    input.socket.addEventListener("error", onError);
  });
}

function closeProtocolDefect(socket: WebSocket): void {
  try {
    socket.close(1002, "invalid idempotency wait frame");
  } catch {
    // The protocol error is already the authoritative outcome.
  }
}

function idempotencyWaitTimeout(timeoutMs: number, idempotencyKey: string): Error {
  return new StreamIdempotencyWaitTimeoutError(timeoutMs, idempotencyKey);
}
