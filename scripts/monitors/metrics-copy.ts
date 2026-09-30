// scripts/monitors/metrics-copy.ts — THE HOURLY METRICS COPY, a step of the health job (./health.ts):
// Analytics Engine keeps what iterate/metrics writes for 90 days, and the lake's `metrics` table
// keeps it after (docs/telemetry.md). The health state keeps a watermark per lake, the last hour
// copied whole; each run sends the closed hours after it to the metrics stream, oldest first and
// COPY_HOURS at most, and a lake's first run starts at the hour that just closed. A row is one data
// point as Analytics Engine stored it, its `_sample_interval` the row's weight.
import { z } from "zod";
import { telemetryEnvs } from "../../envs.ts";
import {
  analyticsEngineSql,
  cloudflareApiToken,
  cloudflarePost,
  type AnalyticsEngineRow,
} from "./telemetry.ts";

/** A day's backlog closes in one run; a longer one over the next runs. */
export const COPY_HOURS = 24;
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

/** One data point as the hour's query reads it: blob1…6 are name, kind, worker, project, path,
 *  labels. */
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

/** The closed hours a run copies, by their start in unix seconds: those after the watermark
 *  `copiedThrough`, oldest first and COPY_HOURS at most; with no watermark, the hour that just
 *  closed. Pure. */
export function hoursToCopy(copiedThrough: number | undefined, now: Date) {
  const current = Math.floor(now.getTime() / 1_000 / HOUR_S) * HOUR_S;
  const first = copiedThrough === undefined ? current - HOUR_S : copiedThrough + HOUR_S;
  const count = Math.min(COPY_HOURS, Math.max(0, (current - first) / HOUR_S));
  return Array.from({ length: count }, (_, index) => first + index * HOUR_S);
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

/** Copy each lake's closed hours after its watermark in `copiedThrough` (by its telemetryEnvs
 *  name), which moves past each hour once every chunk of it is sent. `send: false` reads, says what
 *  it would send and moves nothing. Throws when a read or a send fails. */
export async function copyMetrics(input: {
  copiedThrough: Record<string, number>;
  send: boolean;
  now: Date;
}) {
  for (const [name, env] of Object.entries(telemetryEnvs)) {
    const apiToken = cloudflareApiToken(env);
    // AN HOUR IS SENT WHOLE: a send that still fails after CLOUDFLARE_API's retries throws before
    // the watermark passes its hour, so the next run sends the hour again from its first chunk. Its
    // chunks that had landed then land twice, as a retried chunk can, and `metrics` has no key to
    // dedupe them on.
    for (const hour of hoursToCopy(input.copiedThrough[name], input.now)) {
      const rows = metricsRows(
        await analyticsEngineSql(
          env,
          apiToken,
          `SELECT toUnixTimestamp(timestamp) AS unix, blob1 AS name, blob2 AS kind, blob3 AS worker, blob4 AS project_id, blob5 AS path, blob6 AS labels, double1 AS value, _sample_interval AS weight FROM iterate_metrics WHERE timestamp >= toDateTime(${hour}) AND timestamp < toDateTime(${hour + HOUR_S})`,
        ),
      );
      const bodies = chunks(rows);
      const summary = `${name} ${new Date(hour * 1_000).toISOString()}: ${rows.length} rows in ${bodies.length} chunk(s)`;
      if (!input.send) {
        console.log(`[metrics copy] [dry run] would send ${summary}`);
        continue;
      }
      for (const body of bodies)
        await cloudflarePost(
          `https://${env.streams.metrics}.ingest.cloudflare.com`,
          apiToken,
          body,
        );
      input.copiedThrough[name] = hour;
      console.log(`[metrics copy] sent ${summary}`);
    }
  }
}
