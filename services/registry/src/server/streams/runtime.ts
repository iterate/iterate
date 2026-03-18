import { Layer, ManagedRuntime } from "effect";
import type { RegistryEnv } from "../context.ts";
import { getRegistryDatabase } from "../db/index.ts";
import * as StreamManager from "../../../../events/effect-stream-manager/services/stream-manager/index.ts";
import { sqliteLayer } from "./storage.ts";

export interface RegistryStreamsRuntimeOptions {
  readonly env: Pick<RegistryEnv, "REGISTRY_DB_PATH" | "REGISTRY_STREAMS_WS_IDLE_DISCONNECT_MS">;
}

export interface RegistryStreamsRuntimeResult {
  readonly manager: StreamManager.StreamManager["Type"];
  readonly dispose: () => Promise<void>;
}

export const createRegistryStreamsRuntime = async ({
  env,
}: RegistryStreamsRuntimeOptions): Promise<RegistryStreamsRuntimeResult> => {
  const streamManagerEnv: StreamManager.StreamManagerEnv = {
    ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: env.REGISTRY_STREAMS_WS_IDLE_DISCONNECT_MS,
  };
  const storageLayer = sqliteLayer(getRegistryDatabase(env.REGISTRY_DB_PATH));
  const runtime = ManagedRuntime.make(
    StreamManager.liveLayerWithOptions({ env: streamManagerEnv }).pipe(Layer.provide(storageLayer)),
  );
  const manager = await runtime.runPromise(StreamManager.StreamManager);
  return { manager, dispose: () => runtime.dispose() };
};
