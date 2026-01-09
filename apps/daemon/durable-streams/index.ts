/**
 * Event Streams - Event sourcing primitives with Effect-TS
 *
 * @module event-stream
 */

// Types
export {
  Event,
  EventStreamId,
  InvalidOffsetError,
  isStartOffset,
  makeOffset,
  Offset,
  OFFSET_START,
  parseOffset,
  StorageError,
  StreamName,
  StreamNotFoundError,
} from "./types.ts";
export type {
  EventStreamId as EventStreamIdType,
  Offset as OffsetType,
  StreamName as StreamNameType,
} from "./types.ts";

// Storage (Layer 0)
export { Storage } from "./storage.ts";

// Stream (Layer 1)
export { type EventStream, makeEventStream } from "./stream.ts";

// Hooks (Layer 2)
export {
  type AfterAppendHook,
  type BeforeAppendHook,
  HookError,
  type StreamHooks,
} from "./hooks.ts";
export { type HookedEventStream, withHooks } from "./with-hooks.ts";

// Stream Factory (Layer 3)
export {
  ActiveFactory,
  EmbryonicAgentFactory,
  EventStreamFactory,
  PlainFactory,
  ValidatedFactory,
} from "./stream-factory.ts";

// StreamManager (Layer 4)
export { type StreamManager, StreamManagerService } from "./stream-manager.ts";

// HTTP Routes (Layer 5)
export { eventStreamRouter } from "./http-routes.ts";

// CLI
export { cli, run } from "./cli.ts";
