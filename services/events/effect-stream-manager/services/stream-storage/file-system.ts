/**
 * File-system implementation of StreamStorageManager
 *
 * Stores events as YAML documents separated by `---`.
 * Each stream path maps to a file: {basePath}/{streamPath}.yaml
 */
import * as Fs from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import * as YAML from "yaml";

import { Event, Offset, StreamPath } from "../../domain.ts";
import { parsePushSubscriptionPayload } from "../../push-subscriptions.ts";
import { parseStreamMetadataUpdatedPayload } from "../../stream-metadata.ts";
import {
  StreamStorage,
  StreamStorageError,
  StreamStorageManager,
  StreamStorageManagerTypeId,
  type StreamInfo,
} from "./service.ts";

const fallbackNowIso = (): string => new Date().toISOString();

export const fileSystemLayer = (
  basePath: string,
): Layer.Layer<StreamStorageManager, StreamStorageError, Fs.FileSystem | Path.Path> =>
  Layer.effect(
    StreamStorageManager,
    Effect.gen(function* () {
      const fs = yield* Fs.FileSystem;
      const path = yield* Path.Path;

      yield* fs.makeDirectory(basePath, { recursive: true });
      const subscriptions = new Map<
        StreamPath,
        Map<
          string,
          { subscription: ReturnType<typeof parsePushSubscriptionPayload>; offset?: Offset }
        >
      >();

      const getFilePath = (streamPath: StreamPath) =>
        path.join(basePath, `${streamPath.replace(/\//g, "_")}.yaml`);

      const parseEventsFromFile = (content: string) =>
        Effect.gen(function* () {
          const docs = YAML.parseAllDocuments(content).map((doc) => doc.toJS());
          return yield* Effect.all(docs.map((doc) => Schema.decodeUnknown(Event)(doc)));
        });

      const ensurePath = ({ path: streamPath }: { path: StreamPath }) =>
        Effect.gen(function* () {
          const filePath = getFilePath(streamPath);
          const exists = yield* fs.exists(filePath);
          if (exists) return;
          yield* fs.writeFile(filePath, new Uint8Array(0), { flag: "w" });
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause })));

      const append = (event: Event) =>
        Effect.gen(function* () {
          yield* ensurePath({ path: event.path });

          const filePath = getFilePath(event.path);
          const encoded = yield* Schema.encode(Event)(event);
          const yaml = YAML.stringify(encoded);
          const doc = "---\n" + yaml;
          yield* fs.writeFile(filePath, new TextEncoder().encode(doc), { flag: "a" });

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
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause, context: { event } })));

      const read = ({
        path: streamPath,
        from,
        to,
      }: {
        path: StreamPath;
        from?: Offset;
        to?: Offset;
      }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* ensurePath({ path: streamPath });
            const filePath = getFilePath(streamPath);
            const content = yield* fs.readFileString(filePath);
            let events = yield* parseEventsFromFile(content);

            if (from !== undefined) {
              events = events.filter((event) => event.offset > from);
            }
            if (to !== undefined) {
              events = events.filter((event) => event.offset <= to);
            }

            return Stream.fromIterable(events);
          }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
        );

      const forPath = (streamPath: StreamPath): StreamStorage => ({
        read: (options) =>
          read({
            path: streamPath,
            ...(options?.from !== undefined && { from: options.from }),
            ...(options?.to !== undefined && { to: options.to }),
          }).pipe(Stream.catchAllCause(() => Stream.empty)),
        append: (event) => append(event).pipe(Effect.orDie),
        listPushSubscriptions: () =>
          Effect.sync(() => {
            const streamSubscriptions = subscriptions.get(streamPath);
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
            const streamSubscriptions = subscriptions.get(streamPath);
            if (streamSubscriptions === undefined) return;
            const entry = streamSubscriptions.get(subscriptionSlug);
            if (entry === undefined || entry.subscription === undefined) return;
            streamSubscriptions.set(subscriptionSlug, {
              subscription: entry.subscription,
              offset,
            });
          }),
      });

      const listPaths = () =>
        Effect.gen(function* () {
          const entries = yield* fs.readDirectory(basePath);
          const paths: StreamPath[] = [];
          for (const entry of entries) {
            if (entry.endsWith(".yaml") && !entry.endsWith(".offset")) {
              const name = entry.slice(0, -5).replace(/_/g, "/");
              paths.push(StreamPath.make(name));
            }
          }
          return paths;
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause })));

      const listStreams = () =>
        Effect.gen(function* () {
          const paths = yield* listPaths();
          const infos = yield* Effect.all(
            paths.map((streamPath) =>
              Effect.gen(function* () {
                const filePath = getFilePath(streamPath);
                const content = yield* fs.readFileString(filePath);
                const events = yield* parseEventsFromFile(content);
                const lastEvent = events[events.length - 1];
                const metadata = [...events]
                  .reverse()
                  .map((event) => parseStreamMetadataUpdatedPayload(event.payload))
                  .find((payload) => payload !== undefined)?.metadata;

                return {
                  path: streamPath,
                  createdAt:
                    events.length > 0 ? DateTime.formatIso(events[0]!.createdAt) : fallbackNowIso(),
                  eventCount: events.length,
                  lastEventCreatedAt:
                    lastEvent !== undefined
                      ? DateTime.formatIso(lastEvent.createdAt)
                      : fallbackNowIso(),
                  metadata: metadata ?? {},
                } satisfies StreamInfo;
              }).pipe(Effect.orDie),
            ),
            { concurrency: 8 },
          );

          return infos.sort(
            (left, right) =>
              right.lastEventCreatedAt.localeCompare(left.lastEventCreatedAt) ||
              String(left.path).localeCompare(String(right.path)),
          );
        }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause })));

      return StreamStorageManager.of({
        [StreamStorageManagerTypeId]: StreamStorageManagerTypeId,
        listPaths,
        listStreams,
        ensurePath,
        forPath,
        append,
        read,
        listPushSubscriptions: ({ path: streamPath }) =>
          forPath(streamPath).listPushSubscriptions(),
        setPushSubscriptionOffset: ({ path: streamPath, subscriptionSlug, offset }) =>
          forPath(streamPath).setPushSubscriptionOffset({ subscriptionSlug, offset }),
      });
    }).pipe(Effect.mapError((cause) => StreamStorageError.make({ cause }))),
  );
