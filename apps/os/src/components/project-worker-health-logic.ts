import type { StreamEventInput } from "../itx-api.generated.ts";

/**
 * The parked-subscription facts the sidebar warning reads from the root
 * stream's own runtime state. Only the fields the UI shows — the full row
 * lives in the stream's `runtimeState()`.
 */
export type ParkedSubscription = {
  subscriptionKey: string;
  parkedAtOffset: number | null;
  lag: number;
  attempt: number;
  lastError: string | null;
};

/** The per-subscription runtime shape this warning reads — a subset of the
 * stream's `SubscriptionRuntimeState`. */
type SubscriptionRuntimeFacts = {
  parkedAtOffset: number | null;
  lag: number;
  attempt: number;
  lastError: string | null;
};

/** The parked subscriptions among a stream's runtime subscriptions — the ones
 * whose delivery gave up (`parkedAtOffset` set). */
export function selectParkedSubscriptions(
  subscriptions: Record<string, SubscriptionRuntimeFacts> | undefined,
): ParkedSubscription[] {
  return Object.entries(subscriptions ?? {})
    .filter(([, subscription]) => subscription.parkedAtOffset !== null)
    .map(([subscriptionKey, subscription]) => ({
      subscriptionKey,
      parkedAtOffset: subscription.parkedAtOffset,
      lag: subscription.lag,
      attempt: subscription.attempt,
      lastError: subscription.lastError,
    }));
}

/**
 * The events to append to unstick a parked subscription. `resume` retries from
 * where delivery stopped; `skip` first moves the cursor past the offset it
 * choked on (exclusive `afterOffset`) so it does not just re-park on the same
 * poison, then resumes. A `skip` with no known offset falls back to `resume`.
 */
export function buildRedriveEvents(
  action: "resume" | "skip",
  subscription: ParkedSubscription,
): StreamEventInput[] {
  const resumed: StreamEventInput = {
    type: "events.iterate.com/stream/subscription-resumed",
    payload: { subscriptionKey: subscription.subscriptionKey },
  };
  if (action === "skip" && subscription.parkedAtOffset !== null) {
    return [
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: {
          subscriptionKey: subscription.subscriptionKey,
          afterOffset: subscription.parkedAtOffset,
        },
      },
      resumed,
    ];
  }
  return [resumed];
}
