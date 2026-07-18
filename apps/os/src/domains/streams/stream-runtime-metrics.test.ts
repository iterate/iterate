// Table tests for the pure metrics primitives: the latency ring, the rolling
// minute buckets, and the mutual-ping NTP math. The spine/host wiring on top
// is exercised in stream-subscribers.test.ts and subscriber-metrics.test.ts.

import { describe, expect, it, test } from "vitest";
import {
  LatencyRing,
  MinuteBuckets,
  pingRoundTrip,
  StreamRuntimeMetrics,
} from "iterate/processors";

describe("LatencyRing", () => {
  it("reports null until the first sample — surfaces render a dash, never a number", () => {
    expect(new LatencyRing().stats()).toBeNull();
  });

  it("tracks last/lastAt and nearest-rank percentiles over recorded samples", () => {
    const ring = new LatencyRing();
    for (const [index, ms] of [10, 20, 30, 40].entries()) ring.record(ms, 1_000 + index);
    // Nearest-rank: p95 over few samples reports the WORST candidate — a
    // small dashboard ring must not hide its spike.
    expect(ring.stats()).toEqual({ last: 40, p50: 20, p95: 40, samples: 4, lastAt: 1_003 });
  });

  it("p95 reports the slower sample even with only two samples", () => {
    const ring = new LatencyRing();
    ring.record(10, 1);
    ring.record(500, 2);
    expect(ring.stats()).toMatchObject({ p50: 10, p95: 500 });
  });

  it("evicts oldest samples past capacity", () => {
    const ring = new LatencyRing(4);
    for (const ms of [1000, 1000, 1000, 1000]) ring.record(ms, 0);
    for (const ms of [10, 20, 30, 40]) ring.record(ms, 1);
    // The four 1000ms samples were fully lapped.
    expect(ring.stats()).toMatchObject({ last: 40, p50: 20, samples: 4 });
  });

  it("clamps negatives to zero and ignores non-finite samples", () => {
    const ring = new LatencyRing();
    ring.record(Number.NaN, 5);
    ring.record(Number.POSITIVE_INFINITY, 6);
    expect(ring.stats()).toBeNull();
    ring.record(-12, 7);
    expect(ring.stats()).toMatchObject({ last: 0, samples: 1 });
  });

  it("rejects a nonsensical capacity", () => {
    expect(() => new LatencyRing(0)).toThrow(/positive integer/);
  });
});

describe("MinuteBuckets", () => {
  it("sums only the trailing 60 seconds", () => {
    const buckets = new MinuteBuckets();
    const t0 = 100_000_000;
    buckets.bump(t0, 5, 500);
    buckets.bump(t0 + 30_000, 3, 300);
    expect(buckets.lastMinute(t0 + 30_000)).toEqual({ count: 8, bytes: 800, perSecond: 8 / 60 });
    // 61s after the first bump, only the second survives.
    expect(buckets.lastMinute(t0 + 61_000)).toEqual({ count: 3, bytes: 300, perSecond: 3 / 60 });
    // Silence decays to zero without a sweeper.
    expect(buckets.lastMinute(t0 + 120_000)).toEqual({ count: 0, bytes: 0, perSecond: 0 });
  });

  it("a lapped slot (same slot index, different second) resets instead of accumulating", () => {
    const buckets = new MinuteBuckets();
    const t0 = 100_000_000;
    buckets.bump(t0, 10, 100);
    buckets.bump(t0 + 60_000, 1, 1); // exactly one ring lap later — same slot
    expect(buckets.lastMinute(t0 + 60_000)).toEqual({ count: 1, bytes: 1, perSecond: 1 / 60 });
  });

  it("accumulates multiple bumps within one second", () => {
    const buckets = new MinuteBuckets();
    buckets.bump(5_000, 1, 10);
    buckets.bump(5_400, 2, 20);
    expect(buckets.lastMinute(5_900)).toEqual({ count: 3, bytes: 30, perSecond: 3 / 60 });
  });
});

describe("MinuteBuckets windows and series", () => {
  it("short windows report responsive rates; old buckets fall out", () => {
    const buckets = new MinuteBuckets();
    const t0 = 100_000_000;
    buckets.bump(t0, 30, 3_000); // 10s ago — outside a 5s window
    buckets.bump(t0 + 8_000, 10, 1_000); // 2s ago — inside
    expect(buckets.window(t0 + 10_000, 5)).toEqual({ count: 10, bytes: 1_000 });
    expect(buckets.window(t0 + 10_000, 60)).toEqual({ count: 40, bytes: 4_000 });
  });

  it("series is exactly 60 per-second entries, oldest→newest, silent seconds zero", () => {
    const buckets = new MinuteBuckets();
    const t0 = 100_000_000;
    buckets.bump(t0, 7, 700); // now − 59s: the oldest visible bucket
    buckets.bump(t0 + 59_000, 2, 200); // the current second
    const series = buckets.series(t0 + 59_000);
    expect(series.counts).toHaveLength(60);
    expect(series.counts[0]).toBe(7);
    expect(series.counts[59]).toBe(2);
    expect(series.counts.reduce((sum, n) => sum + n, 0)).toBe(9);
    expect(series.bytes[0]).toBe(700);
    expect(series.bytes[59]).toBe(200);
  });
});

describe("StreamRuntimeMetrics", () => {
  it("reports measuredSince plus responsive rates, minute totals, and the series", () => {
    const metrics = new StreamRuntimeMetrics(1_700_000_000_000);
    metrics.ingress.bump(1_700_000_010_000, 4, 4000);
    metrics.egress.bump(1_700_000_010_000, 8, 8000);
    const report = metrics.report(1_700_000_010_500);
    expect(report.measuredSince).toBe("2023-11-14T22:13:20.000Z");
    expect(report.ingress.perSecond5s).toBe(4 / 5);
    expect(report.ingress.bytesPerSecond5s).toBe(4000 / 5);
    expect(report.ingress.lastMinute).toEqual({ count: 4, bytes: 4000, perSecond: 4 / 60 });
    expect(report.ingress.series.counts.reduce((sum, n) => sum + n, 0)).toBe(4);
    expect(report.egress.perSecond5s).toBe(8 / 5);
    expect(report.egress.lastMinute.bytes).toBe(8000);
  });
});

describe("pingRoundTrip", () => {
  test.for([
    // Symmetric 10ms hops, no skew, 5ms responder processing.
    { reply: { t0: 1000, t1: 1010, t2: 1015 }, t3: 1025, rttMs: 20, clockOffsetMs: 0 },
    // Responder clock runs 100ms ahead: RTT is unaffected, offset surfaces it.
    { reply: { t0: 1000, t1: 1110, t2: 1115 }, t3: 1025, rttMs: 20, clockOffsetMs: 100 },
    // Responder clock 50ms behind.
    { reply: { t0: 1000, t1: 960, t2: 965 }, t3: 1025, rttMs: 20, clockOffsetMs: -50 },
    // Degenerate timestamps never produce a negative RTT.
    { reply: { t0: 1000, t1: 1000, t2: 1100 }, t3: 1010, rttMs: 0, clockOffsetMs: 45 },
  ])("rtt=$rttMs offset=$clockOffsetMs", ({ reply, t3, rttMs, clockOffsetMs }) => {
    expect(pingRoundTrip(reply, t3)).toEqual({ rttMs, clockOffsetMs });
  });
});
