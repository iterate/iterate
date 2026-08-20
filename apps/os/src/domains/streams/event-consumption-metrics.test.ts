// Table tests for the host-side self-measured metrics: own-append loop
// correlation, ingest accounting, and the ping-derived clock-offset
// correction. Runner wiring is covered by stream-processor-runner.test.ts;
// browser wiring is covered by the browser store tests.

import { describe, expect, it } from "vitest";
import { EventConsumptionMetrics } from "iterate/processors";

const T0 = 1_700_000_000_000;

describe("EventConsumptionMetrics", () => {
  it("reports nulls and zero counters until something is measured", () => {
    expect(new EventConsumptionMetrics(T0).report()).toEqual({
      measuredSince: new Date(T0).toISOString(),
      consumeOwnAppendMs: null,
      appendRoundTripMs: null,
      deliveryAgeMs: null,
      ingestMs: null,
      batchesIngested: 0,
      eventsIngested: 0,
      clockOffsetMs: null,
    });
  });

  it("closes the consume-own-append loop when the batch carrying the offset is ingested", () => {
    const metrics = new EventConsumptionMetrics(T0);
    metrics.noteAppendCommitted({ maxCommittedOffset: 10, t0: T0, atMs: T0 + 40 });
    expect(metrics.report().appendRoundTripMs).toMatchObject({ last: 40, samples: 1 });
    // Ingest through offset 9: the loop is still open.
    metrics.noteBatchIngested({
      ingestedThroughOffset: 9,
      ingestedOffsets: [7, 8, 9],
      ingestStartedAtMs: T0 + 60,
      atMs: T0 + 65,
    });
    expect(metrics.report().consumeOwnAppendMs).toBeNull();
    // The batch that CARRIES offset 10 closes it: call-start → ingest-done.
    metrics.noteBatchIngested({
      ingestedThroughOffset: 12,
      ingestedOffsets: [10, 12],
      ingestStartedAtMs: T0 + 80,
      atMs: T0 + 90,
    });
    expect(metrics.report().consumeOwnAppendMs).toMatchObject({ last: 90, samples: 1 });
    expect(metrics.report()).toMatchObject({ batchesIngested: 2, eventsIngested: 5 });
    expect(metrics.report().ingestMs).toMatchObject({ last: 10, samples: 2 });
  });

  /*
   * THE MEASUREMENT ARTEFACT THIS RULE EXISTS TO KILL, measured live on a
   * voice facet: `consumeOwnAppendMs` read p50 8.7s / p95 12s while
   * `appendRoundTripMs` read 24ms. Every one of those samples was an append
   * of a type the processor does not consume — a speaker frame — retired by
   * the acknowledgement cursor sweeping past it when the person spoke again.
   * The number was the gap between two sentences.
   */
  it("never times an own append the cursor swept past without delivering it", () => {
    const metrics = new EventConsumptionMetrics(T0);
    metrics.noteAppendCommitted({ maxCommittedOffset: 10, t0: T0, atMs: T0 + 24 });
    // Nine seconds later an unrelated event arrives at a higher offset. The
    // filtered subscription skipped offset 10 durably; it is never coming.
    metrics.noteBatchIngested({
      ingestedThroughOffset: 40,
      ingestedOffsets: [40],
      ingestStartedAtMs: T0 + 9_000,
      atMs: T0 + 9_001,
    });
    expect(metrics.report().consumeOwnAppendMs).toBeNull();
    // …and the dead correlation is gone, so no LATER batch can revive it.
    metrics.noteBatchIngested({
      ingestedThroughOffset: 99,
      ingestedOffsets: [99],
      ingestStartedAtMs: T0 + 20_000,
      atMs: T0 + 20_001,
    });
    expect(metrics.report().consumeOwnAppendMs).toBeNull();
    // The round trip was always honest, and stays reported.
    expect(metrics.report().appendRoundTripMs).toMatchObject({ last: 24, samples: 1 });
  });

  it("does not open a correlation for an append with nothing this host consumes", () => {
    const metrics = new EventConsumptionMetrics(T0);
    metrics.noteAppendCommitted({ maxCommittedOffset: null, t0: T0, atMs: T0 + 24 });
    metrics.noteBatchIngested({
      ingestedThroughOffset: 40,
      ingestedOffsets: [40],
      ingestStartedAtMs: T0 + 9_000,
      atMs: T0 + 9_001,
    });
    expect(metrics.report().consumeOwnAppendMs).toBeNull();
    expect(metrics.report().appendRoundTripMs).toMatchObject({ last: 24, samples: 1 });
  });

  it("one catch-up ingest settles several pending appends; reconnect clears them", () => {
    const metrics = new EventConsumptionMetrics(T0);
    metrics.noteAppendCommitted({ maxCommittedOffset: 5, t0: T0, atMs: T0 + 10 });
    metrics.noteAppendCommitted({ maxCommittedOffset: 8, t0: T0 + 20, atMs: T0 + 30 });
    metrics.noteAppendCommitted({ maxCommittedOffset: 20, t0: T0 + 40, atMs: T0 + 50 });
    metrics.noteBatchIngested({
      ingestedThroughOffset: 10,
      ingestedOffsets: [5, 8, 10],
      ingestStartedAtMs: T0 + 99,
      atMs: T0 + 100,
    });
    // Offsets 5 and 8 settled (100ms and 80ms); offset 20 still pending…
    expect(metrics.report().consumeOwnAppendMs).toMatchObject({ last: 80, samples: 2 });
    // …until the connection drops: stale correlations must not survive a replay.
    metrics.clearPendingAppends();
    metrics.noteBatchIngested({
      ingestedThroughOffset: 25,
      ingestedOffsets: [20, 25],
      ingestStartedAtMs: T0 + 200,
      atMs: T0 + 201,
    });
    expect(metrics.report().consumeOwnAppendMs).toMatchObject({ samples: 2 });
  });

  it("closes the loop immediately when event delivery already passed the offset before append returns", () => {
    const metrics = new EventConsumptionMetrics(T0);
    // The stream fans out post-commit BEFORE answering the appender: this
    // host ingests offset 7 before its own append call returns.
    metrics.noteBatchIngested({
      ingestedThroughOffset: 7,
      ingestedOffsets: [7],
      ingestStartedAtMs: T0 + 20,
      atMs: T0 + 30,
    });
    metrics.noteAppendCommitted({ maxCommittedOffset: 7, t0: T0, atMs: T0 + 45 });
    // Both halves were done at ack time: the sample spans t0 → ack.
    expect(metrics.report().consumeOwnAppendMs).toMatchObject({ last: 45, samples: 1 });
    // Nothing left pending to mis-settle against a later unrelated batch.
    metrics.noteBatchIngested({
      ingestedThroughOffset: 100,
      ingestedOffsets: [100],
      ingestStartedAtMs: T0 + 900,
      atMs: T0 + 901,
    });
    expect(metrics.report().consumeOwnAppendMs).toMatchObject({ samples: 1 });
  });

  it("caps pending own-append correlations, dropping oldest first", () => {
    const metrics = new EventConsumptionMetrics(T0);
    const offsets: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      metrics.noteAppendCommitted({ maxCommittedOffset: index + 1, t0: T0, atMs: T0 + 1 });
      offsets.push(index + 1);
    }
    metrics.noteBatchIngested({
      ingestedThroughOffset: 100,
      ingestedOffsets: offsets,
      ingestStartedAtMs: T0 + 5,
      atMs: T0 + 6,
    });
    // Only the newest 16 survived to settle.
    expect(metrics.report().consumeOwnAppendMs).toMatchObject({ samples: 16 });
  });

  it("corrects delivery age by the ping-derived clock offset", () => {
    const metrics = new EventConsumptionMetrics(T0);
    // Host clock runs 500ms ahead of the stream: stream sent at t0, host saw
    // it 510ms later on its own clock, with a 10ms one-way estimate.
    metrics.notePingObserved({ t0: T0, t1: T0 + 510, oneWayEstimateMs: 10 });
    expect(metrics.report().clockOffsetMs).toBe(500);
    // Event committed at T0 (stream clock), ingested at host T0+600. Raw age
    // would read 600ms; on the stream's clock it is really 100ms.
    metrics.noteBatchIngested({
      ingestedThroughOffset: 1,
      newestEventCreatedAtMs: T0,
      ingestedOffsets: [1],
      ingestStartedAtMs: T0 + 599,
      atMs: T0 + 600,
    });
    expect(metrics.report().deliveryAgeMs).toMatchObject({ last: 100 });
  });

  it("uses the raw age when no ping has been observed (estimate, never fabricate)", () => {
    const metrics = new EventConsumptionMetrics(T0);
    metrics.noteBatchIngested({
      ingestedThroughOffset: 1,
      newestEventCreatedAtMs: T0,
      ingestedOffsets: [1],
      ingestStartedAtMs: T0 + 40,
      atMs: T0 + 50,
    });
    expect(metrics.report().deliveryAgeMs).toMatchObject({ last: 50 });
  });

  it("skips delivery age for batches with no events (state-only deliveries)", () => {
    const metrics = new EventConsumptionMetrics(T0);
    metrics.noteBatchIngested({
      ingestedThroughOffset: 0,
      ingestedOffsets: [],
      ingestStartedAtMs: T0,
      atMs: T0 + 1,
    });
    expect(metrics.report().deliveryAgeMs).toBeNull();
    expect(metrics.report().batchesIngested).toBe(1);
  });
});
