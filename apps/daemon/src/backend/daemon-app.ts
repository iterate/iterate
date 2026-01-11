import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Effect, Stream, Fiber } from "effect";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { StreamManagerService } from "./event-stream/stream-manager.ts";
import { type StreamName, type Offset, OFFSET_START } from "./event-stream/types.ts";
import { makePromptEvent, type EventStreamId } from "./agents/pi/types.ts";
import { runtime, runEffect } from "./runtime.ts";
import { startPiSession, stopPiSession, hasFiber } from "./agent-runtime.ts";

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

  const [existing] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.slug, streamPath));

  if (!existing) {
    await startPiSession(streamPath);
    await db.insert(schema.agents).values({
      slug: streamPath,
      harnessType: "pi",
      harnessAgentId: streamPath,
      harnessData: {},
    });
  } else if (existing.harnessType === "pi" && !hasFiber(existing.harnessAgentId)) {
    await startPiSession(existing.harnessAgentId);
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

  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.slug, streamPath));
  if (!agent) {
    return c.text("Agent not found", 404);
  }

  if (agent.harnessType === "pi" && !hasFiber(agent.harnessAgentId)) {
    await startPiSession(agent.harnessAgentId);
  }

  const promptEvent = makePromptEvent(
    agent.harnessAgentId as unknown as EventStreamId,
    messageText,
  );

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

daemonApp.get("/agents/*", (c) => {
  const streamPath = getStreamPathFromRequest(c);
  const offset = c.req.query("offset") ?? "-1";
  const live = c.req.query("live");

  if (live === "sse" && !c.req.query("offset")) {
    return c.text("SSE requires offset parameter", 400);
  }

  if (live !== "sse") {
    return c.text("Only SSE mode supported", 400);
  }

  return streamSSE(c, async (stream) => {
    const effect = Effect.gen(function* () {
      const manager = yield* StreamManagerService;

      const parsedOffset: Offset | undefined = offset === "-1" ? OFFSET_START : (offset as Offset);

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
            stream.writeSSE({ event: "data", data: JSON.stringify([event.data]) });

            stream.writeSSE({
              event: "control",
              data: JSON.stringify({ streamNextOffset: event.offset, upToDate: true }),
            });
          }),
        ),
      );
    });

    const fiber = runtime.runFork(Effect.scoped(effect));

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => {
        Effect.runFork(Fiber.interrupt(fiber));
        resolve();
      });
    });
  });
});

daemonApp.delete("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);

  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.slug, streamPath));
  if (!agent) {
    return c.text("Agent not found", 404);
  }

  if (agent.harnessType === "pi") {
    await stopPiSession(agent.harnessAgentId);
  }

  await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));

  await runEffect(
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;
      yield* manager.delete({ name: streamPath as StreamName }).pipe(Effect.ignore);
    }),
  );

  return new Response(null, { status: 204 });
});

daemonApp.on("HEAD", "/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);

  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.slug, streamPath));
  if (!agent) {
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
