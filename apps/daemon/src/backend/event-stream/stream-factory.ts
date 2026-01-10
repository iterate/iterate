/**
 * EventStreamFactory - Service that creates EventStream instances
 */
import { Effect, Layer } from "effect";
import { Storage } from "./storage.ts";
import { type EventStream, makeEventStream } from "./stream.ts";
import type { StorageError, StreamName } from "./types.ts";

/** Factory interface - creates EventStream instances (Storage already provided) */
export class EventStreamFactory extends Effect.Service<EventStreamFactory>()(
  "@event-stream/EventStreamFactory",
  {
    succeed: {
      make: (_opts: { name: StreamName }): Effect.Effect<EventStream, StorageError> =>
        Effect.die("EventStreamFactory.Default not usable - use PlainFactory layer"),
    },
  },
) {
  /** Plain factory - returns base EventStream unchanged */
  static readonly Plain: Layer.Layer<EventStreamFactory, never, Storage> = Layer.effect(
    EventStreamFactory,
    Effect.gen(function* () {
      const storage = yield* Storage;
      return {
        make: (opts: { name: StreamName }) =>
          makeEventStream(opts).pipe(Effect.provideService(Storage, storage)),
      } as EventStreamFactory;
    }),
  );
}

export const PlainFactory = EventStreamFactory.Plain;
export const ActiveFactory = PlainFactory;
