import type { StreamEventInput } from "../itx-api.generated.ts";

/**
 * A stopped-or-struggling subscription the sidebar warning surfaces, read
 * from the root stream's reduced configuration and runtime cursor row. The
 * two states are distinct on purpose:
 *
 * - `halted` — delivery gave up (durable `subscription-delivery-halted` fact
 *   after the retry ladder burned out);
 * - `backoff` — delivery is failing and retrying; not stopped yet.
 *
 * Halted attempts and errors come from the durable halt fact. Backoff
 * attempts and errors come from the mutable cursor row.
 */
export type SubscriptionHealth = {
  name: string;
  status: "halted" | "backoff";
  /** Exclusive confirmed cursor: the receiver durably claims through here.
   * The next (stuck) event is `confirmedOffset + 1`; the skip verb seeks past it. */
  confirmedOffset: number;
  haltedAfterOffset: number | null;
  /** head − confirmed. */
  lag: number;
  attempt: number;
  lastError: string | null;
  /** When lastError was recorded (ISO); null = unknown age (rows written
   * before the column existed, or a durable halt fact without one). */
  lastErrorAt: string | null;
  canSetCursor: boolean;
};

/** The per-subscription cursor-row fields this warning reads. */
type SubscriptionRuntimeFacts = {
  confirmedOffset: number;
  lag: number;
  attempt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

/** The durable stop facts reduced from halt events. */
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
 * The subscriptions on a stream that are not delivering normally: HALTED (a
 * durable event says delivery gave up) or in BACKOFF (the cursor row has a
 * retry time). Healthy subscriptions are omitted. Durable facts outrank
 * transient retry state.
 */
export function selectStrugglingSubscriptions(
  args:
    | {
        configured: Record<string, ConfiguredSubscriptionFacts> | undefined;
        runtime: Record<string, SubscriptionRuntimeFacts> | undefined;
      }
    | undefined,
): SubscriptionHealth[] {
  return Object.entries(args?.configured ?? {}).flatMap(([name, configured]) => {
    const runtime = args?.runtime?.[name];
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
        name,
        status,
        confirmedOffset: runtime.confirmedOffset,
        haltedAfterOffset: configured.deliveryHalted?.afterOffset ?? null,
        lag: runtime.lag,
        attempt: configured.deliveryHalted?.attempts ?? runtime.attempt,
        lastError: configured.deliveryHalted?.error ?? runtime.lastError,
        // The halt fact carries no timestamp; the cursor row's is close
        // enough (the halting failure was its last write).
        lastErrorAt: runtime.lastErrorAt,
        canSetCursor:
          configured.configuration.receiver.action !== "facet-processor" &&
          configured.configuration.receiver.action !== "wake-processor",
      },
    ];
  });
}

/** A standing default-worker build failure, as the sidebar warning renders it. */
export type WorkerBuildFailureFact = {
  at: string;
  commitOid: string;
  error: string;
};

/**
 * The standing build failure from the project's reduced `worker` slot, or
 * null while the newest outcome is a successful update — the slot holds only
 * the latest outcome, so a later `project/worker-updated` supersedes a
 * recorded failure and clears the warning.
 */
export function selectWorkerBuildFailure(
  worker:
    | {
        at: string;
        commitOid: string;
        error: string | null;
        status: "updated" | "update-failed";
      }
    | null
    | undefined,
): WorkerBuildFailureFact | null {
  if (!worker || worker.status !== "update-failed") return null;
  return {
    at: worker.at,
    commitOid: worker.commitOid,
    error: worker.error || "The project worker build failed.",
  };
}

/**
 * The events to append to unstick a subscription. `resume` clears the halt
 * (`subscription-delivery-resumed`) and kicks delivery from the existing
 * cursor. `skip` first moves the cursor past the stuck event so it does not
 * just fail on the same one again, then resumes.
 *
 * Delivery resumes STRICTLY after the confirmed cursor, so `confirmedOffset`
 * is the last claimed offset and the stuck event is `confirmedOffset + 1`.
 * Setting the cursor to `confirmedOffset + 1` is what actually skips it —
 * setting it to the existing cursor would be a no-op and behave like a plain
 * resume.
 */
export function buildRedriveEvents(
  action: "resume" | "skip",
  subscription: SubscriptionHealth,
): StreamEventInput[] {
  const resumed: StreamEventInput = {
    type: "events.iterate.com/stream/subscription-delivery-resumed",
    payload: { name: subscription.name },
  };
  if (action === "skip") {
    if (!subscription.canSetCursor) {
      throw new Error(`subscription "${subscription.name}" owns its cursor at the receiver`);
    }
    return [
      {
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: {
          name: subscription.name,
          afterOffset: subscription.confirmedOffset + 1,
        },
      },
      resumed,
    ];
  }
  return [resumed];
}
