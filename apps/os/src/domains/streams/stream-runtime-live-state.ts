import { LiveState } from "iterate/live-state";
import type { StreamThroughputMetrics } from "iterate/processors";
import type { ConnectionRuntimeState, SubscriptionRuntimeState } from "./stream-subscribers.ts";

/** Serializable stream-core and delivery-runtime projection used by debug surfaces. */
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

const RUNTIME_PROJECTION_DEBOUNCE_MS = 100;

/**
 * Mutation-driven runtime projection for one stream Durable Object.
 *
 * Invalidations are coalesced only while somebody observes the LiveState. A
 * dormant projection performs no SQL reads and owns no timer; `refresh()`
 * seeds a fresh first snapshot when a client connects or explicitly reads.
 */
export class StreamRuntimeLiveProjection {
  readonly #readState: () => StreamRuntimeDebugState;
  readonly #debounceMs: number;
  #live: LiveState<StreamRuntimeDebugState> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readState: () => StreamRuntimeDebugState, options: { debounceMs?: number } = {}) {
    this.#readState = readState;
    this.#debounceMs = options.debounceMs ?? RUNTIME_PROJECTION_DEBOUNCE_MS;
  }

  /** Lazily create the engine only when an RPC reader actually asks for it. */
  get live(): LiveState<StreamRuntimeDebugState> {
    return (this.#live ??= new LiveState(this.#readState(), { debounceMs: 0 }));
  }

  /** Mark the projection stale after a runtime mutation. Never polls. */
  invalidate(): void {
    if (this.#live?.observed !== true || this.#refreshTimer !== undefined) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      // The final observer may have disconnected during the debounce window.
      if (this.#live?.observed !== true) return;
      this.#live.setState(this.#readState());
    }, this.#debounceMs);
  }

  /** Synchronously read authoritative state for `get()` and first subscribe. */
  refresh(): void {
    if (this.#refreshTimer !== undefined) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    if (this.#live === undefined) {
      // Creating the initial state is itself the refresh; do not immediately
      // read and set it a second time on the first get/subscribe.
      this.#live = new LiveState(this.#readState(), { debounceMs: 0 });
      return;
    }
    this.#live.setState(this.#readState());
  }

  /** Shape consumed by the DO-side LiveState RPC target's host seam. */
  loadAndRefreshLive(): void {
    this.refresh();
  }
}
