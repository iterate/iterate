// perf/record.ts — how a perf row records a metric (perf/latency.ts): its raw samples on the row's
// own `meta`, which Vitest's JSON reporter writes beside the row's result
// (https://vitest.dev/advanced/metadata) — the latency guard reads the metrics from that report, so
// no other file or variable carries them — plus one printed line, and the budget held with
// `expect.soft`, so a row that misses one budget still records every other metric it measures.

import { expect, type TestContext } from "vitest";
import {
  BUDGET_MISSED,
  budgetLine,
  crosses,
  LATENCY_METRICS,
  summarize,
  type LatencyMetricName,
} from "./latency.ts";

declare module "vitest" {
  interface TaskMeta {
    /** Every metric this row recorded: its raw samples, by name (perf/latency.ts). */
    latency?: Partial<Record<LatencyMetricName, number[]>>;
  }
}

/** Record `samples` of `metric` on the running row (`task`, from the test's context) and hold the
 *  median to the metric's budget. Call it once the row's own correctness checks passed: a
 *  metric that was never recorded is what the guard reads as a broken probe. */
export function recordLatency(
  task: TestContext["task"],
  metric: LatencyMetricName,
  samples: number[],
) {
  (task.meta.latency ||= {})[metric] = samples;
  const summary = summarize(samples);
  const { unit } = LATENCY_METRICS[metric];
  const line = budgetLine(metric, 1);
  const value = summary.p50;
  console.log(
    `[latency] ${metric}: n=${summary.n} p50=${round(summary.p50)} p95=${round(summary.p95)} max=${round(summary.max)} ${unit} — the median against a budget of ${line}`,
  );
  expect
    .soft(
      crosses(metric, value, line),
      `${BUDGET_MISSED} ${metric} median ${round(value)} ${unit}, budget ${line} (samples ${samples.map(round).join(", ")})`,
    )
    .toBe(false);
  return summary;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
