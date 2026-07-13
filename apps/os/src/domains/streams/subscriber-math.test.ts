// Table tests for the delivery spine's pure decision math. Every export of
// subscriber-math.ts is covered here; the spine's stateful behavior on top of
// these functions is exercised in stream-subscribers.test.ts.

import { describe, expect, it, test } from "vitest";
import type { DeliverPolicy } from "./core-processor-contract.ts";
import {
  computeBackoffMs,
  DELIVERY_BATCH_BYTE_LIMIT,
  DELIVERY_BATCH_LIMIT,
  deliveryId,
  halveBatchLimit,
  initialCursor,
  MAX_CONSECUTIVE_SKIPS,
  MAX_DELIVERY_ATTEMPTS,
  PUSH_DELIVERY_BATCH_BYTE_LIMIT,
  PUSH_DELIVERY_BATCH_LIMIT,
  SKIP_CONFIRM_ATTEMPTS,
} from "./subscriber-math.ts";

describe("tuning constants", () => {
  it("documents the spine's tuning numbers", () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(15);
    expect(SKIP_CONFIRM_ATTEMPTS).toBe(3);
    expect(MAX_CONSECUTIVE_SKIPS).toBe(3);
    expect(DELIVERY_BATCH_LIMIT).toBe(1000);
    expect(DELIVERY_BATCH_BYTE_LIMIT).toBe(1024 * 1024);
    expect(PUSH_DELIVERY_BATCH_BYTE_LIMIT).toBe(4 * 1024 * 1024);
    expect(PUSH_DELIVERY_BATCH_LIMIT).toBe(8000);
  });
});

describe("computeBackoffMs", () => {
  test.for([
    // random = 0.5 zeroes the jitter term, so these are the exact 1s·2^(n-1) bases.
    { attempt: 1, random: 0.5, expected: 1_000 },
    { attempt: 2, random: 0.5, expected: 2_000 },
    { attempt: 3, random: 0.5, expected: 4_000 },
    { attempt: 6, random: 0.5, expected: 32_000 },
    { attempt: 11, random: 0.5, expected: 1_024_000 },
    // The base caps at 30 minutes and stays there.
    { attempt: 12, random: 0.5, expected: 1_800_000 },
    { attempt: 50, random: 0.5, expected: 1_800_000 },
    // random = 0 is the -20% jitter edge, random = 1 the +20% edge.
    { attempt: 1, random: 0, expected: 800 },
    { attempt: 1, random: 1, expected: 1_200 },
    { attempt: 2, random: 0, expected: 1_600 },
    { attempt: 2, random: 1, expected: 2_400 },
    // Jitter applies AFTER the cap, so the +20% edge can exceed 30 minutes.
    { attempt: 12, random: 0, expected: 1_440_000 },
    { attempt: 12, random: 1, expected: 2_160_000 },
    // Attempts are 1-based; the exponent clamps at 0 for out-of-range input.
    { attempt: 0, random: 0.5, expected: 1_000 },
  ])("attempt $attempt, random $random -> $expected ms", ({ attempt, random, expected }) => {
    expect(computeBackoffMs(attempt, random)).toBe(expected);
  });
});

describe("initialCursor", () => {
  test.for([
    { name: "undefined defaults to new", deliver: undefined, expected: 42 },
    { name: '"new" pins to the configuring event offset', deliver: "new", expected: 42 },
    { name: '"all" replays history from 0', deliver: "all", expected: 0 },
    { name: "explicit afterOffset seeks", deliver: { afterOffset: 7 }, expected: 7 },
    { name: "afterOffset 0 is a full replay", deliver: { afterOffset: 0 }, expected: 0 },
  ] satisfies { name: string; deliver: DeliverPolicy | undefined; expected: number }[])(
    "$name",
    ({ deliver, expected }) => {
      expect(initialCursor(deliver, 42)).toBe(expected);
    },
  );
});

describe("deliveryId", () => {
  test.for([
    { subscriptionKey: "k", firstOffset: 1, lastOffset: 3, expected: "k:1-3" },
    { subscriptionKey: "k", firstOffset: 4, lastOffset: 4, expected: "k:4-4" },
    {
      subscriptionKey: "cross-post:/a->/b",
      firstOffset: 10,
      lastOffset: 20,
      expected: "cross-post:/a->/b:10-20",
    },
  ])("$subscriptionKey $firstOffset-$lastOffset -> $expected", (args) => {
    expect(deliveryId(args.subscriptionKey, args.firstOffset, args.lastOffset)).toBe(args.expected);
  });

  it("is stable across retries of the same batch", () => {
    expect(deliveryId("k", 1, 3)).toBe(deliveryId("k", 1, 3));
  });
});

describe("halveBatchLimit", () => {
  test.for([
    { current: 100, expected: 50 },
    { current: 50, expected: 25 },
    { current: 25, expected: 12 },
    { current: 12, expected: 6 },
    { current: 6, expected: 3 },
    { current: 3, expected: 1 },
    { current: 2, expected: 1 },
    { current: 1, expected: 1 },
  ])("$current -> $expected", ({ current, expected }) => {
    expect(halveBatchLimit(current)).toBe(expected);
  });

  it("walks the full bisect ladder from DELIVERY_BATCH_LIMIT down to 1 and stays there", () => {
    const steps: number[] = [];
    let limit = DELIVERY_BATCH_LIMIT;
    while (steps.length < 13) {
      limit = halveBatchLimit(limit);
      steps.push(limit);
    }
    expect(steps).toEqual([500, 250, 125, 62, 31, 15, 7, 3, 1, 1, 1, 1, 1]);
  });
});
