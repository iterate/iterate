import { describe, expect, it } from "vitest";
import type { StreamThroughputMetrics } from "iterate/processors";
import { ageStreamThroughputMetrics } from "./stream-throughput.ts";

describe("ageStreamThroughputMetrics", () => {
  it("shifts event-driven buckets across quiet seconds and recomputes rates", () => {
    const metrics = throughputMetrics([0, 0, 0, 5, 10], [0, 0, 0, 50, 100]);
    const aged = ageStreamThroughputMetrics(metrics, Date.parse("2026-07-18T00:00:02.000Z"));

    expect(aged.ingress.series.counts).toEqual([0, 5, 10, 0, 0]);
    expect(aged.ingress.series.bytes).toEqual([0, 50, 100, 0, 0]);
    expect(aged.ingress.perSecond5s).toBe(3);
    expect(aged.ingress.bytesPerSecond5s).toBe(30);
    expect(aged.ingress.lastMinute).toEqual({ count: 15, bytes: 150, perSecond: 0.25 });
  });

  it("decays a quiet window fully to zero without a server refresh", () => {
    const metrics = throughputMetrics([1, 2, 3], [10, 20, 30]);
    const aged = ageStreamThroughputMetrics(metrics, Date.parse("2026-07-18T00:01:00.000Z"));

    expect(aged.ingress.series.counts).toEqual([0, 0, 0]);
    expect(aged.ingress.perSecond5s).toBe(0);
    expect(aged.ingress.lastMinute.count).toBe(0);
  });
});

function throughputMetrics(counts: number[], bytes: number[]): StreamThroughputMetrics {
  const direction = {
    perSecond5s: 0,
    bytesPerSecond5s: 0,
    lastMinute: { count: 0, bytes: 0, perSecond: 0 },
    series: { counts, bytes },
  };
  return {
    measuredSince: "2026-07-18T00:00:00.000Z",
    reportedAt: "2026-07-18T00:00:00.000Z",
    ingress: direction,
    egress: direction,
  } as StreamThroughputMetrics;
}
