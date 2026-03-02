/**
 * Live implementation of StreamManager
 */
import { Effect, Layer, PubSub, Stream } from "effect";
import { Runtime } from "effect";

import { Event, EventInput, EventType, Offset, StreamPath } from "../../domain.ts";
import { EVENTS_META_STREAM_PATH, STREAM_CREATED_TYPE } from "../../stream-metadata.ts";
import { StreamStorageManager } from "../stream-storage/service.ts";
import * as EventStream from "./event-stream.ts";
import { StreamManager } from "./service.ts";

export interface StreamManagerEnv {
  readonly ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS?: number;
}

export interface StreamManagerLiveOptions {
  readonly env?: StreamManagerEnv;
}

const parseWebsocketIdleDisconnectMs = (env: StreamManagerEnv | undefined): number => {
  const raw = env?.ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS;
  if (raw === undefined) return 30_000;
  if (!Number.isFinite(raw) || raw < 0) return 30_000;
  return Math.floor(raw);
};

// -------------------------------------------------------------------------------------
// StreamManager layer
// -------------------------------------------------------------------------------------

export const liveLayerWithOptions = (
  options: StreamManagerLiveOptions = {},
): Layer.Layer<StreamManager, never, StreamStorageManager> =>
  Layer.effect(
    StreamManager,
    Effect.gen(function* () {
      const storageManager = yield* StreamStorageManager;
      const streams = new Map<StreamPath, EventStream.EventStream>();
      const initializingStreams = new Map<StreamPath, Promise<EventStream.EventStream>>();
      const knownPaths = new Set(
        (yield* storageManager.listPaths().pipe(Effect.orDie)).map((path) => String(path)),
      );
      const websocketIdleDisconnectMs = parseWebsocketIdleDisconnectMs(options.env);
      const runtime = yield* Effect.runtime<never>();
      const runPromise = Runtime.runPromise(runtime);

      // Global PubSub for all events (used for "all paths" subscriptions)
      const globalPubSub = yield* PubSub.unbounded<Event>();

      const getOrInitializeStream = (path: StreamPath): Effect.Effect<EventStream.EventStream> =>
        Effect.gen(function* () {
          const existing = streams.get(path);
          if (existing !== undefined) return existing;

          const initializing = initializingStreams.get(path);
          if (initializing !== undefined) {
            return yield* Effect.promise(() => initializing);
          }

          const initializationPromise = runPromise(
            Effect.gen(function* () {
              const initialized = streams.get(path);
              if (initialized !== undefined) return initialized;

              const storage = storageManager.forPath(path);
              const stream = yield* EventStream.make(storage, path, {
                websocketIdleDisconnectMs,
              });
              streams.set(path, stream);
              return stream;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  initializingStreams.delete(path);
                }),
              ),
            ),
          );

          initializingStreams.set(path, initializationPromise);
          return yield* Effect.promise(() => initializationPromise);
        });

      const getOrCreateStream = (path: StreamPath): Effect.Effect<EventStream.EventStream> =>
        Effect.gen(function* () {
          const pathKey = String(path);
          const shouldEmitStreamCreated = !knownPaths.has(pathKey);
          if (shouldEmitStreamCreated) {
            knownPaths.add(pathKey);
            yield* storageManager.ensurePath({ path }).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  knownPaths.delete(pathKey);
                }),
              ),
              Effect.orDie,
            );
          }

          const stream = yield* getOrInitializeStream(path).pipe(
            Effect.catchAllCause((cause) => {
              if (!shouldEmitStreamCreated) {
                return Effect.failCause(cause);
              }

              return Effect.sync(() => {
                knownPaths.delete(pathKey);
              }).pipe(Effect.flatMap(() => Effect.failCause(cause)));
            }),
          );

          if (shouldEmitStreamCreated && path !== EVENTS_META_STREAM_PATH) {
            yield* Effect.gen(function* () {
              const metaPathKey = String(EVENTS_META_STREAM_PATH);
              if (!knownPaths.has(metaPathKey)) {
                knownPaths.add(metaPathKey);
                yield* storageManager.ensurePath({ path: EVENTS_META_STREAM_PATH }).pipe(
                  Effect.tapError(() =>
                    Effect.sync(() => {
                      knownPaths.delete(metaPathKey);
                    }),
                  ),
                );
              }

              const metaStream = yield* getOrInitializeStream(EVENTS_META_STREAM_PATH);
              const metaEvent = yield* metaStream.append(
                EventInput.make({
                  type: EventType.make(STREAM_CREATED_TYPE),
                  payload: { path: pathKey },
                }),
              );
              yield* PubSub.publish(globalPubSub, metaEvent);
            }).pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() => {
                  knownPaths.delete(pathKey);
                }).pipe(Effect.flatMap(() => Effect.failCause(cause))),
              ),
              Effect.orDie,
            );
          }

          return stream;
        });

      const forPath = (path: StreamPath) => getOrCreateStream(path);
      const listPaths = () => storageManager.listPaths().pipe(Effect.orDie);
      const listStreams = () => storageManager.listStreams().pipe(Effect.orDie);

      const append = Effect.fn("StreamManager.append")(function* ({
        path,
        event,
      }: {
        path: StreamPath;
        event: EventInput;
      }) {
        const stream = yield* getOrCreateStream(path);
        const storedEvent = yield* stream.append(event);

        // Also publish to global PubSub for "all paths" subscribers
        yield* PubSub.publish(globalPubSub, storedEvent);

        return storedEvent;
      });

      const ackOffset = Effect.fn("StreamManager.ackOffset")(function* ({
        path,
        subscriptionSlug,
        offset,
      }: {
        path: StreamPath;
        subscriptionSlug: string;
        offset: Offset;
      }) {
        const stream = yield* getOrCreateStream(path);
        yield* stream.ackOffset({ subscriptionSlug, offset });
      });

      const beSubscribedTo = ({ path, from }: { path?: StreamPath; from?: Offset }) => {
        if (path !== undefined) {
          // Single path subscription
          return Stream.unwrap(
            Effect.gen(function* () {
              const stream = yield* getOrCreateStream(path);
              return stream.subscribe({ ...(from !== undefined && { from }) });
            }).pipe(Effect.withSpan("StreamManager.subscribe")),
          ).pipe(Stream.catchAllCause(() => Stream.empty));
        }

        // All paths subscription - live events only (use read({}) for historical)
        // Use scoped: true to eagerly create the subscription when the stream is unwrapped
        return Stream.unwrapScoped(Stream.fromPubSub(globalPubSub, { scoped: true })).pipe(
          Stream.catchAllCause(() => Stream.empty),
        );
      };

      const read = ({ path, from, to }: { path: StreamPath; from?: Offset; to?: Offset }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const stream = yield* getOrCreateStream(path);
            return stream.read({
              ...(from !== undefined && { from }),
              ...(to !== undefined && { to }),
            });
          }).pipe(Effect.withSpan("StreamManager.read")),
        ).pipe(Stream.catchAllCause(() => Stream.empty));

      return StreamManager.of({
        forPath,
        listPaths,
        listStreams,
        append,
        ackOffset,
        subscribe: beSubscribedTo,
        read,
      });
    }),
  );

export const liveLayer: Layer.Layer<StreamManager, never, StreamStorageManager> =
  liveLayerWithOptions();
