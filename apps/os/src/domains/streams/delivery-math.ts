// Pure retry and batch-size calculations for stream-event-sender.ts.
//
// Every function here is a pure function of its arguments — no clocks, no
// randomness (both are parameters), no storage — so the delivery loop's
// bits are table-testable in plain node without fakes.

import type {
  SubscriptionConfiguredPayload,
  SubscriptionStart,
} from "./core-processor-contract.ts";
import { structuredId } from "./stream-delivery-utils.ts";

/**
 * Consecutive failures after which a subscription halts. With the backoff
 * below this tolerates roughly 2–2.5 hours of continuous receiver outage before
 * giving up loudly (an `subscription-delivery-halted` event + a red row in the
 * UI); `subscription-delivery-resumed` is one itx call away.
 */
export const MAX_DELIVERY_ATTEMPTS = 15;

/**
 * Confirmations required before an `onFailingEvent: "skip"` subscription declares a
 * single event is consistently failing and steps over it: the same event must fail this many
 * consecutive deliveries after bisection isolated it.
 */
export const FAILING_EVENT_CONFIRM_ATTEMPTS = 3;

/**
 * Failing events skipped in a row (no intervening success) after which a
 * skip-mode subscription halts anyway: three consecutive event failures are
 * indistinguishable from "the receiver is down and everything fails", and
 * mass-skipping a down receiver's backlog would be silent data loss.
 */
export const MAX_FAILING_EVENT_SKIPS_SINCE_LAST_SUCCESS = 3;

/**
 * Events per delivery batch (also the bisect ceiling). The byte cap below is
 * the real batch guard; this count cap exists so isolating one failing event has a
 * finite ladder and one send pass stays a bounded read. 1000 small
 * events ≈ 300KB — measured about 10× fewer callback calls and 4× faster browser
 * SQLite ingest than the previous 100 on catch-up-heavy workloads.
 */
export const DELIVERY_BATCH_LIMIT = 1000;

/** Soft cap on a delivery batch's payload bytes (large events shrink the batch). */
export const DELIVERY_BATCH_BYTE_LIMIT = 1024 * 1024;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const BACKOFF_JITTER = 0.2;

/**
 * Exponential backoff with ±20% jitter: 1s, 2s, 4s … capped at 30 minutes.
 * `attempt` is 1-based (the first failure schedules the first retry).
 * `random` is injected (0..1) so tests are deterministic and the jitter that
 * prevents thundering-herd retries into one project worker stays testable.
 */
export function computeBackoffMs(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + BACKOFF_JITTER * (random * 2 - 1);
  return Math.round(base * jitter);
}

/**
 * The initial exclusive cursor for a copy, ITX-call, or webhook subscription.
 */
function initialCursor(start: SubscriptionStart, configuredEventOffset: number): number {
  if (start === "now") return configuredEventOffset;
  if (start === "beginning") return 0;
  return start.afterOffset;
}

/**
 * Stable delivery id for one exact batch window in one cursor epoch. Retrying
 * that window keeps the id; bisecting it or widening it to a newer tail event
 * produces a different id.
 */

/**
 * The one place receiver-specific initial cursor policy is spelled out:
 * hosted-processor rows start at 0 (the stored value means "the processor reported
 * a checkpoint through N", and a processor that has never been woken has observed nothing);
 * copy, ITX-call, and webhook rows start where their delivery policy says.
 */
export function initialCursorFor(
  config: SubscriptionConfiguredPayload,
  configOffset: number,
): number {
  return config.receiver.action === "processor-wake"
    ? 0
    : initialCursor(config.receiver.delivery.start, configOffset);
}

export function deliveryId(
  streamId: string,
  subscriptionKey: string,
  cursorChangedAtSourceOffset: number,
  firstOffset: number,
  lastOffset: number,
) {
  return structuredId(
    "delivery",
    streamId,
    subscriptionKey,
    cursorChangedAtSourceOffset,
    firstOffset,
    lastOffset,
  );
}

/** Next bisect step: halve toward 1, never below. */
export function halveBatchLimit(current: number): number {
  return Math.max(1, Math.floor(current / 2));
}
