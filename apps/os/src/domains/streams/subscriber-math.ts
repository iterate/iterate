// Pure decision math for the delivery spine (stream-subscribers.ts).
//
// Every function here is a pure function of its arguments — no clocks, no
// randomness (both are parameters), no storage — so the spine's intricate
// bits are table-testable in plain node without fakes.

import type { DeliverPolicy } from "./core-processor-contract.ts";

/**
 * Consecutive failures after which a subscription parks. With the backoff
 * below this tolerates roughly 3.5 hours of continuous receiver outage before
 * giving up loudly (a `subscription-parked` fact + a red row in the UI);
 * `subscription-resumed` is one itx call away.
 */
export const MAX_DELIVERY_ATTEMPTS = 15;

/**
 * Confirmations required before an `onPoison: "skip"` subscription declares a
 * single event poison and steps over it: the same event must fail this many
 * consecutive deliveries after bisection isolated it.
 */
export const SKIP_CONFIRM_ATTEMPTS = 3;

/**
 * Skipped-poison events in a row (no intervening success) after which a
 * skip-mode subscription parks anyway: three consecutive poison verdicts is
 * indistinguishable from "the receiver is down and everything fails", and
 * mass-skipping a down receiver's backlog would be silent data loss.
 */
export const MAX_CONSECUTIVE_SKIPS = 3;

/** Events per delivery batch (also the bisect ceiling). */
export const DELIVERY_BATCH_LIMIT = 100;

/** Soft cap on a delivery frame's payload bytes (large events shrink the batch). */
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
 * A push subscription's initial cursor (exclusive) from its `deliver` policy:
 * `"all"` replays history from offset 0; `"new"` (the default) pins to the
 * configuring event's own offset — deterministic under log replay, no clock;
 * `{ afterOffset }` seeks explicitly.
 */
export function initialCursor(
  deliver: DeliverPolicy | undefined,
  configuredEventOffset: number,
): number {
  if (deliver === undefined || deliver === "new") return configuredEventOffset;
  if (deliver === "all") return 0;
  return deliver.afterOffset;
}

/**
 * Stable delivery id for one batch, unchanged across retries (the svix-id
 * lesson: receivers can dedupe redeliveries without per-event bookkeeping).
 */
export function deliveryId(subscriptionKey: string, firstOffset: number, lastOffset: number) {
  return `${subscriptionKey}:${firstOffset}-${lastOffset}`;
}

/** Next bisect step: halve toward 1, never below. */
export function halveBatchLimit(current: number): number {
  return Math.max(1, Math.floor(current / 2));
}
