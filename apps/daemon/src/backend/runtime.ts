import * as fs from "node:fs";
import * as path from "node:path";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";

import { Storage } from "./event-stream/storage.ts";
import { ActiveFactory } from "./event-stream/stream-factory.ts";
import { StreamManagerService } from "./event-stream/stream-manager.ts";

export const DATA_DIR = ".iterate";

export const STORAGE_DIR = path.join(process.cwd(), DATA_DIR);

fs.mkdirSync(STORAGE_DIR, { recursive: true });

const storageBackend = process.env.DAEMON_STORAGE ?? "fs";

const storageLayer =
  storageBackend === "memory"
    ? Storage.InMemory
    : Storage.FileSystem({ dataDir: STORAGE_DIR }).pipe(Layer.provide(NodeContext.layer));

const streamManagerLayer = StreamManagerService.Live.pipe(
  Layer.provide(ActiveFactory),
  Layer.provide(storageLayer),
);

const mainLayer = Layer.mergeAll(streamManagerLayer, NodeContext.layer);

// Use global storage to survive HMR - ensures adapters and daemon-app share the same runtime
declare global {
  var __daemon_runtime:
    | ManagedRuntime.ManagedRuntime<
        Layer.Layer.Success<typeof mainLayer>,
        Layer.Layer.Error<typeof mainLayer>
      >
    | undefined;
}

export const runtime = globalThis.__daemon_runtime ?? ManagedRuntime.make(mainLayer);
globalThis.__daemon_runtime = runtime;

export const runEffect = <A, E>(effect: Effect.Effect<A, E, StreamManagerService>): Promise<A> =>
  runtime.runPromise(Effect.scoped(effect));

export const runScopedEffect = <A, E>(
  effect: Effect.Effect<A, E, StreamManagerService | Scope.Scope>,
): Promise<A> => runtime.runPromise(Effect.scoped(effect));
