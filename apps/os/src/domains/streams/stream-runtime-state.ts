import type { StreamThroughputMetrics } from "iterate/processors";
import type { CoreProcessorState } from "./core-processor-contract.ts";
import type { ConnectionRuntimeState } from "./stream-connections.ts";
import type { SubscriptionRuntimeState } from "./stream-event-sender.ts";
import type { CrossPostListRetryRow } from "./cross-post-list-retry-store.ts";

/** Serializable stream-core and delivery-runtime state exposed through `Stream.liveState`. */
export type StreamRuntimeDebugState = {
  /** Durable stream events reduced by the core processor. */
  coreProcessorState: CoreProcessorState;
  runtime: {
    connections: Record<string, ConnectionRuntimeState>;
    /** Stored subscription progress, keyed by subscription key. */
    subscriptions: Record<string, SubscriptionRuntimeState>;
    /** Retry progress keyed by receiving stream path. */
    crossPostListRetries: Record<string, CrossPostListRetryRow>;
    metrics: StreamThroughputMetrics;
    /** SQLite database size in bytes (event log + delivery rows + chunks). */
    storageSizeBytes: number;
  };
};
