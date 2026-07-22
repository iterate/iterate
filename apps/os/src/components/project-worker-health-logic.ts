import type { StreamEventInput } from "../itx-api.generated.ts";

/**
 * An unhealthy subscription the sidebar warning surfaces, read from the root
 * stream's own runtime state. `parked` = delivery gave up and stopped;
 * `backoff` = delivery is failing and retrying (not stopped yet). Only the
 * fields the UI shows — the full row lives in the stream's `runtimeState()`.
 */
export type SubscriptionHealth = {
  subscriptionKey: string;
  status: "parked" | "backoff";
  /** Exclusive cursor: the offset delivery is stuck on (equals `parkedAtOffset`
   * once parked). The skip verb seeks past this. */
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
 * the offset it choked on (exclusive `afterOffset`) so it does not just fail on
 * the same poison again, then resumes.
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
          afterOffset: subscription.ackedOffset,
        },
      },
      resumed,
    ];
  }
  return [resumed];
}
