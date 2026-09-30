// scripts/monitors/metrics-copy.ts — THE HOURLY METRICS COPY, a step of the health job (./health.ts):
// Analytics Engine keeps what iterate/metrics writes for 90 days, and the lake's `metrics` table
// keeps it after (docs/telemetry.md). Each run sends the closed hours the lake lacks to the metrics
// stream, newest first and COPY_HOURS at most: the hour that just closed lands every run, and a gap
// backfills over the next runs. A row is one data point as Analytics Engine stored it, its
// `_sample_interval` the row's weight. Every call uses the account's Cloudflare API token, which
// reads Analytics Engine and R2 SQL and sends to a stream.
import { z } from "zod";
import { telemetryEnvs } from "../../envs.ts";
import {
  analyticsEngineSql,
  cloudflarePost,
  telemetryApiToken,
  type AnalyticsEngineRow,
} from "./telemetry.ts";

/** A day's gap closes in one run; a longer one over the next runs. */
export const COPY_HOURS = 24;
/** How long Analytics Engine keeps a data point: three months
 *  (https://developers.cloudflare.com/analytics/analytics-engine/limits/). */
const RETENTION_HOURS = 90 * 24;
/** Under a stream's 5 MB per request. */
const CHUNK_BYTES = 4_500_000;
const HOUR_S = 3_600;

/** One `metrics` row (docs/telemetry.md "metrics"). */
export type MetricsRow = {
  time: string;
  worker: string;
  project_id: string | null;
  path: string | null;
  name: string;
  kind: string;
  labels: string;
  value: number;
  weight: number;
};

/** One data point as HOUR_POINTS reads it: blob1…6 are name, kind, worker, project, path, labels. */
const Point = z.object({
  unix: z.coerce.number(),
  name: z.string(),
  kind: z.string(),
  worker: z.string(),
  project_id: z.string(),
  path: z.string(),
  labels: z.string(),
  value: z.number(),
  weight: z.coerce.number(),
});

/** R2 SQL's answer to LAKE_HOURS: each hour's start, `2026-09-30T13:00:00.000000Z`. */
const LakeHours = z.object({
  result: z.object({ rows: z.array(z.object({ hour: z.string() })) }),
});

/** The closed hours to copy, by their start in unix seconds: Analytics Engine has points in them
 *  and the lake has none, newest first, COPY_HOURS at most. Pure. */
export function hoursToCopy(analyticsEngineHours: number[], lakeHours: Set<number>) {
  return analyticsEngineHours
    .filter((hour) => !lakeHours.has(hour))
    .sort((a, b) => b - a)
    .slice(0, COPY_HOURS);
}

/** Analytics Engine's points as `metrics` rows: an unset project or path is null. Pure. */
export function metricsRows(points: AnalyticsEngineRow[]): MetricsRow[] {
  return points.map((row) => {
    const point = Point.parse(row);
    return {
      time: new Date(point.unix * 1_000).toISOString(),
      worker: point.worker,
      project_id: point.project_id || null,
      path: point.path || null,
      name: point.name,
      kind: point.kind,
      labels: point.labels,
      value: point.value,
      weight: point.weight,
    };
  });
}

/** The rows as JSON array bodies, each under CHUNK_BYTES. Pure. */
export function chunks(rows: MetricsRow[]) {
  const bodies: string[] = [];
  let lines: string[] = [];
  let bytes = 2;
  for (const row of rows) {
    const line = JSON.stringify(row);
    const size = Buffer.byteLength(line) + 1;
    if (lines.length > 0 && bytes + size > CHUNK_BYTES) {
      bodies.push(`[${lines.join(",")}]`);
      lines = [];
      bytes = 2;
    }
    lines.push(line);
    bytes += size;
  }
  if (lines.length > 0) bodies.push(`[${lines.join(",")}]`);
  return bodies;
}

/** Copy the closed hours each account's lake lacks (`hoursToCopy`); `send: false` reads and says
 *  what it would send. Throws when a read or a send fails. */
export async function copyMetrics(input: { send: boolean; now: Date }) {
  // the hours before the current one are closed; the oldest whole hour Analytics Engine keeps begins
  // one hour into its retention
  const until = Math.floor(input.now.getTime() / 1_000 / HOUR_S) * HOUR_S;
  const since = until - (RETENTION_HOURS - 1) * HOUR_S;
  for (const [name, env] of Object.entries(telemetryEnvs)) {
    const apiToken = telemetryApiToken(env);
    const census = await analyticsEngineSql(
      env,
      apiToken,
      `SELECT toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '1' HOUR)) AS hour, count() AS points FROM ${env.metricsDataset} WHERE timestamp >= toDateTime(${since}) AND timestamp < toDateTime(${until}) GROUP BY hour`,
    );
    const points = new Map(census.map((row) => [Number(row.hour), Number(row.points)]));
    if (points.size === 0) {
      console.log(`[metrics copy] ${name}: no points in Analytics Engine's 90 days`);
      continue;
    }
    const lake = await cloudflarePost(
      `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.cloudflareAccountId}/r2-sql/query/${env.bucket}`,
      apiToken,
      JSON.stringify({
        query: `SELECT date_trunc('hour', time) AS hour FROM ${env.namespace}.metrics WHERE time >= '${new Date(since * 1_000).toISOString()}' AND time < '${new Date(until * 1_000).toISOString()}' GROUP BY date_trunc('hour', time)`,
      }),
      { idempotent: true },
    );
    const lakeHours = new Set(
      LakeHours.parse(JSON.parse(lake)).result.rows.map((row) => Date.parse(row.hour) / 1_000),
    );
    const hours = hoursToCopy([...points.keys()], lakeHours);
    console.log(
      `[metrics copy] ${name}: ${points.size} hours with points, ${lakeHours.size} in the lake, ${hours.length} to copy`,
    );
    // AN HOUR IS COPIED ONCE: only while the lake has none of its rows. A chunk the stream failed is
    // sent again (CLOUDFLARE_API), so it may land twice, which docs/telemetry.md "Failures" dedupes
    // on the table's key; a send that still fails throws, and leaves its hour partial and the health
    // job red.
    for (const hour of hours) {
      const rows = metricsRows(
        await analyticsEngineSql(
          env,
          apiToken,
          `SELECT toUnixTimestamp(timestamp) AS unix, blob1 AS name, blob2 AS kind, blob3 AS worker, blob4 AS project_id, blob5 AS path, blob6 AS labels, double1 AS value, _sample_interval AS weight FROM ${env.metricsDataset} WHERE timestamp >= toDateTime(${hour}) AND timestamp < toDateTime(${hour + HOUR_S})`,
        ),
      );
      const at = new Date(hour * 1_000).toISOString();
      if (rows.length !== points.get(hour))
        throw new Error(`read ${rows.length} of ${at}'s ${points.get(hour)} points`);
      const bodies = chunks(rows);
      const summary = `${at}: ${rows.length} rows in ${bodies.length} chunk(s)`;
      if (!input.send) {
        console.log(`[metrics copy] [dry run] would send ${summary}`);
        continue;
      }
      for (const body of bodies)
        await cloudflarePost(env.streams.metrics.endpoint, apiToken, body, { idempotent: true });
      console.log(`[metrics copy] sent ${summary}`);
    }
  }
}
