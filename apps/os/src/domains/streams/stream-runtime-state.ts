import type { StreamThroughputMetrics } from "iterate/processors";
import type { ConnectionRuntimeState, SubscriptionRuntimeState } from "./stream-subscribers.ts";

/** Serializable stream-core and delivery-runtime state exposed through `Stream.liveState`. */
export type StreamRuntimeDebugState = {
  /** Kept opaque at the public stream boundary; consumers may inspect known fields defensively. */
  coreProcessorState: unknown;
  runtime: {
    connections: Record<string, ConnectionRuntimeState>;
    subscriptions: Record<string, SubscriptionRuntimeState>;
    metrics: StreamThroughputMetrics;
    /** SQLite database size in bytes (event log + spine rows + chunks). */
    storageSizeBytes: number;
  };
};
