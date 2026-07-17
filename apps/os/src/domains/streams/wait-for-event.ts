import type { StreamEvent } from "iterate/processors";
import { isDurableObjectLifecycleError, rethrowStreamUnavailable } from "./stream-unavailable.ts";

/**
 * One bounded wait inside one Stream Durable Object incarnation.
 *
 * `scannedThroughOffset` is the lossless hand-off cursor: the next lease can
 * replay every durable row after it. `replayEphemeralAfterOffset` is the
 * separately pinned opening boundary, so historical ephemerals stay hidden
 * while still-resident ephemerals committed during a lease reset stay visible.
 */
export type StreamEventWaitLeaseInput = {
  afterOffset: number;
  eventTypes?: readonly string[];
  replayEphemeralAfterOffset: number;
  timeoutMs: number;
};

export type StreamEventWaitLeaseResult = {
  events: StreamEvent[];
  scannedThroughOffset: number;
};

const DEFAULT_LEASE_MS = 4_000;
const MAX_CONSECUTIVE_LIFECYCLE_FAILURES = 4;

type WaitForStreamEventArgs = {
  afterOffset?: number;
  eventTypes?: readonly string[];
  predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
  timeoutMs: number;
};

/**
 * Wait for one matching event without trusting a single DO incarnation to
 * stay resident for the caller's whole timeout.
 *
 * A pending JS-RPC promise does not pin a Durable Object: Cloudflare may
 * hibernate it while the promise's timer remains alive, then route subsequent
 * appends to a fresh incarnation. Short leases make that split bounded. Each
 * completed lease returns the raw-log cursor it scanned through; the next
 * incarnation replays from that exact point. Predicate evaluation lives here,
 * outside the DO, so a rejected event advances the cursor once rather than
 * being re-evaluated after every lease.
 */
export async function waitForStreamEvent(input: {
  args: WaitForStreamEventArgs;
  getStartOffset: () => Promise<number>;
  lease: (args: StreamEventWaitLeaseInput) => Promise<StreamEventWaitLeaseResult>;
  /** Test seam only. */
  leaseMs?: number;
  /** Test seam only. */
  now?: () => number;
}): Promise<StreamEvent> {
  const { args } = input;
  if (args.eventTypes === undefined && args.predicate === undefined) {
    throw new Error("waitForEvent requires eventTypes or predicate.");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("waitForEvent timeoutMs must be a positive number.");
  }
  if (
    args.afterOffset !== undefined &&
    (!Number.isSafeInteger(args.afterOffset) || args.afterOffset < 0)
  ) {
    throw new Error("waitForEvent afterOffset must be a non-negative safe integer.");
  }

  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("waitForEvent leaseMs must be a positive number.");
  }

  const now = input.now ?? Date.now;
  const deadline = now() + args.timeoutMs;
  const predicate = args.predicate ?? (() => true);
  const startOffset = await acquireStartOffset({
    deadline,
    getStartOffset: input.getStartOffset,
    now,
    timeoutMs: args.timeoutMs,
  });
  let cursor = args.afterOffset ?? startOffset;
  let consecutiveLifecycleFailures = 0;
  let seenCount = 0;
  const recentTypes: string[] = [];

  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw waitForEventTimeout(args.timeoutMs, seenCount, recentTypes);
    }

    let result: StreamEventWaitLeaseResult;
    try {
      result = await input.lease({
        afterOffset: cursor,
        eventTypes: args.eventTypes,
        // Durable history follows the caller/scan cursor. Ephemerals use the
        // independently pinned opening boundary, so an old caller cursor does
        // not expose historical ephemerals and a reset cannot erase new ones.
        replayEphemeralAfterOffset: startOffset,
        timeoutMs: Math.max(1, Math.min(leaseMs, Math.ceil(remainingMs))),
      });
      consecutiveLifecycleFailures = 0;
    } catch (error) {
      if (!isDurableObjectLifecycleError(error)) throw error;
      consecutiveLifecycleFailures += 1;
      if (consecutiveLifecycleFailures >= MAX_CONSECUTIVE_LIFECYCLE_FAILURES) {
        rethrowStreamUnavailable(error);
      }
      continue;
    }

    for (const event of result.events) {
      // A replay can only repeat an offset if a malformed lease implementation
      // regressed its scanned cursor. Keep predicate side effects exactly-once
      // inside this wait even then.
      if (event.offset <= cursor) continue;
      cursor = event.offset;
      seenCount += 1;
      recentTypes.push(event.type);
      if (recentTypes.length > 20) recentTypes.shift();
      if (await predicate(event)) return event;
    }
    cursor = Math.max(cursor, result.scannedThroughOffset);
  }
}

async function acquireStartOffset(input: {
  deadline: number;
  getStartOffset: () => Promise<number>;
  now: () => number;
  timeoutMs: number;
}): Promise<number> {
  let consecutiveLifecycleFailures = 0;
  while (input.now() < input.deadline) {
    try {
      const offset = await input.getStartOffset();
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("waitForEvent start offset must be a non-negative safe integer.");
      }
      return offset;
    } catch (error) {
      if (!isDurableObjectLifecycleError(error)) throw error;
      consecutiveLifecycleFailures += 1;
      if (consecutiveLifecycleFailures >= MAX_CONSECUTIVE_LIFECYCLE_FAILURES) {
        rethrowStreamUnavailable(error);
      }
    }
  }
  throw waitForEventTimeout(input.timeoutMs, 0, []);
}

function waitForEventTimeout(
  timeoutMs: number,
  seenCount: number,
  recentTypes: readonly string[],
): Error {
  return new Error(
    `Timed out waiting for stream event after ${timeoutMs}ms ` +
      `(saw ${seenCount} events; recent types: ${recentTypes.join(", ") || "none"}).`,
  );
}
