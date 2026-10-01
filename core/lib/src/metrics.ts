// metrics.ts — COUNTS, GAUGES AND TIMINGS as Analytics Engine data points (docs/telemetry.md#metrics):
// one `writeDataPoint` per call, which never blocks and is never awaited. Call it once per batch,
// never once per item.

/** A Worker's metrics, from its env: the `METRICS` Analytics Engine dataset, and its `WORKER_NAME`
 *  var (the runtime does not tell a Worker its own name); for the context they belong to, if any.
 *  With no dataset bound (local dev, tests) nothing is written. */
export function metrics(
  env: { METRICS?: AnalyticsEngineDataset; WORKER_NAME: string },
  context: { projectId?: string; path?: string } = {},
) {
  const { METRICS: dataset, WORKER_NAME: worker } = env;
  const { projectId = null, path = null } = context;
  const write = (name: string, kind: string, value: number, labels = "") => {
    try {
      // `index1` is the project, so a busy project cannot crowd a quiet one's samples out. The
      // blobs' layout can only grow at the end.
      dataset?.writeDataPoint({
        indexes: [projectId || "platform"],
        blobs: [name, kind, worker, projectId, path, labels],
        doubles: [value],
      });
    } catch (error) {
      // An invocation may write 250 points; past that `writeDataPoint` throws, and the point is lost.
      if (droppedPointWarned) return;
      droppedPointWarned = true;
      console.warn({
        event: "metrics.point-dropped",
        message: "a metric point was dropped (at most 250 per invocation); later drops say nothing",
        name,
        error: String(error),
      });
    }
  };
  return {
    count: (name: string, value: number, labels?: string) => write(name, "count", value, labels),
    gauge: (name: string, value: number, labels?: string) => write(name, "gauge", value, labels),
    time: (name: string, ms: number, labels?: string) => write(name, "timing", ms, labels),
  };
}

export type Metrics = ReturnType<typeof metrics>;

/** Once per isolate, not per invocation: the first drop says what every later one would. */
let droppedPointWarned = false;
