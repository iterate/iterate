/**
 * Daemon Entry Point
 *
 * This is a Hono-based HTTP server that provides:
 * - Agent management via event streams
 * - Persistent stream storage
 * - SSE subscriptions for real-time events
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, Stream, Fiber, Deferred, Scope, ManagedRuntime } from "effect";

import { Storage } from "./event-stream/storage.ts";
import { ActiveFactory } from "./event-stream/stream-factory.ts";
import { StreamManagerService } from "./event-stream/stream-manager.ts";
import { type StreamName, type Offset, OFFSET_START } from "./event-stream/types.ts";
import { runPiAdapter } from "./agents/pi/adapter.ts";
import {
  makePromptEvent,
  makeSessionCreateEvent,
  type EventStreamId,
  PiEventTypes,
} from "./agents/pi/types.ts";

/** Data directory for all event-stream files */
const DATA_DIR = ".iterate";

// ─────────────────────────────────────────────────────────────────────────────
// Effect Runtime Setup
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_DIR = path.join(process.cwd(), DATA_DIR);

// Ensure storage directory exists
fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Build the Effect layer stack
const storageLayer = Storage.FileSystem({ dataDir: STORAGE_DIR }).pipe(
  Layer.provide(NodeContext.layer),
);

const streamManagerLayer = StreamManagerService.Live.pipe(
  Layer.provide(ActiveFactory),
  Layer.provide(storageLayer),
);

const mainLayer = Layer.mergeAll(streamManagerLayer, NodeContext.layer);

// Create a shared runtime that holds the service instances.
// This is critical: all effects must use this runtime to share the same StreamManager
// (and therefore the same PubSub for live subscriptions).
const runtime = ManagedRuntime.make(mainLayer);

// Helper to run effects with the shared runtime (with scope for stream operations)
const runEffect = <A, E>(effect: Effect.Effect<A, E, StreamManagerService>): Promise<A> =>
  runtime.runPromise(Effect.scoped(effect));

// Helper to run scoped effects (already has Scope requirement)
const runScopedEffect = <A, E>(
  effect: Effect.Effect<A, E, StreamManagerService | Scope.Scope>,
): Promise<A> => runtime.runPromise(Effect.scoped(effect));

// ─────────────────────────────────────────────────────────────────────────────
// Adapter State (tracks running Pi adapters)
// ─────────────────────────────────────────────────────────────────────────────

interface AdapterInfo {
  streamName: StreamName;
  eventStreamId: EventStreamId;
  fiber: Fiber.RuntimeFiber<void, unknown> | null;
  createdAt: Date;
}

const adapters = new Map<string, AdapterInfo>();

// Track pending session creations to prevent race conditions
const pendingSessionCreations = new Map<
  string,
  Promise<{ streamName: StreamName; eventStreamId: EventStreamId }>
>();

// Registry SSE subscribers - used to broadcast when adapters are created/deleted
type RegistrySubscriber = (event: {
  type: "stream";
  key: string;
  value: { path: string; contentType: string; createdAt: number };
  headers: { operation: "insert" | "delete" };
}) => Promise<void>;
const registrySubscribers = new Set<RegistrySubscriber>();

function broadcastToRegistry(event: Parameters<RegistrySubscriber>[0]): void {
  for (const subscriber of registrySubscribers) {
    subscriber(event).catch(() => {
      registrySubscribers.delete(subscriber);
    });
  }
}

/**
 * Start a new Pi adapter session
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

async function startPiSession(
  streamName?: string,
): Promise<{ streamName: StreamName; eventStreamId: EventStreamId }> {
  const name = (streamName ?? `pi-${generateId()}`) as StreamName;
  const eventStreamId = name as unknown as EventStreamId;

  // Check if adapter already exists
  if (adapters.has(name)) {
    return { streamName: name, eventStreamId };
  }

  // Check if creation is already in progress (race condition prevention)
  const pending = pendingSessionCreations.get(name);
  if (pending) {
    return pending;
  }

  console.log(`[Daemon] Starting Pi session: ${name}`);

  // Create the session creation promise and track it
  const creationPromise = (async () => {
    // Track the adapter (fiber will be set when started)
    adapters.set(name, {
      streamName: name,
      eventStreamId,
      fiber: null,
      createdAt: new Date(),
    });

    // Create a deferred to wait for adapter to be ready
    const adapterReady = await Effect.runPromise(Deferred.make<void, never>());

    // Start the adapter in a SEPARATE scope that stays open for the lifetime of the adapter.
    // This is critical: the subscription to the stream requires a scope, and if we fork
    // within a scoped effect that completes, the subscription would be closed.
    // We use runtime.runFork to ensure the adapter shares the same StreamManager instance
    // as the HTTP handlers (so PubSub subscriptions work correctly).
    const adapterEffect = Effect.scoped(runPiAdapter(name, eventStreamId, adapterReady));

    const fiber = runtime.runFork(adapterEffect);

    // Update adapter info with fiber
    const info = adapters.get(name);
    if (info) {
      info.fiber = fiber as unknown as Fiber.RuntimeFiber<void, unknown>;
    }

    // Wait for adapter to be ready
    await Effect.runPromise(Deferred.await(adapterReady));

    // Check if stream already has a session-create event (e.g., after server restart)
    // If so, skip creating a new one to avoid duplicates
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
      // Send session create event only if one doesn't exist
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

    // Notify registry subscribers about the new adapter
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

  // Track the pending creation
  pendingSessionCreations.set(name, creationPromise);

  try {
    return await creationPromise;
  } finally {
    pendingSessionCreations.delete(name);
  }
}

/**
 * Stop an adapter
 */
async function stopAdapter(streamName: string): Promise<boolean> {
  const adapter = adapters.get(streamName);
  if (!adapter) return false;

  if (adapter.fiber) {
    await Effect.runPromise(Fiber.interrupt(adapter.fiber));
  }

  adapters.delete(streamName);

  // Notify registry subscribers about the deleted adapter
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Stream-Seq",
      "Stream-TTL",
      "Stream-Expires-At",
    ],
    exposeHeaders: [
      "Stream-Next-Offset",
      "Stream-Cursor",
      "Stream-Up-To-Date",
      "ETag",
      "Content-Type",
      "Content-Encoding",
      "Vary",
      "Location",
    ],
  }),
);

app.get("/", (c) => c.redirect("/ui"));
app.get("/platform/ping", (c) => c.text("PONG"));

// ─────────────────────────────────────────────────────────────────────────────
// Agent Routes
// ─────────────────────────────────────────────────────────────────────────────

const STREAM_OFFSET_HEADER = "Stream-Next-Offset";

function getStreamPathFromRequest(c: { req: { path: string } }): string {
  const rawPath = c.req.path.replace("/agents/", "");
  return decodeURIComponent(rawPath);
}

/** PUT /agents/:name - Create agent */
app.put("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);
  const contentType = c.req.header("content-type") || "application/json";

  // Check if it's a special stream (registry)
  if (streamPath.startsWith("__")) {
    // Just acknowledge - registry is handled specially
    return new Response(null, { status: 200 });
  }

  // Check if adapter exists
  const existing = adapters.has(streamPath);

  if (!existing) {
    // Create new Pi session with this name
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

/** POST /agents/:name - Send message */
app.post("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Invalid JSON", 400);
  }

  // Extract message text
  let messageText: string;
  if (typeof body === "string") {
    messageText = body;
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    messageText = String(obj.text ?? obj.message ?? obj.prompt ?? JSON.stringify(body));
  } else {
    messageText = String(body);
  }

  // Ensure adapter exists
  let adapter = adapters.get(streamPath);
  if (!adapter) {
    await startPiSession(streamPath);
    adapter = adapters.get(streamPath)!;
  }

  // Send prompt event to the stream
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

/** GET /agents/__registry__ - Registry stream (SSE) */
app.get("/agents/__registry__", (c) => {
  const live = c.req.query("live");

  if (live !== "sse") {
    return c.text("Registry requires live=sse", 400);
  }

  return streamSSE(c, async (stream) => {
    // Send existing adapters as registry events
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

    // Send control event indicating we're up to date
    await stream.writeSSE({
      event: "control",
      data: JSON.stringify({ streamNextOffset: "0", upToDate: true }),
    });

    // Register as a subscriber for future updates
    const subscriber: RegistrySubscriber = async (event) => {
      await stream.writeSSE({ event: "data", data: JSON.stringify([event]) });
    };
    registrySubscribers.add(subscriber);

    // Keep connection open and clean up on disconnect
    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => {
        registrySubscribers.delete(subscriber);
        resolve();
      });
    });
  });
});

/** GET /agents/:name - Subscribe to agent stream (SSE) */
app.get("/agents/*", (c) => {
  const streamPath = getStreamPathFromRequest(c);
  const offset = c.req.query("offset") ?? "-1";
  const live = c.req.query("live");

  // Registry is handled above
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
      // Subscribe to the stream
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
          // Stream doesn't exist - send empty and keep open
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

              // Send all events as-is - the reducer handles unwrapping Pi events
              stream.writeSSE({ event: "data", data: JSON.stringify([event.data]) });

              // Send control event with offset
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

    // Keep connection alive
    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => resolve());
    });
  });
});

/** DELETE /agents/:name - Delete agent */
app.delete("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);

  // Stop the adapter
  const stopped = await stopAdapter(streamPath);

  // Delete the stream
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

/** HEAD /agents/:name - Check if agent exists */
app.on("HEAD", "/agents/*", (c) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Stream Routes (for compatibility)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /streams - List all streams */
app.get("/streams", async (c) => {
  const streams = await runEffect(
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;
      return yield* manager.list();
    }),
  );

  return c.json({ streams });
});

export default app;
