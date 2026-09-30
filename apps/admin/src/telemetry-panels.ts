// telemetry-panels.ts — THE /telemetry PAGE'S PANELS, each one flat Analytics Engine SQL query over
// the metrics dataset (docs/telemetry.md "Metrics": blob1…6 are name, kind, worker, project, path
// and labels, double1 the value). Analytics Engine samples, so every sum and percentile is weighted
// by `_sample_interval`, the number of real points one stored point stands for.
import { z } from "zod";

export const TelemetryRange = z.enum(["1h", "6h", "24h", "7d"]);
export type TelemetryRange = z.infer<typeof TelemetryRange>;

type RangeWindow = { label: string; hours: number; bucketMinutes: number };

/** The page's ranges: how far back it reads, and how wide one point of a series is. */
export const RANGES: Record<TelemetryRange, RangeWindow> = {
  "1h": { label: "Last hour", hours: 1, bucketMinutes: 1 },
  "6h": { label: "Last 6 hours", hours: 6, bucketMinutes: 5 },
  "24h": { label: "Last 24 hours", hours: 24, bucketMinutes: 15 },
  "7d": { label: "Last 7 days", hours: 168, bucketMinutes: 60 },
};

/** A panel: a `series` query answers a bucket `t` and one column per line; a `table` query answers
 *  the rows as shown. */
export type Panel = {
  title: string;
  chart: "series" | "table";
  sql: (dataset: string, range: RangeWindow) => string;
};

export const PANELS: Panel[] = [
  {
    title: "subscription.delivery_ms p50 and p99 (ms)",
    chart: "series",
    sql: (dataset, { hours, bucketMinutes }) =>
      `SELECT toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE) AS t, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50, quantileExactWeighted(0.99)(double1, _sample_interval) AS p99 FROM ${dataset} WHERE blob1 = 'subscription.delivery_ms' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY t ORDER BY t`,
  },
  {
    title: "subscription.pending, the ten deepest rows",
    chart: "table",
    sql: (dataset, { hours }) =>
      `SELECT blob4 AS project_id, blob5 AS path, blob6 AS labels, max(double1) AS max FROM ${dataset} WHERE blob1 = 'subscription.pending' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY project_id, path, labels ORDER BY max DESC LIMIT 10`,
  },
  {
    title: "subscription.retries per minute",
    chart: "series",
    sql: (dataset, { hours, bucketMinutes }) =>
      `SELECT toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE) AS t, sum(_sample_interval * double1) / ${bucketMinutes} AS retries FROM ${dataset} WHERE blob1 = 'subscription.retries' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY t ORDER BY t`,
  },
  {
    title: "Metric points per worker",
    chart: "table",
    sql: (dataset, { hours }) =>
      `SELECT blob3 AS worker, sum(_sample_interval) AS points, count() AS stored FROM ${dataset} WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY worker ORDER BY points DESC LIMIT 20`,
  },
];
