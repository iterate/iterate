// scripts/ci/os-latency-guard.ts — THE LATENCY GUARD'S JUDGE (.depot/workflows/os-latency.yml, every
// 3 hours, against main redeployed to a preview that nothing else touches). It reads
// one run of apps/os's perf suite — Vitest's JSON report, where each row left its raw samples on its
// meta (apps/os/perf/record.ts) — and judges every metric's median against two lines:
//   • its BUDGET (apps/os/perf/latency.ts, calibrated on main with headroom), and
//   • a sharp REGRESSION against the guard's own rolling baseline, the last 10 main runs: more than
//     3× their median (the calibration's runs of one commit spread up to 2.4× theirs: fan50.all,
//     x10.answered) and 250 ms more (below that a round trip's weather decides, and the budget
//     guards), AND slower than the slowest of them that crossed no line — so a metric whose runs
//     spread wide (the slowest of 25 concurrent projects: 7–21 s on one commit) does not page on its
//     own spread, and one slow run does not raise the line the next run is judged by. For a rate:
//     under a third of the median and under the lowest. A regression that lasts moves the median in ~6
//     runs; the metric then clears, and its green page names the baseline it moved to.
// Every measurement goes to PostHog (`os latency measured`: metric, percentile, value, sha, run). The
// page is the alarm and it pages #error-pulse on a change of state only: RED once when a metric
// crossed a line in two runs in a row (one slow run is weather; the next one confirms it — at most 3
// hours later), GREEN once when every red metric stayed under its lines two runs in a row. A page
// leaves the run green: a scheduled run reports on main's head, where red reads as "this commit
// broke". A BROKEN PROBE fails the run instead: a row that failed for anything but a budget, a metric
// no row recorded, no report.
//
// The memory between runs is the previous main run's `os-latency-state` artifact (depot.ts
// `saveNewestArtifactFile`, `stateArtifact` below): the last 20 main runs' medians, what each
// crossed, and which metrics are red. A run off main, or with a budget scale (the dispatch's forced alert), is a TEST RUN: it
// pages whatever crossed in this run alone, marked 🧪 and mentioning nobody, and keeps no state.
//
//   pnpm tsx scripts/ci/os-latency-guard.ts previous-state --out <state.json>
//   pnpm tsx scripts/ci/os-latency-guard.ts judge --report <vitest.json> [--state <state.json>] \
//     [--state-out <next.json>] --run <id> --ref <git ref> --trigger <event> [--budget-scale 0.01] [--dry-run]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { z } from "zod";
import {
  BUDGET_MISSED,
  budgetLine,
  crosses,
  LATENCY_METRICS,
  summarize,
  type LatencyMetricName,
} from "../../apps/os/perf/latency.ts";
import { osEnvs } from "../../envs.ts";
import { saveNewestArtifactFile } from "./depot.ts";
import { sendPostHogEvents, systemEvent } from "./posthog-events.ts";
import { getSlackClient, onCallMention, slackChannelIds, slackEscape } from "./slack.ts";

/** Where one run leaves its state for the next: the workflow's `name:`, the artifact
 *  .depot/workflows/os-latency.yml uploads, the file in it. */
export const stateArtifact = {
  workflow: "OS latency",
  artifact: "os-latency-state",
  file: "state.json",
};
/** How many main runs the state remembers. */
const HISTORY_RUNS = 20;
/** The baseline is the median of this many newest runs that measured the metric… */
const BASELINE_RUNS = 10;
/** …and there is none below this many: a baseline of one or two runs is one or two samples of weather. */
const BASELINE_MIN_RUNS = 5;
/** A regression is more than this many times the baseline… (not 2: one commit's runs spread up to
 *  2.4× their median in the calibration, apps/os/perf/latency.ts) */
const REGRESSION_FACTOR = 3;
/** …and, for a time, also more than this far above it: three times a 25 ms round trip is weather
 *  (the calibration's warm appends ran 25 ms on one preview and 72 ms on the next). */
const REGRESSION_FLOOR_MS = 250;

const MetricName = z.enum(Object.keys(LATENCY_METRICS) as [LatencyMetricName]);
/** Metric names read back from a state an older table wrote: a metric since renamed or removed is
 *  dropped, never a parse failure. */
const KnownMetrics = z
  .array(z.string())
  .transform((names) => names.filter((name) => MetricName.safeParse(name).success))
  .pipe(z.array(MetricName));

/** What one run hands the next: the main runs it knows, oldest first, and the metrics paged red. */
export const GuardState = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(
    z.object({
      sha: z.string(),
      run: z.string(),
      at: z.iso.datetime(),
      /** Each measured metric's median. */
      judged: z
        .record(z.string(), z.number())
        .transform((judged) =>
          Object.fromEntries(
            Object.entries(judged).filter(([name]) => MetricName.safeParse(name).success),
          ),
        )
        .pipe(z.partialRecord(MetricName, z.number())),
      /** The measured metrics that crossed a line. */
      over: KnownMetrics,
    }),
  ),
  red: KnownMetrics,
});
export type GuardState = z.output<typeof GuardState>;

/** The parts of Vitest's JSON report (`--reporter=json`) the guard reads: every row's status, its
 *  failure messages and the samples perf/record.ts left on its meta; a file that failed to load has
 *  a `failed` status and a message, and no rows. */
const VitestReport = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string().optional(),
      assertionResults: z.array(
        z.object({
          fullName: z.string(),
          status: z.string(),
          failureMessages: z.array(z.string()).nullish(),
          meta: z
            .object({ latency: z.partialRecord(MetricName, z.array(z.number())).optional() })
            .optional(),
        }),
      ),
    }),
  ),
});

/** Each metric's samples, and every way the probe broke: a file that did not load, a row that
 *  failed for anything but a budget. Pure. */
export function readReport(report: z.infer<typeof VitestReport>) {
  const samples: Partial<Record<LatencyMetricName, number[]>> = {};
  const broken: string[] = [];
  for (const file of report.testResults) {
    if (file.status === "failed" && file.assertionResults.length === 0)
      broken.push(`${file.name}: ${file.message || "failed to load"}`);
    for (const row of file.assertionResults) {
      Object.assign(samples, row.meta?.latency);
      const messages = row.failureMessages || [];
      const budgetOnly =
        messages.length > 0 && messages.every((message) => message.includes(BUDGET_MISSED));
      if (row.status === "failed" && !budgetOnly)
        broken.push(
          `${row.fullName}: ${messages.find((message) => !message.includes(BUDGET_MISSED)) || row.status}`,
        );
    }
  }
  return { samples, broken };
}

/** Every metric of this run against its budget (times `scale`) and the baseline `history` gives it;
 *  a metric no row recorded is `missing`. Pure. */
export function judgeRun(input: {
  samples: Partial<Record<LatencyMetricName, number[]>>;
  history: GuardState["runs"];
  scale: number;
}) {
  return MetricName.options.map((metric) => {
    const recorded = input.samples[metric];
    if (!recorded?.length) return { metric, missing: true as const };
    const summary = summarize(recorded);
    const value = summary.p50;
    const budget = budgetLine(metric, input.scale);
    const window = baselineWindow(metric, input.history);
    const baseline = window && summarize(window.map((run) => run.value)).p50;
    const regressionLine = window && regressionLineOf(metric, window);
    const overBudget = crosses(metric, value, budget);
    const regressed = regressionLine !== undefined && crosses(metric, value, regressionLine);
    return {
      metric,
      missing: false as const,
      summary,
      value,
      budget,
      baseline,
      regressionLine,
      overBudget,
      regressed,
      over: overBudget || regressed,
    };
  });
}
export type Reading = ReturnType<typeof judgeRun>[number];
type Measured = Extract<Reading, { missing: false }>;

/** The metric's median in each of the newest BASELINE_RUNS runs that measured it, and whether
 *  it crossed a line there, or undefined below BASELINE_MIN_RUNS. Pure. */
export function baselineWindow(metric: LatencyMetricName, history: GuardState["runs"]) {
  const window = history
    .flatMap((run) => {
      const value = run.judged[metric];
      return value === undefined ? [] : [{ value, over: run.over.includes(metric) }];
    })
    .slice(-BASELINE_RUNS);
  return window.length < BASELINE_MIN_RUNS ? undefined : window;
}

/** Past which a run's median is a sharp regression on `window`: REGRESSION_FACTOR times its median
 *  and REGRESSION_FLOOR_MS above it, and beyond the most extreme of its runs that crossed no line; for
 *  a rate, the factor below and under the lowest. */
function regressionLineOf(
  metric: LatencyMetricName,
  window: NonNullable<ReturnType<typeof baselineWindow>>,
) {
  const median = summarize(window.map((run) => run.value)).p50;
  const normal = window.filter((run) => !run.over).map((run) => run.value);
  return LATENCY_METRICS[metric].unit === "events/s"
    ? Math.min(median / REGRESSION_FACTOR, ...normal)
    : Math.max(median * REGRESSION_FACTOR, median + REGRESSION_FLOOR_MS, ...normal);
}

/** The state after this run and the page it owes, if any. A metric turns red when it crossed a line
 *  in this run AND the last run that measured it; a red one clears when it was measured under its
 *  lines in both.
 *  `red` pages the metrics that just turned; `green` pages once nothing is red any more. Pure. */
export function transition(input: {
  state: GuardState;
  readings: Reading[];
  run: GuardState["runs"][number];
}) {
  // "the run before" is the newest run that measured the metric: a run whose row broke says
  // nothing about it, so it neither breaks a streak of crossings nor one of runs under the lines
  const before = (metric: LatencyMetricName) =>
    input.state.runs.findLast((run) => run.judged[metric] !== undefined);
  const measuredUnder = (run: GuardState["runs"][number] | undefined, metric: LatencyMetricName) =>
    run?.judged[metric] !== undefined && !run.over.includes(metric);
  const turnedRed = input.run.over.filter(
    (metric) => before(metric)?.over.includes(metric) && !input.state.red.includes(metric),
  );
  const cleared = input.state.red.filter(
    (metric) => measuredUnder(input.run, metric) && measuredUnder(before(metric), metric),
  );
  const red = [...input.state.red.filter((metric) => !cleared.includes(metric)), ...turnedRed];
  const next: GuardState = {
    schemaVersion: 1,
    runs: [...input.state.runs, input.run].slice(-HISTORY_RUNS),
    red,
  };
  const page =
    turnedRed.length > 0 ? "red" : input.state.red.length > 0 && red.length === 0 ? "green" : null;
  return { next, page, turnedRed, cleared } as const;
}

/** This run as the state remembers it. Pure. */
export function rememberRun(readings: Reading[], run: { sha: string; run: string; at: string }) {
  const measured = readings.filter((reading): reading is Measured => !reading.missing);
  return {
    ...run,
    judged: Object.fromEntries(measured.map((reading) => [reading.metric, reading.value])),
    over: measured.filter((reading) => reading.over).map((reading) => reading.metric),
  };
}

/** The Slack message for a page: red names each metric that turned (or, in a test run, crossed) with
 *  its value, the line it crossed and the baseline; green names what came back. Pure. */
export function renderPage(input: {
  page: "red" | "green";
  readings: Reading[];
  metrics: LatencyMetricName[];
  stillRed: LatencyMetricName[];
  commit: { sha: string; subject: string };
  runUrl?: string;
  testRun?: { scale: number };
}) {
  const commit = `\`${input.commit.sha.slice(0, 9)}\` (${slackEscape(input.commit.subject)})`;
  const byMetric = new Map(input.readings.map((reading) => [reading.metric, reading]));
  const lines = input.metrics.map((metric) => {
    const reading = byMetric.get(metric);
    if (!reading || reading.missing) return `• ${metric}: not measured`;
    const { unit } = LATENCY_METRICS[metric];
    const rate = unit === "events/s";
    const value = `median ${format(reading.value)} ${unit}`;
    const baseline =
      reading.baseline === undefined
        ? "no baseline yet"
        : `baseline ${format(reading.baseline)} ${unit}, ${(reading.value / reading.baseline).toFixed(1)}×`;
    const crossed = [
      reading.overBudget &&
        `${rate ? "under" : "over"} its budget of ${format(reading.budget)} ${unit}`,
      reading.regressed && `a sharp regression (line ${format(reading.regressionLine!)} ${unit})`,
    ].filter(Boolean);
    const extreme = rate
      ? `min ${format(reading.summary.min)}`
      : `max ${format(reading.summary.max)}`;
    return input.page === "red"
      ? `• *${metric}* ${value}: ${crossed.join(" and ")} (${baseline}); n=${reading.summary.n}, ${extreme}`
      : `• ${metric} ${value} (budget ${format(reading.budget)}, ${baseline})`;
  });
  const test = input.testRun ? `🧪 TEST RUN (budgets × ${input.testRun.scale}) ` : "";
  const heading =
    input.page === "red"
      ? `${test}🔴 latency over its lines at ${commit}${input.testRun ? "" : ` ${onCallMention}`}`
      : `${test}🟢 latency back under its lines at ${commit}`;
  return [
    heading,
    ...lines,
    input.stillRed.length > 0 && `still red: ${input.stillRed.join(", ")}`,
    input.runUrl && `<${input.runUrl}|the run>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** One PostHog event per measured metric and percentile (p50, p95, max): low-cardinality — the
 *  metric names are LATENCY_METRICS' — and deduplicated per run attempt. Pure. */
export function latencyEvents(
  readings: Reading[],
  context: { sha: string; run: string; ref: string; trigger: string; testRun: boolean; at: string },
) {
  return readings
    .filter((reading): reading is Measured => !reading.missing)
    .flatMap((reading) =>
      (["p50", "p95", "max"] as const).map((percentile) =>
        systemEvent(
          "os latency measured",
          `os-latency:${context.run}:${reading.metric}:${percentile}`,
          "os-latency-guard",
          {
            metric: reading.metric,
            percentile,
            value: Math.round(reading.summary[percentile] * 10) / 10,
            unit: LATENCY_METRICS[reading.metric].unit,
            budget: reading.budget,
            baseline: reading.baseline,
            over: reading.over,
            samples: reading.summary.n,
            sha: context.sha,
            run: context.run,
            ref: context.ref,
            trigger: context.trigger,
            test_run: context.testRun,
          },
          context.at,
        ),
      ),
    );
}

async function judge(options: {
  report: string;
  state?: string;
  stateOut?: string;
  run: string;
  ref: string;
  trigger: string;
  budgetScale: number;
  dryRun: boolean;
}) {
  const testRun = options.budgetScale !== 1 || options.ref !== "refs/heads/main";
  const state: GuardState =
    options.state && existsSync(options.state)
      ? GuardState.parse(JSON.parse(readFileSync(options.state, "utf8")))
      : { schemaVersion: 1, runs: [], red: [] };
  const report = existsSync(options.report)
    ? readReport(VitestReport.parse(JSON.parse(readFileSync(options.report, "utf8"))))
    : { samples: {}, broken: [`no report at ${options.report}: the perf suite did not run`] };
  const readings = judgeRun({
    samples: report.samples,
    history: state.runs,
    scale: options.budgetScale,
  });
  const missing = readings.filter((reading) => reading.missing).map((reading) => reading.metric);
  const broken = [...report.broken, ...missing.map((metric) => `${metric}: not recorded`)];
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const subject = execFileSync("git", ["log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const at = new Date().toISOString();
  const run = rememberRun(readings, { sha, run: options.run, at });
  for (const reading of readings)
    if (!reading.missing)
      console.log(
        `${reading.over ? "OVER " : "     "}${reading.metric}: median ${format(reading.value)} — budget ${format(reading.budget)}${reading.baseline === undefined ? "" : `, baseline ${format(reading.baseline)}, regression line ${format(reading.regressionLine!)}`} (n=${reading.summary.n} p50=${format(reading.summary.p50)} p95=${format(reading.summary.p95)} max=${format(reading.summary.max)})`,
      );

  const outcome = testRun
    ? {
        next: undefined,
        page: run.over.length > 0 ? ("red" as const) : null,
        turnedRed: run.over,
        cleared: [],
      }
    : transition({ state, readings, run });
  const page =
    outcome.page &&
    renderPage({
      page: outcome.page,
      readings,
      metrics: outcome.page === "red" ? outcome.turnedRed : outcome.cleared,
      stillRed: outcome.next?.red.filter((metric) => !outcome.turnedRed.includes(metric)) ?? [],
      commit: { sha, subject },
      runUrl: process.env.DEPOT_JOB_URL,
      testRun: testRun ? { scale: options.budgetScale } : undefined,
    });
  console.log(
    JSON.stringify({
      testRun,
      over: run.over,
      red: outcome.next?.red,
      turnedRed: outcome.turnedRed,
      cleared: outcome.cleared,
      broken,
    }),
  );
  if (page) console.log(`\n${page}\n`);
  else console.log("latency: no change of state, nothing to page");

  // The order is the state's: the page first, since a red it records must have been posted (a page
  // that could not post leaves the state as it was, so the next run owes it again); then the state,
  // so neither a PostHog outage nor a broken probe costs the guard its memory; then PostHog.
  if (page && !options.dryRun)
    await getSlackClient().chat.postMessage({
      channel: slackChannelIds["#error-pulse"],
      text: page,
    });
  if (options.stateOut && outcome.next) {
    mkdirSync(dirname(options.stateOut), { recursive: true });
    writeFileSync(options.stateOut, `${JSON.stringify(outcome.next, null, 2)}\n`);
  }
  const events = latencyEvents(readings, {
    sha,
    run: options.run,
    ref: options.ref,
    trigger: options.trigger,
    testRun,
    at,
  });
  if (options.dryRun) console.log(`dry run: ${events.length} PostHog events and the page not sent`);
  // The iterate project in PostHog EU, as the CI telemetry sync reports to it.
  else
    await sendPostHogEvents(events, {
      apiKey: z.string().parse(osEnvs.prd?.posthogProjectKey),
      host: "https://eu.i.posthog.com",
    });
  if (broken.length > 0)
    throw new Error(
      `the latency probe is broken:\n${broken.map((line) => `  ${line}`).join("\n")}`,
    );
}

function format(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

if (isMainModule(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      report: { type: "string" },
      state: { type: "string" },
      "state-out": { type: "string" },
      run: { type: "string" },
      ref: { type: "string" },
      trigger: { type: "string" },
      "budget-scale": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const done =
    positionals[0] === "previous-state" && values.out
      ? saveNewestArtifactFile({ ...stateArtifact, out: values.out }).then(console.log)
      : positionals[0] === "judge" && values.report && values.run && values.ref && values.trigger
        ? judge({
            report: values.report,
            state: values.state,
            stateOut: values["state-out"],
            run: values.run,
            ref: values.ref,
            trigger: values.trigger,
            budgetScale: z.coerce
              .number()
              .positive()
              .parse(values["budget-scale"] || "1"),
            dryRun: values["dry-run"],
          })
        : Promise.reject(
            new Error(
              "usage: os-latency-guard.ts previous-state --out <file> | judge --report <file> --run <id> --ref <ref> --trigger <event> [--state <file>] [--state-out <file>] [--budget-scale <n>] [--dry-run]",
            ),
          );
  done.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
