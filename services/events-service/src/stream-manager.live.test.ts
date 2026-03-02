import { describe, expect, test } from "vitest";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";

import { EventInput, EventType, StreamPath } from "../effect-stream-manager/domain.ts";
import { liveLayerWithOptions } from "../effect-stream-manager/services/stream-manager/live.ts";
import { StreamManager } from "../effect-stream-manager/services/stream-manager/service.ts";
import { inMemoryLayer } from "../effect-stream-manager/services/stream-storage/in-memory.ts";
import {
  StreamStorageError,
  StreamStorageManager,
} from "../effect-stream-manager/services/stream-storage/service.ts";
import {
  EVENTS_META_STREAM_PATH,
  STREAM_CREATED_TYPE,
} from "../effect-stream-manager/stream-metadata.ts";

const createManagerWithTransientEnsurePathFailure = async (
  failFirstForPaths: ReadonlyArray<string>,
) => {
  const failPathSet = new Set(failFirstForPaths);
  const failedOnce = new Set<string>();

  const flakyStorageLayer = Layer.effect(
    StreamStorageManager,
    Effect.gen(function* () {
      const baseStorage = yield* StreamStorageManager;

      return StreamStorageManager.of({
        ...baseStorage,
        ensurePath: ({ path }) => {
          const pathKey = String(path);
          if (failPathSet.has(pathKey) && !failedOnce.has(pathKey)) {
            failedOnce.add(pathKey);
            return Effect.fail(
              StreamStorageError.make({
                cause: new Error(`transient ensurePath failure for ${pathKey}`),
                context: { path: pathKey },
              }),
            );
          }

          return baseStorage.ensurePath({ path });
        },
      });
    }),
  ).pipe(Layer.provide(inMemoryLayer));

  const runtime = ManagedRuntime.make(
    liveLayerWithOptions().pipe(Layer.provide(flakyStorageLayer)),
  );
  const manager = await runtime.runPromise(StreamManager);

  return {
    manager,
    dispose: () => runtime.dispose(),
  };
};

const createManagerWithBlockedReadDuringInitialization = async (blockedPath: string) => {
  let releaseBlockedRead: (() => void) | undefined;
  const blockedRead = new Promise<void>((resolve) => {
    releaseBlockedRead = resolve;
  });

  const blockingStorageLayer = Layer.effect(
    StreamStorageManager,
    Effect.gen(function* () {
      const baseStorage = yield* StreamStorageManager;

      return StreamStorageManager.of({
        ...baseStorage,
        forPath: (path) => {
          const scopedStorage = baseStorage.forPath(path);
          if (String(path) !== blockedPath) return scopedStorage;

          return {
            ...scopedStorage,
            read: (options) =>
              Stream.unwrap(
                Effect.promise(() =>
                  blockedRead.then(() => Promise.resolve(scopedStorage.read(options))),
                ),
              ),
          };
        },
      });
    }),
  ).pipe(Layer.provide(inMemoryLayer));

  const runtime = ManagedRuntime.make(
    liveLayerWithOptions().pipe(Layer.provide(blockingStorageLayer)),
  );
  const manager = await runtime.runPromise(StreamManager);

  return {
    manager,
    releaseBlockedRead: () => releaseBlockedRead?.(),
    dispose: () => runtime.dispose(),
  };
};

const appendTestEvent = (manager: StreamManager["Type"], path: StreamPath) =>
  Effect.runPromise(
    manager.append({
      path,
      event: EventInput.make({
        type: EventType.make(
          "https://events.iterate.com/events/test/retry-after-ensure-path-failure",
        ),
        payload: { ok: true },
      }),
    }),
  );

const readMetaEvents = (manager: StreamManager["Type"]) =>
  Effect.runPromise(Stream.runCollect(manager.read({ path: EVENTS_META_STREAM_PATH }))).then(
    (events) => Array.from(events),
  );

describe("StreamManager live layer edge cases", () => {
  test("initializing one path does not block appends on a different path", async () => {
    const blockedPath = StreamPath.make("init/blocked");
    const fastPath = StreamPath.make("init/fast");
    const { manager, releaseBlockedRead, dispose } =
      await createManagerWithBlockedReadDuringInitialization(String(blockedPath));

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    try {
      const slowAppend = appendTestEvent(manager, blockedPath);
      await sleep(20);

      let fastDone = false;
      const fastAppend = appendTestEvent(manager, fastPath).then(() => {
        fastDone = true;
      });

      await sleep(80);
      expect(fastDone).toBe(true);

      releaseBlockedRead();
      await Promise.allSettled([slowAppend, fastAppend]);
    } finally {
      releaseBlockedRead();
      await dispose();
    }
  });

  test("retries still emit stream-created after transient ensurePath failure on target stream", async () => {
    const targetPath = StreamPath.make("retry/target-path");
    const { manager, dispose } = await createManagerWithTransientEnsurePathFailure([
      String(targetPath),
    ]);

    try {
      await expect(appendTestEvent(manager, targetPath)).rejects.toBeDefined();
      await appendTestEvent(manager, targetPath);

      const metaEvents = await readMetaEvents(manager);
      expect(metaEvents.length).toBe(1);
      expect(String(metaEvents[0]?.type)).toBe(STREAM_CREATED_TYPE);
      expect((metaEvents[0]?.payload as Record<string, unknown>)["path"]).toBe(String(targetPath));
    } finally {
      await dispose();
    }
  });

  test("retries still emit stream-created after transient ensurePath failure on meta stream", async () => {
    const targetPath = StreamPath.make("retry/meta-path");
    const { manager, dispose } = await createManagerWithTransientEnsurePathFailure([
      String(EVENTS_META_STREAM_PATH),
    ]);

    try {
      await expect(appendTestEvent(manager, targetPath)).rejects.toBeDefined();
      await appendTestEvent(manager, targetPath);

      const metaEvents = await readMetaEvents(manager);
      expect(metaEvents.length).toBe(1);
      expect(String(metaEvents[0]?.type)).toBe(STREAM_CREATED_TYPE);
      expect((metaEvents[0]?.payload as Record<string, unknown>)["path"]).toBe(String(targetPath));
    } finally {
      await dispose();
    }
  });
});
