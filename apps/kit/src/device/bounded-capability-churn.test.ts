import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assessBoundedCapabilityChurn,
  BoundedCapabilityChurn,
} from "./bounded-capability-churn.ts";

describe("bounded capability churn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("skips elapsed periods instead of queueing control work behind a slow call", async () => {
    /*
     * A load rig that queues one promise per timer tick can manufacture the
     * exact stale backlog the audio design is meant to prevent. Holding the
     * first operation across three periods must therefore retain only one
     * in-flight call and classify every later tick as skipped/busy.
     */
    const first = Promise.withResolvers<void>();
    const operation = vi.fn(() => first.promise);
    const churn = new BoundedCapabilityChurn({
      cyclesPerSecond: 20,
      operation,
      operationTimeoutMs: 1_000,
    });

    churn.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(operation).toHaveBeenCalledTimes(1);

    const stopping = churn.stop();
    first.resolve();
    const summary = await stopping;

    expect(summary).toMatchObject({
      completedCycles: 1,
      failedCycles: 0,
      scheduledCycles: 4,
      skippedBusyCycles: 3,
      startedCycles: 1,
    });
  });

  test("times out a stuck operation and stops scheduling more work", async () => {
    /*
     * “At most one in flight” is not a bound if that one RPC can live forever.
     * The timeout releases the harness while the eventual Cap'n Web session
     * teardown owns cancellation of the underlying transport operation.
     */
    const failures: Error[] = [];
    const operation = vi.fn(() => new Promise<void>(() => {}));
    const churn = new BoundedCapabilityChurn({
      cyclesPerSecond: 20,
      onFailure: (error) => failures.push(error),
      operation,
      operationTimeoutMs: 120,
    });

    churn.start();
    await vi.advanceTimersByTimeAsync(500);
    const summary = await churn.stop();

    expect(operation).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("120ms");
    expect(summary).toMatchObject({
      completedCycles: 0,
      failedCycles: 1,
      scheduledCycles: 3,
      skippedBusyCycles: 2,
      startedCycles: 1,
    });
  });

  test("reports a healthy applied load only when nearly every scheduled cycle completed", async () => {
    const churn = new BoundedCapabilityChurn({
      cyclesPerSecond: 20,
      operation: async () => {},
      operationTimeoutMs: 1_000,
    });

    churn.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await churn.stop();

    expect(summary.completedCycles).toBeGreaterThanOrEqual(20);
    expect(assessBoundedCapabilityChurn(summary, 0.9)).toEqual({
      kind: "healthy",
    });
    expect(
      assessBoundedCapabilityChurn(
        {
          ...summary,
          completedCycles: 8,
          skippedBusyCycles: summary.scheduledCycles - 8,
          startedCycles: 8,
        },
        0.9,
      ),
    ).toMatchObject({
      kind: "failure",
    });
  });
});
