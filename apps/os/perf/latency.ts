// perf/latency.ts — THE LATENCY GUARD'S LINES: every metric the perf suite records, what one sample of
// it is, and the budget its median must stay on the right side of — with the measurements each
// budget came from. The perf rows record through perf/record.ts and
// hold themselves to these budgets (a local `pnpm perf`, the soak); the scheduled guard
// (scripts/ci/os-latency-guard.ts, .depot/workflows/os-latency.yml) judges every run against the
// same budgets AND against its own rolling baseline, and pages #error-pulse. Pure: no vitest, no I/O.
//
// A run is judged by each metric's MEDIAN — of a row's rounds, or of the projects in a concurrent
// round: one stall moves one sample, a regression moves them all. The p95 and max go to PostHog
// beside it (a p95 of 30 samples is their second slowest: a run-to-run spread of 2–3× on one commit).
// A budget sits at least twice as high as the slowest run of the calibration, so the platform's
// normal variance never crosses it: a crossing is a regression, not weather. CALIBRATION,
// 2026-09-24, the worker of main bd7f3f91b: `pnpm perf` against a fresh throwaway preview per run,
// 5 runs from a laptop in London and 3 from Depot (the guard's own workflow, dispatched);
// `calibration` is the judged median's range in ms (events/s for the rate) across each set. The
// push and rule budgets are the e2e rows' own until #2977.

export const LATENCY_METRICS = {
  // ── concurrent project creation (perf/project-creation.perf.test.ts) ──
  "project.create.x1.answered": {
    sample: "one person's projects.create answered, one person at a time",
    unit: "ms",
    budget: 3_000,
    calibration: "laptop 977–1,074, Depot 895–1,038",
  },
  "project.create.x1.ready": {
    sample: "one person's project ready (its project/created certificate), one person at a time",
    unit: "ms",
    budget: 20_000,
    calibration: "laptop 3,819–6,055, Depot 6,864–8,249",
  },
  "project.create.x10.answered": {
    sample: "one person's projects.create answered, 10 people at once",
    unit: "ms",
    budget: 6_000,
    calibration: "laptop 1,016–1,125, Depot 966–2,430",
  },
  "project.create.x10.ready": {
    sample: "one person's project ready, 10 people at once",
    unit: "ms",
    budget: 20_000,
    calibration: "laptop 4,117–5,875, Depot 7,642–9,122",
  },
  "project.create.x10.all-ready": {
    sample: "a round of 10 at once, until the last project is ready",
    unit: "ms",
    budget: 45_000,
    calibration: "laptop 7,012–20,261, Depot 8,919–11,606",
  },
  "project.create.x25.answered": {
    sample: "one person's projects.create answered, 25 people at once",
    unit: "ms",
    budget: 5_000,
    calibration: "laptop 1,036–1,187, Depot 897–1,007",
  },
  "project.create.x25.ready": {
    sample: "one person's project ready, 25 people at once",
    unit: "ms",
    budget: 20_000,
    calibration: "laptop 4,597–5,276, Depot 7,247–7,530",
  },
  "project.create.x25.all-ready": {
    sample: "a round of 25 at once, until the last project is ready",
    unit: "ms",
    budget: 45_000,
    calibration: "laptop 8,059–21,187, Depot 9,542–11,161",
  },
  // ── sign-in and MCP (perf/sign-in-and-mcp.perf.test.ts) ──
  "sign-in": {
    sample: "a new person's password sign-in (POST /login) answered with a session",
    unit: "ms",
    budget: 6_000,
    calibration: "laptop 1,742–2,209, Depot 2,028–2,214",
  },
  "mcp.call": {
    sample: "an MCP tools/call (the run tool, itx.whoami()) on a project, with a grant's bearer",
    unit: "ms",
    budget: 500,
    calibration: "laptop 76.7–153, Depot 80.3–85.4",
  },
  // ── contexts (perf/contexts.perf.test.ts) ──
  "context.first-append": {
    sample: "a context's first append, the context born by it",
    unit: "ms",
    budget: 2_000,
    calibration: "laptop 417–557, Depot 310–520",
  },
  "context.append": {
    sample: "a durable append on a warm context",
    unit: "ms",
    budget: 250,
    calibration: "laptop 27.1–34, Depot 24.9–71.9",
  },
  "context.wake": {
    sample: "the first call to a context the platform evicted after it sat idle",
    unit: "ms",
    budget: 300,
    calibration: "laptop 39.3–47.2, Depot 36.8–57.2",
  },
  "facet.cold-start": {
    sample: "a processor enabled on a fresh context until it reduced the first event",
    unit: "ms",
    budget: 3_000,
    calibration: "laptop 389–935, Depot 403–569",
  },
  // ── rule invocation (perf/rewrite-rules.perf.test.ts, rewrite-rules.e2e's budget until #2977) ──
  "rules.300.newest": {
    sample: "invoking the newest of 300 rewrite rules",
    unit: "ms",
    budget: 150,
    calibration: "laptop 22.2–43.5, Depot 22–70",
  },
  "rules.300.root": {
    sample: "invoking a built-in root (whoami) beside 300 rewrite rules",
    unit: "ms",
    budget: 150,
    calibration: "laptop 20.9–39.1, Depot 21.6–70.2",
  },
  // ── stream fan-out (perf/push-delivery.perf.test.ts, push-delivery.e2e's budgets until #2977) ──
  "push.flood.p50": {
    sample: "a flood round's median append→callback latency (2000 ephemerals, one subscriber)",
    unit: "ms",
    budget: 500,
    calibration: "laptop 129–245, Depot 175–210",
  },
  "push.flood.p95": {
    sample: "a flood round's p95 append→callback latency",
    unit: "ms",
    budget: 1_500,
    calibration: "laptop 188–313, Depot 193–225",
  },
  "push.flood.throughput": {
    sample: "a flood round's events delivered per second, end to end",
    unit: "events/s",
    budget: 1_000,
    calibration: "laptop 5,988–10,101, Depot 6,349–7,968",
  },
  "push.fan200.all": {
    sample: "one append until all 200 push subscribers have it",
    unit: "ms",
    budget: 2_000,
    calibration: "laptop 180–236, Depot 221–316",
  },
  "push.fan200.whoami": {
    sample: "a whoami issued while one append fans out to 200 push subscribers",
    unit: "ms",
    budget: 1_500,
    calibration: "laptop 47.4–106, Depot 140–207",
  },
  "push.fan50.all": {
    sample: "one append until all 50 userspace processors reduced it",
    unit: "ms",
    budget: 5_000,
    calibration: "laptop 245–739, Depot 195–291",
  },
  "push.fan50.whoami": {
    sample: "a whoami issued while one append fans out to 50 processors",
    unit: "ms",
    budget: 1_500,
    calibration: "laptop 67.6–206, Depot 15–56.5",
  },
} satisfies Record<
  string,
  {
    /** What one sample is. */
    sample: string;
    /** `events/s` is the one higher-is-better unit: its budget is a floor. */
    unit: "ms" | "events/s";
    budget: number;
    /** The judged median's range in the calibration runs the budget came from. */
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

/** Whether `value` (a run's median) is on the wrong side of `line`: above it, or below it for
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
