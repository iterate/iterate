import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE } from "@iterate-com/services-contracts/events";
import { type RawData, WebSocketServer } from "ws";

import { type EventBusClient } from "../orpc/client.ts";
import {
  createPushSubscriptionPayload,
  type CreatePushSubscriptionPayloadInput,
} from "../push-subscriptions.ts";

export interface RpcWebSocket {
  readonly readyState: 0 | 1 | 2 | 3;
  addEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  send: (data: string | ArrayBufferLike | Uint8Array) => void;
}

interface AsyncDisposable {
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export const asRpcWebSocket = (websocket: WebSocket): RpcWebSocket =>
  websocket as unknown as RpcWebSocket;

export const uniquePath = (name: string): string =>
  `/test/${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

export const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  options?: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly timeoutMessage?: string;
  },
): Promise<void> => {
  const timeoutMs = options?.timeoutMs ?? 3_000;
  const intervalMs = options?.intervalMs ?? 25;
  const timeoutMessage = options?.timeoutMessage ?? `Timed out after ${timeoutMs}ms`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }

  throw new Error(timeoutMessage);
};

export const disposeWithTimeout = async (
  value: AsyncDisposable | undefined,
  timeoutMs = 200,
): Promise<void> => {
  await Promise.race([value?.[Symbol.asyncDispose]() ?? Promise.resolve(), sleep(timeoutMs)]);
};

export interface WebhookFixture {
  readonly url: string;
  readonly bodies: ReadonlyArray<Record<string, unknown>>;
  readonly headers: ReadonlyArray<Record<string, unknown>>;
  waitForDeliveries: (expected: number) => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

export interface StartWebhookFixtureOptions {
  readonly statusCodes?: ReadonlyArray<number>;
  readonly beforeRespond?: (input: {
    attempt: number;
    body: Record<string, unknown>;
  }) => Promise<void> | void;
}

export interface WebSocketFixture {
  readonly url: string;
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly requestHeaders: ReadonlyArray<Record<string, unknown>>;
  waitForEvents: (expected: number) => Promise<void>;
  getConnectionCount: () => number;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

export interface StartWebSocketFixtureOptions {
  readonly onEvent?: (input: {
    event: Record<string, unknown>;
    attempt: number;
  }) => Promise<void> | void;
}

export interface TempDirFixture {
  readonly path: string;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

const toRecord = (headers: Headers | IncomingMessage["headers"]): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  return result;
};

const toText = (message: RawData | string | ArrayBuffer | Uint8Array): string => {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return Buffer.concat(
      message.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk))),
    ).toString("utf8");
  }
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString("utf8");
  if (message instanceof Uint8Array) return new TextDecoder().decode(message);
  return new TextDecoder().decode(new Uint8Array(message));
};

export const startWebhookFixture = async (
  options: StartWebhookFixtureOptions = {},
  waitOptions: WaitOptions = {},
): Promise<WebhookFixture> => {
  const statusCodes = options.statusCodes ?? [200];
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, unknown>> = [];
  let attempts = 0;
  const timeoutMs = waitOptions.timeoutMs ?? 3_000;
  const intervalMs = waitOptions.intervalMs ?? 25;

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "POST" || pathname !== "/callback") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    const chunks: Array<Buffer> = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          bodies.push(body);
          headers.push(toRecord(request.headers));
          attempts += 1;
          await options.beforeRespond?.({ attempt: attempts, body });
          const statusCode = statusCodes[Math.min(attempts - 1, statusCodes.length - 1)] ?? 200;
          response.statusCode = statusCode;
          response.end(statusCode >= 400 ? "error" : "ok");
        } catch {
          response.statusCode = 400;
          response.end("invalid json");
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(error));
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw new Error("Expected TCP address for webhook fixture");
  }
  const host =
    address.address === "0.0.0.0" || address.address === "::" ? "127.0.0.1" : address.address;

  return {
    url: `http://${host}:${address.port}/callback`,
    bodies,
    headers,
    waitForDeliveries: async (expected: number) => {
      await waitUntil(() => bodies.length >= expected, {
        timeoutMs,
        intervalMs,
        timeoutMessage: `Timed out waiting for ${expected} deliveries, saw ${bodies.length}`,
      });
    },
    [Symbol.asyncDispose]: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

export const startWebSocketFixture = async (
  options: StartWebSocketFixtureOptions = {},
  waitOptions: WaitOptions = {},
): Promise<WebSocketFixture> => {
  const events: Array<Record<string, unknown>> = [];
  const requestHeaders: Array<Record<string, unknown>> = [];
  let connectionCount = 0;
  let attempts = 0;
  const timeoutMs = waitOptions.timeoutMs ?? 3_000;
  const intervalMs = waitOptions.intervalMs ?? 25;

  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end("not found");
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on("connection", (socket, request) => {
    connectionCount += 1;
    requestHeaders.push(toRecord(request.headers));
    socket.on("message", (message) => {
      const event = JSON.parse(toText(message)) as Record<string, unknown>;
      events.push(event);
      attempts += 1;
      void options.onEvent?.({ event, attempt: attempts });
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/callback") {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      websocketServer.emit("connection", ws, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(error));
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw new Error("Expected TCP address for websocket fixture");
  }
  const host =
    address.address === "0.0.0.0" || address.address === "::" ? "127.0.0.1" : address.address;

  return {
    url: `ws://${host}:${address.port}/callback`,
    events,
    requestHeaders,
    waitForEvents: async (expected: number) => {
      await waitUntil(() => events.length >= expected, {
        timeoutMs,
        intervalMs,
        timeoutMessage: `Timed out waiting for ${expected} websocket events, saw ${events.length}`,
      });
    },
    getConnectionCount: () => connectionCount,
    [Symbol.asyncDispose]: async () => {
      await new Promise<void>((resolve) => {
        websocketServer.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

export const startTempDirFixture = async (prefix: string): Promise<TempDirFixture> => {
  const safePrefix = prefix.replaceAll(/[^a-zA-Z0-9-_]/g, "-");
  const tempPath = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), `${safePrefix}-`));

  return {
    path: tempPath,
    [Symbol.asyncDispose]: async () => {
      await rm(tempPath, { recursive: true, force: true });
    },
  };
};

export const formatOffset = (value: number): string => value.toString().padStart(16, "0");

export const expectedOffsets = (from: number, count: number): Array<string> =>
  Array.from({ length: count }, (_, index) => formatOffset(from + index));

export interface AppendSubscriptionRegistrationInput extends CreatePushSubscriptionPayloadInput {
  readonly path: string;
}

export const appendSubscriptionRegistration = async (
  client: EventBusClient,
  input: AppendSubscriptionRegistrationInput,
): Promise<void> => {
  const payload = createPushSubscriptionPayload(input);

  await client.append({
    path: input.path,
    events: [
      {
        type: PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE,
        payload,
      },
    ],
  });
};

export const waitForDbOffset = async (
  dbPath: string,
  streamPath: string,
  subscriptionSlug: string,
  expected: string,
  options: WaitOptions = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 25;

  const readDbOffset = async (): Promise<string | null> => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT last_delivered_offset FROM event_stream_subscriptions WHERE event_stream_path = ? AND subscription_slug = ?",
      )
      .get(streamPath, subscriptionSlug) as { last_delivered_offset: string | null } | undefined;
    db.close();
    return row?.last_delivered_offset ?? null;
  };

  await waitUntil(async () => (await readDbOffset()) === expected, {
    timeoutMs,
    intervalMs,
    timeoutMessage: `Timed out waiting for last_delivered_offset=${expected}`,
  });
};

export const toSseBaseURL = (orpcURL: string): string =>
  orpcURL.replace(/(?:\/api(?:\/orpc)?|\/orpc)$/, "");

export const collectSseDataEvents = async (
  url: string,
  count: number,
  timeoutMs: number,
): Promise<Array<Record<string, unknown>>> => {
  const response = await fetch(url, { headers: { accept: "text/event-stream" } });
  if (!response.ok || response.body === null) {
    throw new Error(`Expected SSE response, got status=${response.status}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const events: Array<Record<string, unknown>> = [];
  let buffer = "";

  try {
    while (events.length < count) {
      const next = await withTimeout(reader.read(), timeoutMs);
      if (next.done) break;

      buffer += decoder.decode(next.value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        const eventType = lines.find((line) => line.startsWith("event: "))?.slice(7);
        if (eventType !== "data") continue;
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (dataLine === undefined) continue;
        events.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
      }
    }
  } finally {
    await reader.cancel();
  }

  return events;
};

export const collectIteratorEvents = async <T>(
  iterator: AsyncIterable<T>,
  count: number,
  timeoutMs: number,
): Promise<Array<T>> => {
  const events: Array<T> = [];
  const iterable = iterator[Symbol.asyncIterator]();

  try {
    while (events.length < count) {
      const next = await withTimeout(iterable.next(), timeoutMs);
      if (next.done) break;
      events.push(next.value);
    }

    return events;
  } finally {
    if (iterable.return !== undefined) {
      await Promise.race([Promise.resolve(iterable.return()), sleep(250)]).catch(() => undefined);
    }
  }
};
