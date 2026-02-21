/**
 * StreamManager - Event streaming with replay support
 */

// Re-export service definition
export { StreamManager } from "./service.ts";

// Re-export EventStream namespace
export * as EventStream from "./event-stream.ts";

// Re-export layers
export { liveLayer, liveLayerWithOptions } from "./live.ts";
export type { StreamManagerEnv, StreamManagerLiveOptions } from "./live.ts";
