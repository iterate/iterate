import type { StreamThroughputMetrics, ThroughputReport } from "iterate/processors";

type TimestampedStreamThroughputMetrics = StreamThroughputMetrics & {
  /** Time at which the server materialized the rolling buckets. */
  reportedAt?: string;
};

/**
 * Age an event-driven throughput snapshot without asking the server for a new
 * one. A quiet stream therefore visibly decays to zero even though no state
 * mutation exists to push; this is wall-clock presentation, not state polling.
 */
export function ageStreamThroughputMetrics(
  metrics: TimestampedStreamThroughputMetrics,
  nowMs: number,
): StreamThroughputMetrics {
  const reportedAtMs =
    metrics.reportedAt === undefined ? Number.NaN : Date.parse(metrics.reportedAt);
  if (!Number.isFinite(reportedAtMs)) return metrics;

  const elapsedSeconds = Math.max(0, Math.floor(nowMs / 1_000) - Math.floor(reportedAtMs / 1_000));
  if (elapsedSeconds === 0) return metrics;

  return {
    ...metrics,
    ingress: ageThroughputReport(metrics.ingress, elapsedSeconds),
    egress: ageThroughputReport(metrics.egress, elapsedSeconds),
  };
}

function ageThroughputReport(report: ThroughputReport, elapsedSeconds: number): ThroughputReport {
  const counts = shiftWithZeros(report.series.counts, elapsedSeconds);
  const bytes = shiftWithZeros(report.series.bytes, elapsedSeconds);
  const trailingCounts = counts.slice(-5).reduce((sum, count) => sum + count, 0);
  const trailingBytes = bytes.slice(-5).reduce((sum, count) => sum + count, 0);
  const minuteCount = counts.reduce((sum, count) => sum + count, 0);
  const minuteBytes = bytes.reduce((sum, count) => sum + count, 0);
  return {
    perSecond5s: trailingCounts / 5,
    bytesPerSecond5s: trailingBytes / 5,
    lastMinute: {
      count: minuteCount,
      bytes: minuteBytes,
      perSecond: minuteCount / 60,
    },
    series: { counts, bytes },
  };
}

function shiftWithZeros(values: readonly number[], elapsedSeconds: number): number[] {
  const shift = Math.min(values.length, elapsedSeconds);
  return [...values.slice(shift), ...new Array<number>(shift).fill(0)];
}
