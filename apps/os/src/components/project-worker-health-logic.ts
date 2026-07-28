import type { StreamEventInput } from "../itx-api.generated.ts";

/**
 * An unhealthy subscription the sidebar warning surfaces, read from the root
 * stream's reduced configuration and runtime cursor. `halted` means delivery
 * gave up and stopped; `backoff` means delivery is failing and retrying.
 *
 * Halted attempts and errors come from the durable
 * `subscription-delivery-halted` fact. Backoff attempts and errors come from
 * the mutable delivery cursor.
 */
export type SubscriptionHealth = {
  subscriptionKey: string;
  status: "halted" | "backoff";
  /** Exclusive delivery cursor: the last offset delivered. The next (stuck)
   * event is `acknowledgedOffset + 1`; the skip verb seeks past it. */
  acknowledgedOffset: number;
  haltedAfterOffset: number | null;
  lag: number;
  attempt: number;
  lastError: string | null;
  canSetCursor: boolean;
};

/** The per-subscription runtime cursor fields this warning reads. */
type SubscriptionRuntimeFacts = {
  acknowledgedOffset: number;
  lag: number;
  attempt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

/** The durable stop fact reduced from `subscription-delivery-halted`. */
type ConfiguredSubscriptionFacts = {
  configuration: {
    receiver: { action: string };
  };
  deliveryHalted?: {
    afterOffset: number;
    attempts: number;
    error?: string;
  };
};

/**
 * The unhealthy subscriptions on a stream: HALTED (a durable event says delivery
 * gave up) or in BACKOFF (the cursor row has a retry time). Healthy subscriptions are
 * omitted. The durable halt fact outranks transient retry state.
 */
export function selectStrugglingSubscriptions(
  args:
    | {
        configured: Record<string, ConfiguredSubscriptionFacts> | undefined;
        runtime: Record<string, SubscriptionRuntimeFacts> | undefined;
      }
    | undefined,
): SubscriptionHealth[] {
  return Object.entries(args?.configured ?? {}).flatMap(([subscriptionKey, configured]) => {
    const runtime = args?.runtime?.[subscriptionKey];
    if (runtime === undefined) return [];
    const status: SubscriptionHealth["status"] | null =
      configured.deliveryHalted !== undefined
        ? "halted"
        : runtime.nextAttemptAt !== null
          ? "backoff"
          : null;
    if (status === null) return [];
    return [
      {
        subscriptionKey,
        status,
        acknowledgedOffset: runtime.acknowledgedOffset,
        haltedAfterOffset: configured.deliveryHalted?.afterOffset ?? null,
        lag: runtime.lag,
        attempt: configured.deliveryHalted?.attempts ?? runtime.attempt,
        lastError: configured.deliveryHalted?.error ?? runtime.lastError,
        canSetCursor: configured.configuration.receiver.action !== "processor-wake",
      },
    ];
  });
}

/**
 * The events to append to unstick a subscription. `resume` clears the halt and kicks
 * delivery (retry from the stopped cursor). `skip` first moves the cursor past
 * the stuck event so it does not just fail on the same one again, then resumes.
 *
 * Delivery reads events STRICTLY after the cursor, so `acknowledgedOffset` is the last
 * delivered offset and the stuck event is `acknowledgedOffset + 1`. Setting the cursor
 * to `acknowledgedOffset + 1` is what actually skips it — setting it to the
 * existing cursor would be a no-op and behave
 * like a plain resume.
 */
export function buildRedriveEvents(
  action: "resume" | "skip",
  subscription: SubscriptionHealth,
): StreamEventInput[] {
  const resumed: StreamEventInput = {
    type: "events.iterate.com/stream/subscription-delivery-resumed",
    payload: { subscriptionKey: subscription.subscriptionKey },
  };
  if (action === "skip") {
    if (!subscription.canSetCursor) {
      throw new Error(
        `subscription "${subscription.subscriptionKey}" owns its cursor at the receiver`,
      );
    }
    return [
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: {
          subscriptionKey: subscription.subscriptionKey,
          afterOffset: subscription.acknowledgedOffset + 1,
        },
      },
      resumed,
    ];
  }
  return [resumed];
}
