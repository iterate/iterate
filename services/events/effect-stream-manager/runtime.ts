import { Layer, ManagedRuntime } from "effect";
import type { EventsServiceEnv } from "@iterate-com/services-contracts/events";

import * as StreamManager from "./services/stream-manager/index.ts";
import * as StreamStorage from "./services/stream-storage/index.ts";
import { resolveSqliteFilenameFromEnv } from "./services/stream-storage/storage-path.ts";

export interface EffectEventStreamManagerOptions {
  readonly env: Pick<EventsServiceEnv, "DATABASE_URL" | "ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS">;
}

export interface EffectEventStreamManagerResult {
  readonly manager: StreamManager.StreamManager["Type"];
  readonly dispose: () => Promise<void>;
}

export const effectEventStreamManager = async ({
  env,
}: EffectEventStreamManagerOptions): Promise<EffectEventStreamManagerResult> => {
  const streamManagerEnv: StreamManager.StreamManagerEnv = {
    ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: env.ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS,
  };
  const storageLayer = StreamStorage.sqliteLayer(
    resolveSqliteFilenameFromEnv({ DATABASE_URL: env.DATABASE_URL }),
  );
  const runtime = ManagedRuntime.make(
    StreamManager.liveLayerWithOptions({ env: streamManagerEnv }).pipe(Layer.provide(storageLayer)),
  );
  const manager = await runtime.runPromise(StreamManager.StreamManager);
  return { manager, dispose: () => runtime.dispose() };
};
