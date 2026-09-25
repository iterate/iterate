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
// no row recorded, no report — unless the platform broke it (PLATFORM_FAILURES below): ONE row that
// a platform failure broke, and that did not break in the run before, is RECORDED — a warning, a
// line of the step summary and a PostHog event (`os latency probe broken`) — and the run stays green.
// The same probe broken two runs in a row, two probes broken in one run, or anything else, fails it.
// Recorded or red, every broken probe is on the step summary and in PostHog.
//
// The memory between runs is the previous main run's `os-latency-state` artifact (depot.ts
// `saveNewestArtifactFile`, `stateArtifact` below): the last 20 main runs' medians, what each
// crossed and which probes broke, and which metrics are red. A run off main, or with a budget scale (the dispatch's forced alert), is a TEST RUN: it
// pages whatever crossed in this run alone, marked 🧪 and mentioning nobody, and keeps no state.
//
//   pnpm tsx scripts/ci/os-latency-guard.ts previous-state --out <state.json>
//   pnpm tsx scripts/ci/os-latency-guard.ts judge --report <vitest.json> [--state <state.json>] \
//     [--state-out <next.json>] --run <id> --ref <git ref> --trigger <event> [--budget-scale 0.01] [--dry-run]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** What one run hands the next: the main runs it knows, oldest first, and the metrics paged red. */
export const GuardState = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(
    z.object({
      sha: z.string(),
      run: z.string(),
      at: z.iso.datetime(),
      /** Each measured metric's median. */
      judged: z.partialRecord(MetricName, z.number()),
      /** The measured metrics that crossed a line. */
      over: z.array(MetricName),
      /** The probes that broke, recorded or not: a probe broken again in the next run is red. */
      broken: z.array(z.string()),
    }),
  ),
  red: z.array(MetricName),
});
export type GuardState = z.infer<typeof GuardState>;

/** What a perf row leaves on its meta (apps/os/perf/record.ts `TaskMeta`): its samples, and, when
 *  it failed, the causes and lost sockets behind the failure (perf/setup.ts) and the push row's
 *  subscribe round trips. */
const RowMeta = z.object({
  latency: z.partialRecord(MetricName, z.array(z.number())).optional(),
  failure: z
    .object({
      causes: z.array(z.string()),
      socketsLost: z.array(
        z.object({
          openedAfterMs: z.number().optional(),
          failedAfterMs: z.number(),
          reason: z.string(),
        }),
      ),
    })
    .optional(),
  subscribeBatchMs: z.array(z.number()).optional(),
});
type RowMeta = z.infer<typeof RowMeta>;

/** The parts of Vitest's JSON report (`--reporter=json`) the guard reads: every row's status, its
 *  failure messages and what perf/record.ts left on its meta; a file that failed to load has a
 *  `failed` status and a message, and no rows. */
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
          meta: RowMeta.optional(),
        }),
      ),
    }),
  ),
});

/** THE PLATFORM'S FAILURES: what a row can break on only because Cloudflare, or the network between
 *  the runner and it, failed the row — never on anything our code decides. Each broke one row of a
 *  red main run, every budget fine, and the row was green on the next run. */
const PLATFORM_FAILURES = {
  /** undici's fetch rejects with exactly this only when no HTTP response came at all. Main
   *  927f7a835: `read ECONNRESET` on the MCP row's first call, and Workers Logs had no `/mcp`
   *  request from it. */
  "connection-reset": "a fetch got no HTTP response: the connection to the edge failed",
  /** capnweb's word for a socket that ended with no Close frame; our Worker closes one with a code
   *  and a reason ("Peer closed WebSocket: 3000 …"). Main 6c4bd2319: 3 of 5 sockets idle 15 s were
   *  lost on their next message, their invocations missing from Workers Logs, the account's other
   *  previews losing sockets in the same seconds. A crash of our own Worker looks the same from the
   *  client: the two-runs-in-a-row rule is what catches that. */
  "socket-lost": "a WebSocket ended with no Close frame: the edge dropped it",
  /** A wait for pushes that timed out while the row's own subscribes stalled past EDGE_STALL_MS
   *  (~0.1 s a batch normally). Main a8e6c6525: Cloudflare moved traffic out of IAD, every round
   *  trip between the edge and the Durable Object stalled ~3 s, and lends the pushes paged for came
   *  back past their 10 s timeout, the pushes lost (apps/os/src/context/rpc-stubs.ts). */
  "edge-stall": "pushes never came while the edge's round trips to the Durable Object stalled",
  /** workerd's DISCONNECTED failure, handed back through a session that stayed open: a Workers RPC
   *  connection under the call, from our Worker to a Durable Object or between two objects, was cut
   *  inside Cloudflare. Our code never throws it, and a reset of our own objects fails with a
   *  message of its own (apps/os/src/retryable-error.ts). The edge sends an idempotent call it cut
   *  once more (apps/os/src/iterate-context.ts `READ_CALLS`), so what reaches a row is a write, or
   *  a second cut. On 2026-09-25, 34 of 50 concurrent calls never reached a context whose
   *  incarnation, 50 facets and session all ran on. */
  "transport-cut": "a Workers RPC connection under the call was lost inside Cloudflare",
} as const;
export type PlatformFailure = keyof typeof PLATFORM_FAILURES;
/** A subscribe batch this slow, at the median, is the platform stalling: ~0.1 s normally, 3.0–3.2 s
 *  on 2026-09-24. */
const EDGE_STALL_MS = 1_000;

/** Which platform failure broke a row, from one of its failure messages (the error and its stack)
 *  and what the row left on its meta; undefined for any other failure. Pure. */
function platformFailure(message: string, meta: RowMeta | undefined): PlatformFailure | undefined {
  const firstLine = message.split("\n", 1)[0]!.trim();
  if (firstLine === "TypeError: fetch failed") return "connection-reset";
  if (firstLine === "Error: WebSocket connection failed.") return "socket-lost";
  if (firstLine === "Error: Network connection lost.") return "transport-cut";
  const subscribeBatchMs = meta?.subscribeBatchMs ?? [];
  if (
    firstLine.startsWith("Error: until(") &&
    subscribeBatchMs.length > 0 &&
    summarize(subscribeBatchMs).p50 >= EDGE_STALL_MS
  )
    return "edge-stall";
  return undefined;
}

/** One way the probe broke. */
export type BrokenProbe = {
  /** The row's full name, a file that did not load, or a metric no row recorded: the same probe
   *  names the same thing from run to run. */
  probe: string;
  /** Its failure's first line. */
  error: string;
  /** The platform failure that broke it, when that is all that did. */
  platform?: PlatformFailure;
  /** What the row reported beside its failure: its errors' causes, the sockets it lost, its
   *  subscribe round trips. */
  evidence?: string;
  /** The report file it is in: a metric no row recorded is this row's breakage when it is this
   *  file's (perf/latency.ts `file`). */
  file?: string;
};

/** Each metric's samples, and every way a row or file broke: a file that did not load, a row that
 *  failed for anything but a budget. Pure. */
export function readReport(report: z.infer<typeof VitestReport>) {
  const samples: Partial<Record<LatencyMetricName, number[]>> = {};
  const broken: BrokenProbe[] = [];
  for (const file of report.testResults) {
    if (file.status === "failed" && file.assertionResults.length === 0)
      broken.push({ probe: file.name, file: file.name, error: file.message || "failed to load" });
    for (const row of file.assertionResults) {
      Object.assign(samples, row.meta?.latency);
      const failures = (row.failureMessages || []).filter(
        (message) => !message.includes(BUDGET_MISSED),
      );
      const budgetOnly = failures.length === 0 && (row.failureMessages || []).length > 0;
      if (row.status !== "failed" || budgetOnly) continue;
      const platform = failures.map((message) => platformFailure(message, row.meta));
      broken.push({
        probe: row.fullName,
        file: file.name,
        error: failures[0]?.split("\n", 1)[0]!.trim() || row.status,
        platform: platform.every(Boolean) ? platform[0] : undefined,
        evidence: evidenceOf(row.meta),
      });
    }
  }
  return { samples, broken };
}

/** What a failed row reported beside its failure, in words, or undefined for nothing. Pure. */
function evidenceOf(meta: RowMeta | undefined) {
  const lost = meta?.failure?.socketsLost ?? [];
  const failedAfter = lost.map((socket) => socket.failedAfterMs);
  const neverOpened = lost.filter((socket) => socket.openedAfterMs === undefined).length;
  const parts = [
    meta?.failure?.causes.length && `caused by ${meta.failure.causes.join(" ← ")}`,
    lost.length &&
      `${lost.length} socket${lost.length === 1 ? "" : "s"} lost with no Close frame ${format(Math.min(...failedAfter))}–${format(Math.max(...failedAfter))} ms after the dial${neverOpened ? ` (${neverOpened} never opened)` : ""}`,
    meta?.subscribeBatchMs?.length &&
      `subscribe round trips ${meta.subscribeBatchMs.map(format).join(", ")} ms`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Every broken row and file, then every metric no row recorded — unless a row or file of its own
 *  perf file broke, which left it unrecorded: that is one breakage, not two. Pure. */
export function brokenProbes(broken: BrokenProbe[], readings: Reading[]): BrokenProbe[] {
  const unrecorded = readings
    .filter((reading) => reading.missing)
    .map((reading) => reading.metric)
    .filter(
      (metric) => !broken.some((probe) => probe.file?.endsWith(`/${LATENCY_METRICS[metric].file}`)),
    );
  return [...broken, ...unrecorded.map((metric) => ({ probe: metric, error: "not recorded" }))];
}

/** Each broken probe's verdict: RECORDED when it is the run's only broken probe, a platform failure
 *  broke it, and it did not break in the run before (`previous`, the last main run the state
 *  remembers); otherwise RED, `redBecause` saying why. Pure. */
export function judgeBroken(
  broken: BrokenProbe[],
  previous: GuardState["runs"][number] | undefined,
) {
  return broken.map((probe) => {
    const redBecause = !probe.platform
      ? "not a platform failure"
      : broken.length > 1
        ? `one of ${broken.length} broken probes in this run`
        : previous?.broken.includes(probe.probe)
          ? "broken in the run before too"
          : undefined;
    return { ...probe, redBecause };
  });
}
export type BrokenVerdict = ReturnType<typeof judgeBroken>[number];

/** A broken probe's line in the step summary and the log. Pure. */
export function brokenLine(probe: BrokenVerdict) {
  const what = [
    `${probe.probe}: ${probe.error}`,
    probe.platform && `${probe.platform}, ${PLATFORM_FAILURES[probe.platform]}`,
    probe.evidence,
  ]
    .filter(Boolean)
    .join(" — ");
  return probe.redBecause
    ? `RED, ${probe.redBecause}: ${what}`
    : `RECORDED, broken by the platform: ${what}. The run stays green; broken again in the next run, it is red.`;
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
export function rememberRun(
  readings: Reading[],
  run: { sha: string; run: string; at: string },
  broken: BrokenProbe[],
) {
  const measured = readings.filter((reading): reading is Measured => !reading.missing);
  return {
    ...run,
    judged: Object.fromEntries(measured.map((reading) => [reading.metric, reading.value])),
    over: measured.filter((reading) => reading.over).map((reading) => reading.metric),
    broken: broken.map((probe) => probe.probe),
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

type EventContext = {
  sha: string;
  run: string;
  ref: string;
  trigger: string;
  testRun: boolean;
  at: string;
};

/** One PostHog event per broken probe (`os latency probe broken`), recorded or red: how often the
 *  platform breaks which probe, and how. Deduplicated per run attempt. Pure. */
export function brokenEvents(broken: BrokenVerdict[], context: EventContext) {
  return broken.map((probe) =>
    systemEvent(
      "os latency probe broken",
      `os-latency:${context.run}:broken:${probe.probe}`,
      "os-latency-guard",
      {
        probe: probe.probe,
        error: probe.error,
        platform_failure: probe.platform || null,
        verdict: probe.redBecause ? "red" : "recorded",
        red_because: probe.redBecause || null,
        evidence: probe.evidence || null,
        sha: context.sha,
        run: context.run,
        ref: context.ref,
        trigger: context.trigger,
        test_run: context.testRun,
      },
      context.at,
    ),
  );
}

/** One PostHog event per measured metric and percentile (p50, p95, max): low-cardinality — the
 *  metric names are LATENCY_METRICS' — and deduplicated per run attempt. Pure. */
export function latencyEvents(readings: Reading[], context: EventContext) {
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

/** Judge one run of the perf suite: log every metric, page on a change of state, keep the state,
 *  send PostHog its events, and throw when the probe is broken in a way that turns the run red. */
export async function judge(options: {
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
    : {
        samples: {},
        broken: [{ probe: options.report, error: "no report: the perf suite did not run" }],
      };
  const readings = judgeRun({
    samples: report.samples,
    history: state.runs,
    scale: options.budgetScale,
  });
  const broken = judgeBroken(brokenProbes(report.broken, readings), state.runs.at(-1));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const subject = execFileSync("git", ["log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const at = new Date().toISOString();
  const run = rememberRun(readings, { sha, run: options.run, at }, broken);
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
      broken: broken.map(({ probe, platform, redBecause }) => ({ probe, platform, redBecause })),
    }),
  );
  if (page) console.log(`\n${page}\n`);
  else console.log("latency: no change of state, nothing to page");
  // Every broken probe on the job's summary, whatever its verdict, and a recorded one as a warning
  // too: nothing else marks its run.
  if (broken.length > 0 && process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Broken latency probes\n\n${broken.map((probe) => `- ${brokenLine(probe)}\n`).join("")}`,
    );
  for (const probe of broken)
    if (!probe.redBecause)
      console.log(
        `::warning title=Latency probe broken by the platform::${escapeData(brokenLine(probe))}`,
      );

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
  const context = {
    sha,
    run: options.run,
    ref: options.ref,
    trigger: options.trigger,
    testRun,
    at,
  };
  const events = [...latencyEvents(readings, context), ...brokenEvents(broken, context)];
  if (options.dryRun) console.log(`dry run: ${events.length} PostHog events and the page not sent`);
  // The iterate project in PostHog EU, as the CI telemetry sync reports to it.
  else
    await sendPostHogEvents(events, {
      apiKey: z.string().parse(osEnvs.prd?.posthogProjectKey),
      host: "https://eu.i.posthog.com",
    });
  const red = broken.filter((probe) => probe.redBecause);
  if (red.length > 0)
    throw new Error(
      `the latency probe is broken:\n${red.map((probe) => `  ${brokenLine(probe)}`).join("\n")}`,
    );
}

function format(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

/** A workflow command's data: its own `%` and line breaks escaped as the syntax asks. */
function escapeData(text: string) {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
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
