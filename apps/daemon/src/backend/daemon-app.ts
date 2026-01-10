import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Effect, Stream, Fiber, Deferred } from "effect";

import { StreamManagerService } from "./event-stream/stream-manager.ts";
import { type StreamName, type Offset, OFFSET_START } from "./event-stream/types.ts";
import { runPiAdapter } from "./agents/pi/adapter.ts";
import {
  makePromptEvent,
  makeSessionCreateEvent,
  type EventStreamId,
  PiEventTypes,
} from "./agents/pi/types.ts";
import { runtime, runEffect, runScopedEffect } from "./runtime.ts";

interface AdapterInfo {
  streamName: StreamName;
  eventStreamId: EventStreamId;
  fiber: Fiber.RuntimeFiber<void, unknown> | null;
  createdAt: Date;
}

// Use global storage to survive HMR
declare global {
  var __daemon_adapters: Map<string, AdapterInfo> | undefined;

  var __daemon_pending:
    | Map<string, Promise<{ streamName: StreamName; eventStreamId: EventStreamId }>>
    | undefined;

  var __daemon_registry_subscribers: Set<RegistrySubscriber> | undefined;
}

const adapters = globalThis.__daemon_adapters ?? new Map<string, AdapterInfo>();
globalThis.__daemon_adapters = adapters;

const pendingSessionCreations =
  globalThis.__daemon_pending ??
  new Map<string, Promise<{ streamName: StreamName; eventStreamId: EventStreamId }>>();
globalThis.__daemon_pending = pendingSessionCreations;

type RegistrySubscriber = (event: {
  type: "stream";
  key: string;
  value: { path: string; contentType: string; createdAt: number };
  headers: { operation: "insert" | "delete" };
}) => Promise<void>;

const registrySubscribers =
  globalThis.__daemon_registry_subscribers ?? new Set<RegistrySubscriber>();
globalThis.__daemon_registry_subscribers = registrySubscribers;

function broadcastToRegistry(event: Parameters<RegistrySubscriber>[0]): void {
  for (const subscriber of registrySubscribers) {
    subscriber(event).catch(() => {
      registrySubscribers.delete(subscriber);
    });
  }
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

async function startPiSession(
  streamName?: string,
): Promise<{ streamName: StreamName; eventStreamId: EventStreamId }> {
  const name = (streamName ?? `pi-${generateId()}`) as StreamName;
  const eventStreamId = name as unknown as EventStreamId;

  if (adapters.has(name)) {
    return { streamName: name, eventStreamId };
  }

  const pending = pendingSessionCreations.get(name);
  if (pending) {
    return pending;
  }

  console.log(`[Daemon] Starting Pi session: ${name}`);

  const creationPromise = (async () => {
    adapters.set(name, {
      streamName: name,
      eventStreamId,
      fiber: null,
      createdAt: new Date(),
    });

    const adapterReady = await Effect.runPromise(Deferred.make<void, never>());

    const adapterEffect = Effect.scoped(runPiAdapter(name, eventStreamId, adapterReady));

    const fiber = runtime.runFork(adapterEffect);

    const info = adapters.get(name);
    if (info) {
      info.fiber = fiber as unknown as Fiber.RuntimeFiber<void, unknown>;
    }

    await Effect.runPromise(Deferred.await(adapterReady));

    const existingEvents = await runEffect(
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        return yield* manager.getFrom({ name });
      }),
    );

    const hasSessionCreate = existingEvents.some((e) => {
      const data = e.data as { type?: string } | null;
      return data?.type === PiEventTypes.SESSION_CREATE;
    });

    if (!hasSessionCreate) {
      const createEvent = makeSessionCreateEvent(eventStreamId, {
        cwd: process.env.INIT_CWD ?? process.cwd(),
      });

      await runEffect(
        Effect.gen(function* () {
          const manager = yield* StreamManagerService;
          yield* manager.append({
            name,
            data: createEvent,
          });
        }),
      );
    }

    console.log(`[Daemon] Pi session started: ${name}${hasSessionCreate ? " (reattached)" : ""}`);

    const adapterInfo = adapters.get(name);
    if (adapterInfo) {
      broadcastToRegistry({
        type: "stream",
        key: name,
        value: {
          path: name,
          contentType: "application/json",
          createdAt: adapterInfo.createdAt.getTime(),
        },
        headers: { operation: "insert" },
      });
    }

    return { streamName: name, eventStreamId };
  })();

  pendingSessionCreations.set(name, creationPromise);

  try {
    return await creationPromise;
  } finally {
    pendingSessionCreations.delete(name);
  }
}

async function stopAdapter(streamName: string): Promise<boolean> {
  const adapter = adapters.get(streamName);
  if (!adapter) return false;

  if (adapter.fiber) {
    await Effect.runPromise(Fiber.interrupt(adapter.fiber));
  }

  adapters.delete(streamName);

  broadcastToRegistry({
    type: "stream",
    key: streamName,
    value: {
      path: streamName,
      contentType: "application/json",
      createdAt: adapter.createdAt.getTime(),
    },
    headers: { operation: "delete" },
  });

  return true;
}

const STREAM_OFFSET_HEADER = "Stream-Next-Offset";

function getStreamPathFromRequest(c: { req: { path: string } }): string {
  const rawPath = c.req.path.replace(/^(\/api)?\/agents\//, "");
  return decodeURIComponent(rawPath);
}

export const daemonApp = new Hono();

daemonApp.get("/platform/ping", (c) => c.text("PONG"));

daemonApp.put("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);
  const contentType = c.req.header("content-type") || "application/json";

  if (streamPath.startsWith("__")) {
    return new Response(null, { status: 200 });
  }

  const existing = adapters.has(streamPath);

  if (!existing) {
    await startPiSession(streamPath);
  }

  return new Response(null, {
    status: existing ? 200 : 201,
    headers: {
      [STREAM_OFFSET_HEADER]: "0",
      ...(existing ? {} : { Location: c.req.url }),
      "Content-Type": contentType,
    },
  });
});

daemonApp.post("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Invalid JSON", 400);
  }

  let messageText: string;
  if (typeof body === "string") {
    messageText = body;
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    messageText = String(obj.text ?? obj.message ?? obj.prompt ?? JSON.stringify(body));
  } else {
    messageText = String(body);
  }

  let adapter = adapters.get(streamPath);
  if (!adapter) {
    await startPiSession(streamPath);
    adapter = adapters.get(streamPath)!;
  }

  const promptEvent = makePromptEvent(adapter.eventStreamId, messageText);

  await runEffect(
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;
      yield* manager.append({
        name: streamPath as StreamName,
        data: promptEvent,
      });
    }),
  );

  return new Response(null, {
    status: 200,
    headers: { [STREAM_OFFSET_HEADER]: "0" },
  });
});

daemonApp.get("/agents/__registry__", (c) => {
  const live = c.req.query("live");

  if (live !== "sse") {
    return c.text("Registry requires live=sse", 400);
  }

  return streamSSE(c, async (stream) => {
    for (const adapter of adapters.values()) {
      const event = {
        type: "stream",
        key: adapter.streamName,
        value: {
          path: adapter.streamName,
          contentType: "application/json",
          createdAt: adapter.createdAt.getTime(),
        },
        headers: { operation: "insert" },
      };
      await stream.writeSSE({ event: "data", data: JSON.stringify([event]) });
    }

    await stream.writeSSE({
      event: "control",
      data: JSON.stringify({ streamNextOffset: "0", upToDate: true }),
    });

    const subscriber: RegistrySubscriber = async (event) => {
      await stream.writeSSE({ event: "data", data: JSON.stringify([event]) });
    };
    registrySubscribers.add(subscriber);

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => {
        registrySubscribers.delete(subscriber);
        resolve();
      });
    });
  });
});

daemonApp.get("/agents/*", (c) => {
  const streamPath = getStreamPathFromRequest(c);
  const offset = c.req.query("offset") ?? "-1";
  const live = c.req.query("live");

  if (streamPath === "__registry__") {
    return c.text("Use registry endpoint", 400);
  }

  if (live === "sse" && !c.req.query("offset")) {
    return c.text("SSE requires offset parameter", 400);
  }

  if (live !== "sse") {
    return c.text("Only SSE mode supported", 400);
  }

  return streamSSE(c, async (stream) => {
    let lastOffset = "0";

    try {
      const effect = Effect.gen(function* () {
        const manager = yield* StreamManagerService;

        const parsedOffset: Offset | undefined =
          offset === "-1" ? OFFSET_START : (offset as Offset);

        const eventStreamResult = yield* manager
          .subscribe({
            name: streamPath as StreamName,
            offset: parsedOffset,
          })
          .pipe(Effect.either);

        if (eventStreamResult._tag === "Left") {
          yield* Effect.sync(() => {
            stream.writeSSE({
              event: "control",
              data: JSON.stringify({ streamNextOffset: "0", upToDate: true }),
            });
          });
          return;
        }

        const eventStream = eventStreamResult.right;

        yield* eventStream.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              lastOffset = event.offset;

              stream.writeSSE({ event: "data", data: JSON.stringify([event.data]) });

              stream.writeSSE({
                event: "control",
                data: JSON.stringify({ streamNextOffset: lastOffset, upToDate: true }),
              });
            }),
          ),
        );
      });

      await runScopedEffect(effect);
    } catch (error) {
      console.error(`[Daemon] SSE error for ${streamPath}:`, error);
    }

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => resolve());
    });
  });
});

daemonApp.delete("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);

  const stopped = await stopAdapter(streamPath);

  await runEffect(
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;
      yield* manager.delete({ name: streamPath as StreamName }).pipe(Effect.ignore);
    }),
  );

  if (!stopped) {
    return c.text("Agent not found", 404);
  }

  return new Response(null, { status: 204 });
});

daemonApp.on("HEAD", "/agents/*", (c) => {
  const streamPath = getStreamPathFromRequest(c);

  if (!adapters.has(streamPath)) {
    return new Response("Agent not found", { status: 404 });
  }

  return new Response(null, {
    status: 200,
    headers: {
      [STREAM_OFFSET_HEADER]: "0",
      "Content-Type": "application/json",
    },
  });
});

daemonApp.get("/streams", async (c) => {
  const streams = await runEffect(
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;
      return yield* manager.list();
    }),
  );

  return c.json({ streams });
});
