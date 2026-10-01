// scripts/monitors/metrics-copy.ts — THE HOURLY METRICS COPY, the health job's last step
// (./health.ts): Analytics Engine keeps what iterate/metrics writes for 90 days, and the lake's
// `metrics` table keeps it after (docs/telemetry.md). The health state keeps a watermark per lake,
// the last hour copied whole; each run sends the closed hours after it to the metrics stream,
// oldest first and COPY_HOURS at most, and the watermark is kept as each hour is sent. A lake's
// first run starts at the hour that just closed. A row is one data point as Analytics Engine stored
// it, its `_sample_interval` the row's weight.
import { z } from "zod";
import {
  analyticsEngineSql,
  cloudflareApiToken,
  cloudflarePost,
  type AnalyticsEngineRow,
  type TelemetryEnv,
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

/** Analytics Engine's points as `metrics` rows: an unset project or path is null. An answer that is
 *  no point makes no row (a NaN double has no JSON number, and `metrics.value` takes nothing else):
 *  the stream would drop it, and a throw would hold its hour, and every hour after, back for good.
 *  The copy's log line counts them. Pure. */
export function metricsRows(points: AnalyticsEngineRow[]): MetricsRow[] {
  return points.flatMap((row) => {
    const { data: point } = Point.safeParse(row);
    if (!point) return [];
    return [
      {
        time: new Date(point.unix * 1_000).toISOString(),
        worker: point.worker,
        project_id: point.project_id || null,
        path: point.path || null,
        name: point.name,
        kind: point.kind,
        labels: point.labels,
        value: point.value,
        weight: point.weight,
      },
    ];
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

/** Copy one lake's closed hours after its watermark `copiedThrough`. An hour is sent whole, then
 *  `keepWatermark` is called with it: the caller keeps it at once, so a run cut short later has
 *  kept every hour it sent. With no `keepWatermark` it reads, says what it would send and sends
 *  nothing: `metrics` has no key, so an hour sent and not remembered would be sent again and stay
 *  double. Throws when a read or a send fails. */
export async function copyMetrics(input: {
  /** The lake's telemetryEnvs name. */
  lake: string;
  env: TelemetryEnv;
  copiedThrough: number | undefined;
  now: Date;
  keepWatermark: ((hour: number) => void) | undefined;
}) {
  const { lake, env } = input;
  const apiToken = cloudflareApiToken(env);
  if (input.copiedThrough === undefined)
    console.log(
      `[metrics copy] ${lake} has no watermark: starting at the last closed hour, the hours before it are not copied`,
    );
  // AN HOUR IS SENT WHOLE: a send that still fails after CLOUDFLARE_API's retries throws before the
  // watermark passes its hour, so the next run sends the hour again from its first chunk. Its
  // chunks that had landed then land twice, as a retried chunk can, and `metrics` has no key to
  // dedupe them on.
  for (const hour of hoursToCopy(input.copiedThrough, input.now)) {
    const at = `${lake} ${new Date(hour * 1_000).toISOString()}`;
    const during = `FROM iterate_metrics WHERE timestamp >= toDateTime(${hour}) AND timestamp < toDateTime(${hour + HOUR_S})`;
    const points = await analyticsEngineSql(
      env,
      apiToken,
      `SELECT toUnixTimestamp(timestamp) AS unix, blob1 AS name, blob2 AS kind, blob3 AS worker, blob4 AS project_id, blob5 AS path, blob6 AS labels, double1 AS value, _sample_interval AS weight ${during}`,
    );
    // THE READ NAMES NO LIMIT, and Analytics Engine documents none of its own: it answered all
    // 10,883 points of the dev account's fullest hour (2026-10-01). Should it ever cut an answer
    // short, the hour's own count says so before the watermark passes a hole. Same hour and
    // filter, so both read the same stored points.
    const [counted] = await analyticsEngineSql(env, apiToken, `SELECT count() AS points ${during}`);
    const stored = z.coerce.number().parse(counted?.points);
    if (points.length < stored)
      throw new Error(`${at}: Analytics Engine answered ${points.length} of ${stored} points`);
    const rows = metricsRows(points);
    const bodies = chunks(rows);
    const summary = `${at}: ${rows.length} rows in ${bodies.length} chunk(s), ${points.length - rows.length} unreadable point(s) skipped`;
    if (!input.keepWatermark) {
      console.log(`[metrics copy] [dry run] would send ${summary}`);
      continue;
    }
    for (const body of bodies)
      await cloudflarePost(`https://${env.streams.metrics}.ingest.cloudflare.com`, apiToken, body);
    input.keepWatermark(hour);
    console.log(`[metrics copy] sent ${summary}`);
  }
}
