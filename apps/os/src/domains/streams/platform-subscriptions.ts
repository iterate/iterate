import type { SubscriptionConfiguredPayload } from "./core-processor-contract.ts";

/**
 * Keep platform-owned push receivers off the Stream Durable Object invocation
 * that commits an append. The in-memory timer is the low-latency path and the
 * persisted alarm is the crash-safe path; later appends join the fixed window.
 */
export const PLATFORM_PUSH_DELIVERY_BATCH_WINDOW_MS = 250;

/** The userspace project worker feed born with every project stream. */
export function projectWorkerSubscriptionEvent() {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: "project-worker",
      delivery: {
        mode: "push",
        expression: ["processEventBatch"],
        batchWindowMs: PLATFORM_PUSH_DELIVERY_BATCH_WINDOW_MS,
      },
      // Everything, from the beginning: the worker sees the stream's full
      // history once it first builds. No default selector — selection is the
      // worker's own code (or a same-key override).
      deliver: "all",
      // One poison event must not silence a project's entire feed.
      onPoison: "skip",
    } satisfies SubscriptionConfiguredPayload,
  };
}

/** The platform-owned search projection born with every project stream. */
export function searchIndexSubscriptionEvent() {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: "platform-search-index",
      delivery: {
        mode: "push",
        expression: ["indexStreamSearchBatch"],
        // A conversation turn appends several adjacent lifecycle facts.
        // Coalesce them into one segment rewrite.
        batchWindowMs: PLATFORM_PUSH_DELIVERY_BATCH_WINDOW_MS,
      },
      // Rebuild every segment from authoritative history when production is
      // recreated for this breaking birth-certificate shape.
      deliver: "all",
      // A derived write failure is an outage, never poison source data. The
      // durable spine retries and parks loudly instead of skipping it.
      onPoison: "park",
    } satisfies SubscriptionConfiguredPayload,
  };
}
