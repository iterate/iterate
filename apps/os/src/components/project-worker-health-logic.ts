import type { StreamEventInput } from "../itx-api.generated.ts";

/**
 * An unhealthy subscription the sidebar warning surfaces, read from the root
 * stream's own runtime state. `parked` = delivery gave up and stopped;
 * `backoff` = delivery is failing and retrying (not stopped yet).
 *
 * `attempt` / `lastError` are only meaningful for `backoff`: parking `ack`s the
 * spine row, which zeroes `attempt` and clears `last_error` (the count and
 * reason survive only in the `subscription-parked` fact, not in runtime state),
 * so the UI must not show them for a parked row.
 */
export type SubscriptionHealth = {
  subscriptionKey: string;
  status: "parked" | "backoff";
  /** Exclusive delivery cursor: the last offset delivered. The next (stuck)
   * event is `ackedOffset + 1`; the skip verb seeks past it. Equals
   * `parkedAtOffset` once parked. */
  ackedOffset: number;
  parkedAtOffset: number | null;
  lag: number;
  attempt: number;
  lastError: string | null;
};

/** The per-subscription runtime shape this warning reads — a subset of the
 * stream's `SubscriptionRuntimeState`. */
type SubscriptionRuntimeFacts = {
  ackedOffset: number;
  parkedAtOffset: number | null;
  lag: number;
  attempt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

/**
 * The unhealthy subscriptions among a stream's runtime subscriptions: PARKED
 * (delivery gave up, `parkedAtOffset` set) or in BACKOFF (delivery failing and
 * a retry scheduled, `nextAttemptAt` set). Healthy subscriptions — caught up or
 * quietly idle — are omitted. Parked outranks backoff.
 */
export function selectStrugglingSubscriptions(
  subscriptions: Record<string, SubscriptionRuntimeFacts> | undefined,
): SubscriptionHealth[] {
  return Object.entries(subscriptions ?? {}).flatMap(([subscriptionKey, subscription]) => {
    const status: SubscriptionHealth["status"] | null =
      subscription.parkedAtOffset !== null
        ? "parked"
        : subscription.nextAttemptAt !== null
          ? "backoff"
          : null;
    if (status === null) return [];
    return [
      {
        subscriptionKey,
        status,
        ackedOffset: subscription.ackedOffset,
        parkedAtOffset: subscription.parkedAtOffset,
        lag: subscription.lag,
        attempt: subscription.attempt,
        lastError: subscription.lastError,
      },
    ];
  });
}

/**
 * The events to append to unstick a subscription. `resume` un-parks and kicks
 * delivery (retry from the stopped cursor). `skip` first moves the cursor past
 * the stuck event so it does not just fail on the same one again, then resumes.
 *
 * Delivery reads events STRICTLY after the cursor, so `ackedOffset` is the last
 * delivered offset and the stuck event is `ackedOffset + 1`. Setting the cursor
 * to `ackedOffset + 1` (`subscription-cursor-set` is exclusive too) is what
 * actually skips it — setting it to `ackedOffset` would be a no-op and behave
 * like a plain resume.
 */
export function buildRedriveEvents(
  action: "resume" | "skip",
  subscription: SubscriptionHealth,
): StreamEventInput[] {
  const resumed: StreamEventInput = {
    type: "events.iterate.com/stream/subscription-resumed",
    payload: { subscriptionKey: subscription.subscriptionKey },
  };
  if (action === "skip") {
    return [
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: {
          subscriptionKey: subscription.subscriptionKey,
          afterOffset: subscription.ackedOffset + 1,
        },
      },
      resumed,
    ];
  }
  return [resumed];
}
