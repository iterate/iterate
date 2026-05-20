/**
 * Shared append pump: send `op: append` frames and optionally wait for echoed events.
 *
 * With `reconnect`, uses [partysocket](https://github.com/partykit/partysocket) so a dropped
 * connection (e.g. `ctx.abort` on the Stream DO) resumes with `after=<last offset>`.
 */

import { WebSocket as ReconnectingWebSocket } from "partysocket";

/** Minimal surface shared by Node, Worker, and DO WebSockets. */
export type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  bufferedAmount?: number;
  accept?(): void;
  /** partysocket: false after intentional close or max retries. */
  shouldReconnect?: boolean;
};

export async function pumpAppendBenchmark(args: {
  /** Existing socket (Worker/DO benchmarks). Omit when `url` + `reconnect` create one. */
  ws?: WebSocketLike;
  /** HTTP(S) or WS(S) URL for the stream; used with `reconnect` to build resuming URLs. */
  url?: string;
  messages: number;
  runId: string;
  processorSlug: string;
  waitForEvents: boolean;
  maxBufferedBytes?: number;
  /** Worker stub.fetch WebSockets are already open after accept(); Node must wait for open. */
  startImmediately?: boolean;
  /** Initial `after` cursor (default `end`). Updated to last echoed offset on reconnect. */
  after?: string;
  reconnect?: {
    maxRetries?: number;
    minReconnectionDelay?: number;
    maxReconnectionDelay?: number;
  };
}): Promise<{
  sent: number;
  received: number;
  errors: number;
  reconnects: number;
  elapsedMs: number;
  firstEventMs?: number;
  appendsPerSecond: number;
}> {
  const maxBuffered = args.maxBufferedBytes ?? 1_000_000;
  let resumeAfter = args.after ?? "end";
  let reconnects = 0;

  const ws =
    args.ws ??
    (args.url && args.reconnect
      ? createReconnectingWebSocket({
          url: args.url,
          getAfter: () => resumeAfter,
          reconnect: args.reconnect,
        })
      : undefined);

  if (!ws) {
    throw new Error("pumpAppendBenchmark requires ws or url with reconnect");
  }

  return new Promise((resolve, reject) => {
    let openedAt = 0;
    let firstEventAt: number | undefined;
    let sent = 0;
    let received = 0;
    let errors = 0;
    let closed = false;
    const seenOffsets = new Set<number>();

    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket benchmark timed out (sent=${sent}, received=${received})`));
    }, 600_000);

    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      const elapsedMs = performance.now() - (openedAt || performance.now());
      const count = args.waitForEvents ? received : sent;
      resolve({
        sent,
        received,
        errors,
        reconnects,
        elapsedMs,
        firstEventMs: firstEventAt === undefined ? undefined : firstEventAt - openedAt,
        appendsPerSecond: count / (elapsedMs / 1_000),
      });
    };

    const needsMoreSends = () => {
      if (args.waitForEvents && args.reconnect) {
        return received < args.messages;
      }
      return sent < args.messages;
    };

    const pump = () => {
      while (needsMoreSends() && (ws.bufferedAmount ?? 0) < maxBuffered) {
        sent += 1;
        ws.send(
          JSON.stringify({
            op: "append",
            event: {
              type: "benchmark.message",
              payload: { n: sent },
              metadata: { runId: args.runId },
              source: { processor: { slug: args.processorSlug, version: "v0" } },
            },
          }),
        );
      }
      if (needsMoreSends()) {
        setImmediate(pump);
      } else if (!args.waitForEvents) {
        ws.close(1000, "benchmark complete");
        finish();
      }
    };

    const onOpen = () => {
      if (openedAt === 0) {
        openedAt = performance.now();
      } else {
        reconnects += 1;
      }
      pump();
    };

    if (args.startImmediately) {
      onOpen();
    } else {
      ws.addEventListener("open", onOpen);
    }

    ws.addEventListener("message", (message: unknown) => {
      const data = (message as { data?: unknown }).data;
      const frame = JSON.parse(String(data)) as {
        type?: string;
        after?: number;
        event?: { offset?: number; metadata?: { runId?: unknown } };
      };
      if (frame.type === "ready") {
        if (typeof frame.after === "number") {
          resumeAfter = String(frame.after);
        }
        return;
      }
      if (frame.type === "error") {
        errors += 1;
        return;
      }
      if (frame.type !== "event" || frame.event?.metadata?.runId !== args.runId) return;

      const offset = frame.event.offset;
      if (typeof offset === "number") {
        if (seenOffsets.has(offset)) return;
        seenOffsets.add(offset);
        resumeAfter = String(offset);
      }

      firstEventAt ??= performance.now();
      received += 1;
      if (args.waitForEvents) {
        pump();
        if (received >= args.messages) {
          ws.close(1000, "benchmark complete");
          finish();
        }
      }
    });

    ws.addEventListener("error", () => {
      errors += 1;
    });

    ws.addEventListener("close", () => {
      if (args.reconnect && args.waitForEvents && received < args.messages) {
        if (ws.shouldReconnect !== false) return;
        reject(
          new Error(
            `WebSocket closed before benchmark finished (sent=${sent}, received=${received}, reconnects=${reconnects})`,
          ),
        );
        return;
      }
      finish();
    });
  });
}

function createReconnectingWebSocket(args: {
  url: string;
  getAfter: () => string;
  reconnect: NonNullable<Parameters<typeof pumpAppendBenchmark>[0]["reconnect"]>;
}): WebSocketLike {
  const socket = new ReconnectingWebSocket(
    () => {
      const next = new URL(toWebSocketUrl(args.url));
      next.searchParams.set("after", args.getAfter());
      return next.toString();
    },
    undefined,
    {
      maxRetries: args.reconnect.maxRetries ?? 1_000,
      minReconnectionDelay: args.reconnect.minReconnectionDelay ?? 100,
      maxReconnectionDelay: args.reconnect.maxReconnectionDelay ?? 3_000,
    },
  );
  return socket as unknown as WebSocketLike;
}

function toWebSocketUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}
