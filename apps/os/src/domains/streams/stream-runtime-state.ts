import type { StreamThroughputMetrics } from "iterate/processors";
import type { CoreProcessorState } from "./core-processor-contract.ts";
import type { ConnectionRuntimeState, SubscriptionRuntimeState } from "./stream-event-sender.ts";

/** Serializable stream-core and delivery-runtime state exposed through `Stream.liveState`. */
export type StreamRuntimeDebugState = {
  /** Durable stream events reduced by the core processor. */
  coreProcessorState: CoreProcessorState;
  runtime: {
    connections: Record<string, ConnectionRuntimeState>;
    /** Stored subscription progress, keyed by subscription key. */
    subscriptions: Record<string, SubscriptionRuntimeState>;
    metrics: StreamThroughputMetrics;
    /** SQLite database size in bytes (event log + delivery rows + chunks). */
    storageSizeBytes: number;
  };
};
