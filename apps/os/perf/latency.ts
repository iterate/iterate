// perf/latency.ts — THE LATENCY GUARD'S LINES: every metric the perf lane records, what one sample of
// it is, the statistic a run is judged by, and the budget that statistic must stay on the right side
// of — with the measurements each budget came from. The perf rows record through perf/record.ts and
// hold themselves to these budgets (a local `pnpm perf`, the soak); the scheduled guard
// (scripts/latency-guard.ts, .depot/workflows/os-latency.yml) judges every run against the same
// budgets AND against its own rolling baseline, and pages #error-pulse. Pure: no vitest, no I/O.
//
// A budget sits ~3× above what main measured, and above the slowest run seen, so the platform's normal
// variance never crosses it: a crossing is a regression, not weather. The judged statistic is the
// median for a handful of samples (one stall moves one sample, a regression moves them all) and p95
// only where a run has dozens (concurrent project creation). Calibration: `pnpm perf` against a
// throwaway preview of main 3b6b1c8b0, 5 runs from a laptop in London and <CI> runs from Depot, on
// 2026-09-24; each row names the judged statistic's range across those runs.

export const LATENCY_METRICS = {
  // ── concurrent project creation (perf/project-creation.perf.test.ts) ──
  "project.create.x1.answered": {
    sample: "one person's projects.create answered, one person at a time",
    unit: "ms",
    judged: "p50",
    budget: 3_000,
    calibration: "",
  },
  "project.create.x1.ready": {
    sample: "one person's project ready (its project/created certificate), one person at a time",
    unit: "ms",
    judged: "p50",
    budget: 15_000,
    calibration: "",
  },
  "project.create.x10.answered": {
    sample: "one person's projects.create answered, 10 people at once",
    unit: "ms",
    judged: "p95",
    budget: 5_000,
    calibration: "",
  },
  "project.create.x10.ready": {
    sample: "one person's project ready, 10 people at once",
    unit: "ms",
    judged: "p50",
    budget: 15_000,
    calibration: "",
  },
  "project.create.x10.all-ready": {
    sample: "a round of 10 at once, until the last project is ready",
    unit: "ms",
    judged: "p50",
    budget: 40_000,
    calibration: "",
  },
  "project.create.x25.answered": {
    sample: "one person's projects.create answered, 25 people at once",
    unit: "ms",
    judged: "p95",
    budget: 5_000,
    calibration: "",
  },
  "project.create.x25.ready": {
    sample: "one person's project ready, 25 people at once",
    unit: "ms",
    judged: "p50",
    budget: 15_000,
    calibration: "",
  },
  "project.create.x25.all-ready": {
    sample: "a round of 25 at once, until the last project is ready",
    unit: "ms",
    judged: "p50",
    budget: 40_000,
    calibration: "",
  },
  // ── sign-in and MCP (perf/sign-in-and-mcp.perf.test.ts) ──
  "sign-in": {
    sample: "a new person's password sign-in (POST /login) answered with a session",
    unit: "ms",
    judged: "p50",
    budget: 6_000,
    calibration: "",
  },
  "mcp.call": {
    sample: "an MCP tools/call (the run tool, itx.whoami()) on a project, with a grant's bearer",
    unit: "ms",
    judged: "p50",
    budget: 500,
    calibration: "",
  },
  // ── contexts (perf/contexts.perf.test.ts) ──
  "context.first-append": {
    sample: "a context's first append, the context born by it",
    unit: "ms",
    judged: "p50",
    budget: 2_000,
    calibration: "",
  },
  "context.append": {
    sample: "a durable append on a warm context",
    unit: "ms",
    judged: "p50",
    budget: 200,
    calibration: "",
  },
  "context.wake": {
    sample: "the first call to a context the platform evicted after it sat idle",
    unit: "ms",
    judged: "p50",
    budget: 500,
    calibration: "",
  },
  "facet.cold-start": {
    sample: "a processor enabled on a fresh context until it reduced the first event",
    unit: "ms",
    judged: "p50",
    budget: 3_000,
    calibration: "",
  },
  // ── rule invocation (perf/rewrite-rules.perf.test.ts, rewrite-rules.e2e's budget until #2977) ──
  "rules.300.newest": {
    sample: "invoking the newest of 300 rewrite rules",
    unit: "ms",
    judged: "p50",
    budget: 150,
    calibration: "",
  },
  "rules.300.root": {
    sample: "invoking a built-in root (whoami) beside 300 rewrite rules",
    unit: "ms",
    judged: "p50",
    budget: 150,
    calibration: "",
  },
  // ── stream fan-out (perf/push-delivery.perf.test.ts, push-delivery.e2e's budgets until #2977) ──
  "push.flood.p50": {
    sample: "a flood round's median append→callback latency (2000 ephemerals, one subscriber)",
    unit: "ms",
    judged: "p50",
    budget: 500,
    calibration: "",
  },
  "push.flood.p95": {
    sample: "a flood round's p95 append→callback latency",
    unit: "ms",
    judged: "p50",
    budget: 1500,
    calibration: "",
  },
  "push.flood.throughput": {
    sample: "a flood round's events delivered per second, end to end",
    unit: "events/s",
    judged: "p50",
    budget: 1000,
    calibration: "",
  },
  "push.fan200.all": {
    sample: "one append until all 200 push subscribers have it",
    unit: "ms",
    judged: "p50",
    budget: 2000,
    calibration: "",
  },
  "push.fan200.whoami": {
    sample: "a whoami issued while one append fans out to 200 push subscribers",
    unit: "ms",
    judged: "p50",
    budget: 1500,
    calibration: "",
  },
  "push.fan50.all": {
    sample: "one append until all 50 userspace processors reduced it",
    unit: "ms",
    judged: "p50",
    budget: 5000,
    calibration: "",
  },
  "push.fan50.whoami": {
    sample: "a whoami issued while one append fans out to 50 processors",
    unit: "ms",
    judged: "p50",
    budget: 1500,
    calibration: "",
  },
} satisfies Record<
  string,
  {
    /** What one sample is. */
    sample: string;
    /** `events/s` is the one higher-is-better unit: its budget is a floor. */
    unit: "ms" | "events/s";
    /** The statistic of one run's samples that the budget and the baseline judge. */
    judged: "p50" | "p95";
    budget: number;
    /** The measurements the budget came from. */
    calibration: string;
  }
>;

export type LatencyMetricName = keyof typeof LATENCY_METRICS;

/** The first words of a perf row's budget miss (perf/record.ts): how the guard tells a missed budget,
 *  which it pages, from a broken probe, which fails its run. */
export const BUDGET_MISSED = "latency budget missed:";

/** One run's samples of a metric, as nearest-rank percentiles (index ⌊q·n⌋, as the perf rows always
 *  computed them: the p50 of 5 is the 3rd, the p95 of 75 the 72nd). */
export function summarize(samples: number[]) {
  if (samples.length === 0) throw new Error("a metric needs at least one sample");
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1)!, min: sorted[0]! };
}

/** Whether `value` (the judged statistic) is on the wrong side of `line`: above it, or below it for
 *  `events/s`. */
export function crosses(metric: LatencyMetricName, value: number, line: number) {
  return LATENCY_METRICS[metric].unit === "events/s" ? value < line : value > line;
}

/** The budget, scaled toward breaching by `scale` < 1 (the dispatch's forced alert): a ceiling
 *  times `scale`, a floor divided by it. */
export function budgetLine(metric: LatencyMetricName, scale: number) {
  const { budget, unit } = LATENCY_METRICS[metric];
  return unit === "events/s" ? budget / scale : budget * scale;
}
