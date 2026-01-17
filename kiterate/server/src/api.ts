/**
 * HTTP API for event streams using Hono
 */
import { Duration, Effect, Stream } from "effect";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  OFFSET_START,
  type Offset,
  type StreamManager,
  type StreamName,
} from "./event-stream/index.ts";

export const createApi = (streamManager: StreamManager) => {
  const app = new Hono();

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
    return c.json({ deleted: true });
  });

  return app;
};
