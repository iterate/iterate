/**
 * HTTP Routes for event-stream
 *
 * Endpoints:
 * - POST /streams/:name - Append event to stream (JSON body: { data: any })
 * - GET /streams/:name - Subscribe to stream (SSE). Query params: offset
 * - GET /streams/all - Subscribe to all streams (SSE, live events only)
 * - GET /streams - List all streams
 * - DELETE /streams/:name - Delete stream
 */
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";
import { StreamManagerService } from "./stream-manager.ts";
import { Event, type Offset, OFFSET_START, type StreamName } from "./types.ts";

/** Encode an Event as SSE data line */
const encodeSSE = (event: Event): Uint8Array => {
  const encoded = Schema.encodeSync(Event)(event);
  return new TextEncoder().encode(`data: ${JSON.stringify(encoded)}\n\n`);
};

/** Input schema for append */
const AppendInput = Schema.Struct({
  data: Schema.Unknown,
});

/** Parse JSON body for append */
const parseAppendBody = (body: string) =>
  Effect.gen(function* () {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`),
    });
    return yield* Schema.decodeUnknown(AppendInput)(json);
  });

/** POST /streams/:name - Append to stream */
const appendHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const manager = yield* StreamManagerService;
  const params = yield* HttpRouter.params;

  const name = params.name;
  if (!name) {
    return HttpServerResponse.text("Missing stream name", { status: 400 });
  }

  const body = yield* request.text;

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 });
  }

  const parseResult = yield* parseAppendBody(body).pipe(Effect.either);

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 });
  }

  const { data } = parseResult.right;

  const appendResult = yield* manager
    .append({ name: name as StreamName, data })
    .pipe(Effect.either);

  if (appendResult._tag === "Left") {
    const err = appendResult.left as { _tag: string; message: string; hookId?: string };
    // HookError from validation hooks (runtime check - factory may inject hooked streams)
    if (err._tag === "HookError" && err.hookId) {
      return yield* HttpServerResponse.json(
        { error: err.message, hookId: err.hookId },
        { status: 400 },
      );
    }
    // StorageError
    return yield* HttpServerResponse.json({ error: err.message }, { status: 500 });
  }

  const event = appendResult.right;
  const encoded = Schema.encodeSync(Event)(event);
  return yield* HttpServerResponse.json(encoded, { status: 201 });
});

/** GET /streams/:name - Subscribe to stream (SSE) */
const subscribeHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const manager = yield* StreamManagerService;
  const params = yield* HttpRouter.params;

  const name = params.name;
  if (!name) {
    return HttpServerResponse.text("Missing stream name", { status: 400 });
  }

  // Parse offset from query string
  const url = new URL(request.url, "http://localhost");
  const offsetParam = url.searchParams.get("offset");
  const offset: Offset | undefined =
    offsetParam === null
      ? undefined
      : offsetParam === "-1"
        ? OFFSET_START
        : (offsetParam as Offset);

  const eventStreamResult = yield* manager
    .subscribe({
      name: name as StreamName,
      offset,
    })
    .pipe(Effect.either);

  if (eventStreamResult._tag === "Left") {
    const err = eventStreamResult.left;
    if (err._tag === "InvalidOffsetError") {
      return HttpServerResponse.text(err.message, { status: 400 });
    }
    return HttpServerResponse.text(err.message, { status: 500 });
  }

  const eventStream = eventStreamResult.right;

  const sseStream = eventStream.pipe(Stream.map(encodeSSE));

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

/** GET /streams - List all streams */
const listHandler = Effect.gen(function* () {
  const manager = yield* StreamManagerService;

  const names = yield* manager.list().pipe(Effect.mapError((e) => new Error(e.message)));

  return yield* HttpServerResponse.json({ streams: names });
});

/** DELETE /streams/:name - Delete stream */
const deleteHandler = Effect.gen(function* () {
  const manager = yield* StreamManagerService;
  const params = yield* HttpRouter.params;

  const name = params.name;
  if (!name) {
    return HttpServerResponse.text("Missing stream name", { status: 400 });
  }

  yield* manager
    .delete({ name: name as StreamName })
    .pipe(Effect.mapError((e) => new Error(e.message)));

  return HttpServerResponse.empty({ status: 204 });
});

/** GET /streams/all - Subscribe to all streams (SSE, live events only) */
const subscribeAllHandler = Effect.gen(function* () {
  const manager = yield* StreamManagerService;

  const eventStreamResult = yield* manager.subscribeAll().pipe(Effect.either);

  if (eventStreamResult._tag === "Left") {
    const err = eventStreamResult.left;
    return HttpServerResponse.text(err.message, { status: 500 });
  }

  const eventStream = eventStreamResult.right;

  const sseStream = eventStream.pipe(Stream.map(encodeSSE));

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

/** GET /streams/:name/events - Get historic events (one-shot, no SSE) */
const getEventsHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const manager = yield* StreamManagerService;
  const params = yield* HttpRouter.params;

  const name = params.name;
  if (!name) {
    return HttpServerResponse.text("Missing stream name", { status: 400 });
  }

  // Parse offset and limit from query string
  const url = new URL(request.url, "http://localhost");
  const offsetParam = url.searchParams.get("offset");
  const limitParam = url.searchParams.get("limit");

  const offset: Offset | undefined =
    offsetParam === null
      ? undefined
      : offsetParam === "-1"
        ? OFFSET_START
        : (offsetParam as Offset);

  const limit = limitParam ? parseInt(limitParam, 10) : undefined;

  const getFromOpts: { name: StreamName; offset?: Offset; limit?: number } = {
    name: name as StreamName,
  };
  if (offset !== undefined) {
    getFromOpts.offset = offset;
  }
  if (limit !== undefined && !isNaN(limit)) {
    getFromOpts.limit = limit;
  }
  const eventsResult = yield* manager.getFrom(getFromOpts).pipe(Effect.either);

  if (eventsResult._tag === "Left") {
    const err = eventsResult.left;
    if (err._tag === "InvalidOffsetError") {
      return HttpServerResponse.text(err.message, { status: 400 });
    }
    return HttpServerResponse.text(err.message, { status: 500 });
  }

  const events = eventsResult.right.map((e) => Schema.encodeSync(Event)(e));
  return yield* HttpServerResponse.json({ events });
});

/** Event stream router */
export const eventStreamRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/streams/:name", appendHandler),
  HttpRouter.get("/streams/:name/events", getEventsHandler),
  HttpRouter.get("/streams/all", subscribeAllHandler), // Must be before :name to avoid "all" being matched
  HttpRouter.get("/streams/:name", subscribeHandler),
  HttpRouter.get("/streams", listHandler),
  HttpRouter.del("/streams/:name", deleteHandler),
);
