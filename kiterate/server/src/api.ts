/**
 * HTTP API for event streams using Hono
 */
import { Deferred, Duration, Effect, Fiber, Layer, Scope, Stream } from "effect";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  OFFSET_START,
  type Offset,
  type StreamManager,
  type StreamName,
} from "./event-stream/index.ts";
import { runPiAdapter } from "./agents/pi/adapter.ts";
import { StreamManagerService } from "./event-stream/stream-manager.ts";
import { makeSessionCreateEvent, type EventStreamId, PiEventTypes } from "./agents/pi/types.ts";

interface PiSessionInfo {
  streamName: StreamName;
  fiber: Fiber.RuntimeFiber<void, unknown>;
}

export const createApi = (streamManager: StreamManager) => {
  const app = new Hono();

  // Enable CORS for all routes
  app.use("*", cors());

  // Track active Pi sessions
  const piSessions = new Map<string, PiSessionInfo>();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // List all streams
  app.get("/streams", async (c) => {
    const result = await Effect.runPromise(streamManager.list());
    return c.json({ streams: result });
  });

  // Get events from a stream
  app.get("/streams/:name/events", async (c) => {
    const name = c.req.param("name") as StreamName;
    const offset = (c.req.query("offset") as Offset | undefined) ?? OFFSET_START;
    const limitStr = c.req.query("limit");
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const opts = limit !== undefined ? { name, offset, limit } : { name, offset };

    const result = await Effect.runPromise(
      streamManager
        .getFrom(opts)
        .pipe(
          Effect.catchTag("InvalidOffsetError", (e) =>
            Effect.succeed({ error: e._tag, message: e.message } as const),
          ),
        ),
    );

    if ("error" in result) {
      return c.json(result, 400);
    }

    return c.json({ events: result });
  });

  // Append event to a stream
  app.post("/streams/:name/events", async (c) => {
    const name = c.req.param("name") as StreamName;
    const body = await c.req.json<{ data: unknown }>();

    const event = await Effect.runPromise(streamManager.append({ name, data: body.data }));

    return c.json({ event }, 201);
  });

  // Subscribe to a stream (SSE)
  app.get("/streams/:name/subscribe", async (c) => {
    const name = c.req.param("name") as StreamName;
    const offset = (c.req.query("offset") as Offset | undefined) ?? OFFSET_START;

    return streamSSE(c, async (stream) => {
      // For SSE, we need to stream continuously
      const program = Effect.scoped(
        Effect.gen(function* () {
          const s = yield* streamManager.subscribe({ name, offset });
          yield* s.pipe(
            Stream.runForEach((event) =>
              Effect.promise(async () => {
                await stream.writeSSE({
                  data: JSON.stringify({
                    offset: event.offset,
                    eventStreamId: event.eventStreamId,
                    data: event.data,
                    createdAt: event.createdAt,
                  }),
                  event: "event",
                  id: event.offset,
                });
              }),
            ),
            Effect.timeout(Duration.hours(24)), // 24h timeout
          );
        }),
      );

      await Effect.runPromise(program.pipe(Effect.catchAll(() => Effect.void)));
    });
  });

  // Delete a stream
  app.delete("/streams/:name", async (c) => {
    const name = c.req.param("name") as StreamName;
    await Effect.runPromise(streamManager.delete({ name }));
    // Also stop any Pi session for this stream
    const session = piSessions.get(name);
    if (session) {
      await Effect.runPromise(Fiber.interrupt(session.fiber)).catch(() => {});
      piSessions.delete(name);
    }
    return c.json({ deleted: true });
  });

  // Start a Pi session for a stream
  app.post("/streams/:name/pi", async (c) => {
    const name = c.req.param("name") as StreamName;
    const eventStreamId = name as unknown as EventStreamId;

    // Check if session already exists
    if (piSessions.has(name)) {
      return c.json({ status: "already_running", streamName: name }, 200);
    }

    console.log(`[API] Starting Pi session for stream: ${name}`);

    try {
      // Create ready deferred for signaling when adapter is ready
      const readyDeferred = await Effect.runPromise(Deferred.make<void, never>());

      // Create the adapter effect with scoped resources
      const adapterEffect = Effect.scoped(runPiAdapter(name, eventStreamId, readyDeferred));

      // Fork the adapter with the StreamManager service provided
      // Create a layer from the existing stream manager instance
      const managerLayer = Layer.succeed(
        StreamManagerService,
        streamManager as StreamManagerService,
      );
      const fiber = await Effect.runPromise(
        adapterEffect.pipe(Effect.provide(managerLayer)).pipe(Effect.forkDaemon),
      );

      piSessions.set(name, {
        streamName: name,
        fiber: fiber as unknown as Fiber.RuntimeFiber<void, unknown>,
      });

      // Wait for adapter to be ready
      await Effect.runPromise(Deferred.await(readyDeferred));

      // Check if there's already a session-create event, if not, create one
      const existingEvents = await Effect.runPromise(streamManager.getFrom({ name }));
      const hasSessionCreate = existingEvents.some((e) => {
        const data = e.data as { type?: string } | null;
        return data?.type === PiEventTypes.SESSION_CREATE;
      });

      if (!hasSessionCreate) {
        const createEvent = makeSessionCreateEvent(eventStreamId, {
          cwd: process.env.INIT_CWD ?? process.cwd(),
        });
        await Effect.runPromise(streamManager.append({ name, data: createEvent }));
      }

      console.log(`[API] Pi session started: ${name}`);
      return c.json({ status: "started", streamName: name }, 201);
    } catch (error) {
      console.error(`[API] Failed to start Pi session: ${error}`);
      piSessions.delete(name);
      return c.json(
        {
          error: "failed_to_start",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  });

  // Stop a Pi session
  app.delete("/streams/:name/pi", async (c) => {
    const name = c.req.param("name") as StreamName;

    const session = piSessions.get(name);
    if (!session) {
      return c.json({ status: "not_running" }, 404);
    }

    await Effect.runPromise(Fiber.interrupt(session.fiber)).catch(() => {});
    piSessions.delete(name);

    console.log(`[API] Pi session stopped: ${name}`);
    return c.json({ status: "stopped" });
  });

  // Check Pi session status
  app.get("/streams/:name/pi", async (c) => {
    const name = c.req.param("name") as StreamName;
    const isRunning = piSessions.has(name);
    return c.json({ streamName: name, running: isRunning });
  });

  return app;
};
