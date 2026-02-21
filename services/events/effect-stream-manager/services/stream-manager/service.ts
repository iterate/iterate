/**
 * StreamManager service definition
 */
import { Context, Effect, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.ts";
import type { StreamInfo } from "../stream-storage/service.ts";
import { EventStream } from "./event-stream.ts";

// -------------------------------------------------------------------------------------
// StreamManager service
// -------------------------------------------------------------------------------------

export class StreamManager extends Context.Tag("@app/StreamManager")<
  StreamManager,
  {
    /** Get a path-scoped EventStream */
    readonly forPath: (path: StreamPath) => Effect.Effect<EventStream>;

    /** List known stream paths */
    readonly listPaths: () => Effect.Effect<ReadonlyArray<StreamPath>>;

    /** List stream metadata/stats */
    readonly listStreams: () => Effect.Effect<ReadonlyArray<StreamInfo>>;

    /** Subscribe to live events, optionally starting after an offset */
    readonly subscribe: (input: { path?: StreamPath; from?: Offset }) => Stream.Stream<Event>;

    /** Read historical events, optionally within a range */
    readonly read: (input: {
      path: StreamPath;
      from?: Offset;
      to?: Offset;
    }) => Stream.Stream<Event>;

    /** Append an event, returns the stored event with assigned offset */
    readonly append: (input: { path: StreamPath; event: EventInput }) => Effect.Effect<Event>;

    /** Persist/advance acknowledged delivery offset for a push subscription */
    readonly ackOffset: (input: {
      path: StreamPath;
      subscriptionSlug: string;
      offset: Offset;
    }) => Effect.Effect<void>;
  }
>() {}
