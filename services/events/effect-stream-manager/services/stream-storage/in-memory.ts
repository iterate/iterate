/**
 * In-memory implementation of StreamStorageManager
 */
import { DateTime, Effect, Layer, Stream } from "effect";

import { Event, Offset, StreamPath } from "../../domain.ts";
import { parsePushSubscriptionPayload } from "../../push-subscriptions.ts";
import { parseStreamMetadataUpdatedPayload } from "../../stream-metadata.ts";
import {
  StreamStorage,
  StreamStorageManager,
  StreamStorageManagerTypeId,
  type StreamInfo,
} from "./service.ts";

interface InMemoryStreamState {
  readonly events: Event[];
  createdAt: string;
  metadata: Record<string, unknown>;
}

export const inMemoryLayer: Layer.Layer<StreamStorageManager> = Layer.sync(
  StreamStorageManager,
  () => {
    const streams = new Map<StreamPath, InMemoryStreamState>();
    const subscriptions = new Map<
      StreamPath,
      Map<
        string,
        { subscription: ReturnType<typeof parsePushSubscriptionPayload>; offset?: Offset }
      >
    >();

    const getOrCreateStream = (path: StreamPath): InMemoryStreamState => {
      let stream = streams.get(path);
      if (stream !== undefined) return stream;

      stream = {
        events: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      };
      streams.set(path, stream);
      return stream;
    };

    const append = (event: Event) =>
      Effect.sync(() => {
        const stream = getOrCreateStream(event.path);
        stream.events.push(event);

        const metadataPayload = parseStreamMetadataUpdatedPayload(event.payload);
        if (metadataPayload !== undefined) {
          stream.metadata = metadataPayload.metadata;
        }

        const payload = parsePushSubscriptionPayload(event.payload);
        if (payload !== undefined) {
          let streamSubscriptions = subscriptions.get(event.path);
          if (streamSubscriptions === undefined) {
            streamSubscriptions = new Map();
            subscriptions.set(event.path, streamSubscriptions);
          }

          const existing = streamSubscriptions.get(payload.subscriptionSlug);
          streamSubscriptions.set(payload.subscriptionSlug, {
            subscription: payload,
            ...(existing?.offset !== undefined ? { offset: existing.offset } : {}),
          });
        }

        return event;
      });

    const read = ({ path, from, to }: { path: StreamPath; from?: Offset; to?: Offset }) =>
      Stream.suspend(() => {
        const stream = getOrCreateStream(path);
        let events = stream.events;
        if (from !== undefined) {
          events = events.filter((event) => event.offset > from);
        }
        if (to !== undefined) {
          events = events.filter((event) => event.offset <= to);
        }
        return Stream.fromIterable(events);
      });

    const forPath = (path: StreamPath): StreamStorage => ({
      read: (options) =>
        read({
          path,
          ...(options?.from !== undefined && { from: options.from }),
          ...(options?.to !== undefined && { to: options.to }),
        }).pipe(Stream.catchAllCause(() => Stream.empty)),
      append: (event) => append(event).pipe(Effect.orDie),
      listPushSubscriptions: () =>
        Effect.sync(() => {
          const streamSubscriptions = subscriptions.get(path);
          if (streamSubscriptions === undefined) return [];

          return Array.from(streamSubscriptions.values()).flatMap((entry) =>
            entry.subscription === undefined
              ? []
              : [
                  {
                    subscription: entry.subscription,
                    ...(entry.offset !== undefined ? { lastDeliveredOffset: entry.offset } : {}),
                  },
                ],
          );
        }),
      setPushSubscriptionOffset: ({ subscriptionSlug, offset }) =>
        Effect.sync(() => {
          const streamSubscriptions = subscriptions.get(path);
          if (streamSubscriptions === undefined) return;
          const entry = streamSubscriptions.get(subscriptionSlug);
          if (entry === undefined || entry.subscription === undefined) return;
          streamSubscriptions.set(subscriptionSlug, {
            subscription: entry.subscription,
            offset,
          });
        }),
    });

    const toStreamInfo = (path: StreamPath, stream: InMemoryStreamState): StreamInfo => {
      const lastEventCreatedAt =
        stream.events.length > 0
          ? DateTime.formatIso(stream.events[stream.events.length - 1]!.createdAt)
          : stream.createdAt;

      return {
        path,
        createdAt: stream.createdAt,
        eventCount: stream.events.length,
        lastEventCreatedAt,
        metadata: { ...stream.metadata },
      };
    };

    return StreamStorageManager.of({
      [StreamStorageManagerTypeId]: StreamStorageManagerTypeId,
      listPaths: () => Effect.succeed(Array.from(streams.keys())),
      listStreams: () =>
        Effect.sync(() =>
          Array.from(streams.entries())
            .map(([path, stream]) => toStreamInfo(path, stream))
            .sort(
              (left, right) =>
                right.lastEventCreatedAt.localeCompare(left.lastEventCreatedAt) ||
                String(left.path).localeCompare(String(right.path)),
            ),
        ),
      ensurePath: ({ path }) =>
        Effect.sync(() => {
          getOrCreateStream(path);
        }),
      forPath,
      append,
      read,
      listPushSubscriptions: ({ path }) => forPath(path).listPushSubscriptions(),
      setPushSubscriptionOffset: ({ path, subscriptionSlug, offset }) =>
        forPath(path).setPushSubscriptionOffset({ subscriptionSlug, offset }),
    });
  },
);
