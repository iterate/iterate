// THE FLAKE DASHBOARD: issue #2580's body, computed from recent CI test runs' flake records and
// suite summaries (docs/testing.md#flakes-and-pinned-failures). ./evidence.ts reads the runs from
// R2 and ./update.ts writes the issue; this module is a pure function of the runs it is given, so
// each hourly run recomputes the whole body and nothing carries over between runs.
import type { z } from "zod";
import {
  E2E_ROW_BUDGET_MS,
  UNIT_ROW_WARN_EXEMPTIONS,
  UNIT_ROW_WARN_MS,
} from "@iterate-com/shared/test-support/e2e-policy";
import type { FlakeSuiteSummary } from "@iterate-com/shared/test-support/flake-suite-summary";
import { recentRuns, type FlakeRecord, type SuiteRun } from "./evidence.ts";

/** The first line of the issue body: the marker, not the title, is authority. */
export const DASHBOARD_MARKER = "<!-- iterate-flake-dashboard -->";

/**
 * The lifecycle proposals, each from a wrapped test's streak of same-outcome main runs: unwrap a
 * createFlake test after 20 passes, whatever the time they took; switch one to createFailing after
 * 25 matched failures over two days or more; delete a createFailing pin that passed 10 times over
 * two days or more. An unknown flake leaves the dashboard after as many passes as an unwrap needs.
 * Sentinels, which are designed to flake, never propose.
 */
const transitionThresholds = {
  unwrap: { outcome: "pass", runs: 20, minSpanMs: 0 },
  "switch-to-failing": { outcome: "flake-fail", runs: 25, minSpanMs: 2 * 24 * 60 * 60 * 1000 },
  "unwrap-failing": { outcome: "unexpected-pass", runs: 10, minSpanMs: 2 * 24 * 60 * 60 * 1000 },
} as const;

export function renderDashboard(runs: SuiteRun[], repository: { owner: string; repo: string }) {
  const ordered = runs.toSorted((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  const square = (entry: { outcome: FlakeRecord["outcome"]; commit?: string }) =>
    entry.commit
      ? `[${OUTCOME_EMOJI[entry.outcome]}](https://github.com/${repository.owner}/${repository.repo}/commit/${entry.commit})`
      : OUTCOME_EMOJI[entry.outcome];
  const tests = wrappedTests(ordered);
  const visible = tests.filter((test) => test.visible);
  const retiredCount = tests.length - visible.length;
  const lastRecordedAt = [
    ...ordered.flatMap((run) => run.records.map((record) => record.at)),
    ...ordered.flatMap((run) => (run.main && run.summary ? [run.summary.finishedAt] : [])),
  ]
    .sort()
    .at(-1);

  const row = (test: (typeof tests)[number]) => {
    const count = (outcome: FlakeRecord["outcome"]) =>
      test.main.filter((record) => record.outcome === outcome).length;
    // Lines inside a cell are <br>-separated; a literal | or backtick in a pattern would end the
    // cell or the code span, and a raw newline would split the table row, so all three are
    // collapsed or escaped.
    const pattern = `/${test.pattern}/`
      .replaceAll(/\s+/gu, " ")
      .replaceAll("`", "'")
      .replaceAll("|", "\\|");
    const info = [
      `pattern: \`${pattern}\``,
      `suites: ${test.suites.join(", ")}`,
      ...(test.transition ? [`proposed: ${test.transition}`] : []),
    ].join("<br>");
    const gated = count("pass") + count("flake-fail");
    const lastFlake = test.main.findLast((record) => record.outcome === "flake-fail");
    const stats = (
      test.kind === "failing"
        ? [
            `runs: ${test.main.length}`,
            `pin held: ${count("pinned-fail")}`,
            `unexpected passes: ${count("unexpected-pass")}`,
            `pinned since: ${shortDate(test.since)}`,
          ]
        : [
            `runs: ${test.main.length}`,
            `flake rate: ${gated === 0 ? "—" : `${Math.round((count("flake-fail") / gated) * 100)}%`}`,
            `last flake: ${lastFlake ? shortDate(lastFlake.at) : "never"}`,
          ]
    ).join("<br>");
    const streak = [
      test.recent.map(square).join("") || "—",
      ...(test.streak ? [`${test.streak.runs}× ${test.streak.outcome} (main)`] : []),
    ].join("<br>");
    return [`\`${test.name}\``, info, stats, streak].join(" | ");
  };

  const sections = [
    {
      title: "Flakes",
      legend: `_createFlake-wrapped: 🟩 passed · 🟥 the known flake struck · ❌ failed differently than expected. Suggest removing the wrapper after ${transitionThresholds.unwrap.runs} consecutive main passes, with no minimum elapsed time._`,
      tests: visible.filter((test) => test.kind === "flake" && !isSentinel(test.name)),
    },
    {
      title: "Failures",
      legend:
        "_createFailing pins: 🟥 the pinned bug is present · 🟩 passed unexpectedly — the bug may be fixed · ❌ failed differently than expected._",
      tests: visible.filter((test) => test.kind === "failing"),
    },
    {
      title: "Sentinels",
      legend:
        "_Deliberate canary flakes proving the recording pipeline works: 🟩 passed · 🟥 the known flake struck · ❌ failed differently than expected._",
      tests: visible.filter((test) => test.kind === "flake" && isSentinel(test.name)),
    },
  ].filter((section) => section.tests.length > 0);

  return [
    DASHBOARD_MARKER,
    `Test health, computed every hour from the flake records CI's test runs keep in R2: [\`createFlake\`](https://github.com/iterate/iterate/blob/main/packages/shared/src/test-support/flake-test.ts) wraps, [\`createFailing\`](https://github.com/iterate/iterate/blob/main/packages/shared/src/test-support/failing-test.ts) pins, and plain tests that needed a CI retry or failed. Maintained automatically — edits to this body will be overwritten. Squares show the last 10 outcomes on any branch, oldest→newest, and link to their commits. Stats and lifecycle streaks count main's runs of the last ${recentRuns.mainDays} days; unknown flakes show main only.`,
    ...sections.filter((section) => section.title !== "Sentinels").flatMap(renderSection),
    ...renderUnknownFlakes(ordered, square),
    ...renderCost(ordered),
    ...sections.filter((section) => section.title === "Sentinels").flatMap(renderSection),
    "",
    `_Last recorded outcome: ${lastRecordedAt || "none"}._`,
    ...(retiredCount === 0
      ? []
      : [
          `_${retiredCount} retired ${retiredCount === 1 ? "test" : "tests"} hidden (absent from the last 3 runs of their suite)._`,
        ]),
  ].join("\n");

  function renderSection(section: (typeof sections)[number]) {
    const collapsed = section.title === "Failures" || section.title === "Sentinels";
    const suiteCounts = new Map<string, number>();
    for (const test of section.tests) {
      for (const suite of test.suites) suiteCounts.set(suite, (suiteCounts.get(suite) || 0) + 1);
    }
    const summary = [
      `${section.tests.length} ${section.tests.length === 1 ? "test" : "tests"}`,
      ...[...suiteCounts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([suite, count]) => `${suite}: ${count}`),
    ].join(" · ");
    return [
      "",
      `## ${section.title}`,
      "",
      ...(collapsed ? ["<details>", `<summary>${summary}</summary>`, ""] : []),
      section.legend,
      "",
      "test | info | stats | streak",
      "--- | --- | --- | ---",
      ...section.tests.map(row),
      ...(collapsed ? ["", "</details>"] : []),
    ];
  }
}

/**
 * Every createFlake and createFailing test the runs recorded, by name. Its newest record's kind is
 * its kind, and only records of that kind count, so a flake switched to a pin starts afresh; a test
 * whose newest record is a plain test's (kind "unknown") has lost its wrapper and has no row here.
 * A test stays visible while it appears in any of its suites' last three complete runs: a deleted
 * or renamed test's row retires, and an incomplete run cannot retire one.
 */
function wrappedTests(runs: SuiteRun[]) {
  const shownSince = new Map<string, string>();
  for (const suite of new Set(runs.map((run) => run.suite))) {
    const complete = runs.filter(
      (run) => run.suite === suite && run.summary?.status === "complete",
    );
    const since = complete.slice(-3)[0]?.uploadedAt;
    if (since) shownSince.set(suite, since);
  }
  const observed = new Map<
    string,
    (FlakeRecord & { suite: string; main: boolean; commit?: string; runAt: string })[]
  >();
  for (const run of runs)
    for (const record of run.records)
      observed.set(record.name, [
        ...(observed.get(record.name) || []),
        {
          ...record,
          suite: run.suite,
          main: run.main,
          commit: run.summary?.headSha,
          runAt: run.uploadedAt,
        },
      ]);
  return [...observed]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, all]) => {
      const sorted = all.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const newest = sorted.at(-1)!;
      if (newest.kind === "unknown") return [];
      const records = sorted.filter((record) => record.kind === newest.kind);
      const main = records.filter((record) => record.main);
      const suites = [...new Set(records.map((record) => record.suite))];
      const streak = mainStreak(main);
      const transition = Object.entries(transitionThresholds).find(
        ([, threshold]) =>
          !isSentinel(name) &&
          streak?.outcome === threshold.outcome &&
          streak.runs >= threshold.runs &&
          Date.parse(streak.lastAt) - Date.parse(streak.firstAt) >= threshold.minSpanMs,
      )?.[0];
      return [
        {
          name,
          kind: newest.kind,
          pattern: newest.pattern || "",
          suites,
          main,
          recent: records.slice(-10),
          since: records[0]!.at,
          streak,
          transition,
          visible: suites.some((suite) => {
            const since = shownSince.get(suite);
            return (
              !since || records.some((record) => record.suite === suite && record.runAt >= since)
            );
          }),
        },
      ];
    });
}

/**
 * The newest main records' shared outcome and how many in a row share it. An unexpected error,
 * which proves nothing, has no streak.
 */
function mainStreak(main: FlakeRecord[]) {
  const last = main.at(-1);
  if (!last || last.outcome === "unexpected-error") return undefined;
  let first = main.length - 1;
  while (first > 0 && main[first - 1]!.outcome === last.outcome) first--;
  return {
    outcome: last.outcome,
    runs: main.length - first,
    firstAt: main[first]!.at,
    lastAt: last.at,
  };
}

/**
 * The plain tests that needed a retry or failed outright on main, per suite. A row lasts until its
 * test passes `transitionThresholds.unwrap.runs` complete main runs after its last failure, a
 * wrapper adopts it on main, or a complete main run's test list no longer holds it. A skip or an
 * incomplete run neither advances nor ends it.
 */
function renderUnknownFlakes(
  runs: SuiteRun[],
  square: (entry: { outcome: FlakeRecord["outcome"]; commit?: string }) => string,
) {
  const passesToLeave = transitionThresholds.unwrap.runs;
  const suites = [...new Set(runs.map((run) => run.suite))].sort();
  const escape = (text: string) =>
    text.replaceAll(/\s+/gu, " ").replaceAll(/([\\`*_[\]|<>])/gu, "\\$1");
  const perSuite = suites.map((suite) => {
    const main = runs.filter((run) => run.main && run.suite === suite);
    const summaries = main.flatMap((run) => (run.summary ? [run.summary] : []));
    const latest = summaries.at(-1);
    const complete = summaries.findLast((summary) => summary.status === "complete");
    const incomplete =
      latest?.status === "incomplete"
        ? ` Latest attempt [${latest.headSha.slice(0, 7)}](${latest.runUrl}) incomplete: ${escape(latest.diagnostics.join("; "))}.`
        : "";
    const names = new Set(
      main.flatMap((run) =>
        run.records.filter((record) => record.kind === "unknown").map((record) => record.name),
      ),
    );
    const rows = [...names].sort().flatMap((name) => {
      const history = main.map((run) => ({
        run,
        unknown: run.records
          .filter((record) => record.name === name && record.kind === "unknown")
          .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)),
        wrapped: run.records.some((record) => record.name === name && record.kind !== "unknown"),
        outcome: run.summary && summaryOutcome(run.summary, name),
      }));
      const lastFailure = history.findLastIndex(
        (entry) => entry.unknown.length > 0 || entry.outcome === "fail",
      );
      const after = history.slice(lastFailure + 1);
      if (after.some((entry) => entry.wrapped)) return [];
      const inventory = after.findLast((entry) => entry.run.summary?.status === "complete");
      if (inventory && !inventory.outcome) return [];
      const passes = after.filter(
        (entry) => entry.run.summary?.status === "complete" && entry.outcome === "pass",
      ).length;
      if (passes >= passesToLeave) return [];
      const squares = history
        .slice(history.findIndex((entry) => entry.unknown.length > 0))
        .flatMap(({ run, unknown, outcome }) => {
          const commit = run.summary?.headSha;
          if (unknown.length > 0)
            return unknown.map((record) => ({ outcome: record.outcome, commit }));
          if (outcome === "fail") return [{ outcome: "unexpected-error" as const, commit }];
          if (outcome === "pass" && run.summary?.status === "complete")
            return [{ outcome: "pass" as const, commit }];
          return [];
        })
        .slice(-10);
      const record = history.flatMap((entry) => entry.unknown).at(-1)!;
      return [
        [
          escape(name),
          `\`${(record.error || "No error sample recorded").replaceAll(/\s+/gu, " ").replaceAll("`", "'").replaceAll("|", "\\|").slice(0, 300)}\``,
          escape(suite),
          `${squares.map(square).join("")}<br>${passes}/${passesToLeave} consecutive passes`,
        ].join(" | "),
      ];
    });
    return {
      complete: !!complete,
      rows,
      status: complete
        ? `- **${escape(suite)}:** [${complete.headSha.slice(0, 7)}](${complete.runUrl}) · ${shortDate(complete.finishedAt)} UTC · ${complete.testCount} tests · ${complete.failedCount} failed.${incomplete}`
        : `- **${escape(suite)}:** awaiting a complete main result.${incomplete}`,
    };
  });
  const rows = perSuite.flatMap((suite) => suite.rows);
  return [
    "",
    "## Unknown flakes",
    "",
    `_A plain test that needed a retry or failed outright on main is added here. Remove it after ${passesToLeave} consecutive main passes, wrapper adoption, or absence from a complete main run's full test list. Failures reset the streak. Skips and incomplete results cannot advance it or prove deletion. 🟩 passed · 🟥 needed a retry · ❌ failed. PR results do not affect this table._`,
    "",
    ...perSuite.map((suite) => suite.status),
    "",
    ...(rows.length > 0
      ? ["test | first failure | suite | streak (main)", "--- | --- | --- | ---", ...rows]
      : [
          perSuite.every((suite) => !suite.complete)
            ? "_Awaiting the first complete main results._"
            : "_No active unknown flakes. Passing streaks are evidence of stability, not proof that the root cause is fixed._",
        ]),
  ];
}

/**
 * One run's verdict on a test: a title shared across projects passes only if every instance did.
 */
function summaryOutcome(summary: z.infer<typeof FlakeSuiteSummary>, name: string) {
  const outcomes = summary.tests.filter((test) => test.name === name).map((test) => test.outcome);
  if (outcomes.length === 0) return undefined;
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.includes("skip")) return "skip";
  return "pass";
}

/** The suites the Cost section prices: the ones a row budget covers (docs/testing.md#the-row-budget). */
const COST_SUITES = ["preview-e2e", "unit"];
/** The Cost section's window: each suite's last this many complete runs. */
const COST_RUNS = 100;
/** A row is sampled in a run when it ran this long, ended the run, retried or failed. */
const COST_SAMPLE_FLOOR_MS = 10_000;
/**
 * A failed attempt this many rows of one run share, retried or not, is one incident: not a retry or
 * failure of each row.
 */
const INCIDENT_ROWS = 8;
/** A marginal wall this long at the median proposes the row, like a p95 past its budget. */
const COST_MARGINAL_BUDGET_MS = 10_000;

/**
 * Each priced suite's last COST_RUNS complete runs among its newest on any branch: per row, a sample from each run in which it
 * ran at least COST_SAMPLE_FLOOR_MS, ended the run, retried or failed, and one incident for each
 * failure that INCIDENT_ROWS or more of a run's rows share. The marginal wall is how much sooner
 * the run would have ended without the row: the last row's lead over the next, zero for every
 * other row. That is exact for a suite whose rows all run at once (e2e), and a floor where rows
 * queue for workers.
 */
function suiteCosts(runs: SuiteRun[]) {
  return COST_SUITES.flatMap((suite) => {
    const complete = runs
      .flatMap((run) =>
        run.suite === suite &&
        run.newest &&
        run.summary?.status === "complete" &&
        run.summary.tests.some((test) => test.durationMs !== undefined)
          ? [{ ...run.summary, main: run.main }]
          : [],
      )
      .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(-COST_RUNS);
    if (complete.length === 0) return [];
    const rows = new Map<
      string,
      {
        tags: string[];
        samples: {
          durationMs: number;
          marginalMs: number;
          retried: boolean;
          failed: boolean;
          main: boolean;
        }[];
      }
    >();
    const incidents: { at: string; error: string; rows: number }[] = [];
    for (const run of complete) {
      const ends = run.tests
        .flatMap((test) =>
          test.startMs === undefined || test.durationMs === undefined
            ? []
            : [test.startMs + test.durationMs],
        )
        .sort((a, b) => b - a);
      const [lastEnd = 0, nextEnd = 0] = ends;
      const sharedErrors = new Map<string, number>();
      for (const test of run.tests)
        if (test.error) {
          const error = incidentError(test.error);
          sharedErrors.set(error, (sharedErrors.get(error) || 0) + 1);
        }
      const runIncidents = [...sharedErrors].filter(([, count]) => count >= INCIDENT_ROWS);
      incidents.push(
        ...runIncidents.map(([error, count]) => ({ at: run.startedAt, error, rows: count })),
      );
      for (const test of run.tests) {
        if (test.durationMs === undefined) continue;
        const end = test.startMs === undefined ? undefined : test.startMs + test.durationMs;
        const marginalMs = end === lastEnd ? lastEnd - nextEnd : 0;
        const incident =
          !!test.error && runIncidents.some(([error]) => error === incidentError(test.error!));
        const retried = !incident && !!test.retries;
        const failed = !incident && !!test.failed;
        if (test.durationMs < COST_SAMPLE_FLOOR_MS && !marginalMs && !retried && !failed) continue;
        rows.set(test.name, {
          tags: test.tags || [],
          samples: [
            ...(rows.get(test.name)?.samples || []),
            { durationMs: test.durationMs, marginalMs, retried, failed, main: run.main },
          ],
        });
      }
    }
    return [{ suite, runs: complete.length, since: complete[0]!.startedAt, rows, incidents }];
  });
}

/** A failure message with its numbers and ids blanked, so one incident's rows share it. */
function incidentError(error: string) {
  return error
    .replaceAll(/\b[0-9a-f]{8,}\b/giu, "…")
    .replaceAll(/\d+/gu, "#")
    .replaceAll(/\s+/gu, " ")
    .slice(0, 120);
}

/**
 * Where each suite's time goes: its 15 costliest rows over its last COST_RUNS complete runs, with
 * what the row budget proposes for each (docs/testing.md#the-row-budget).
 */
function renderCost(runs: SuiteRun[]) {
  const suites = suiteCosts(runs).filter((cost) => cost.rows.size > 0);
  if (suites.length === 0) return [];
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const floor = `< ${seconds(COST_SAMPLE_FLOOR_MS)}`;
  const escape = (text: string) =>
    text.replaceAll(/\s+/gu, " ").replaceAll(/([\\`*_[\]|<>])/gu, "\\$1");
  return [
    "",
    "## Cost",
    "",
    `_Where each suite's time goes, over its last ${COST_RUNS} complete runs on any branch. A row is sampled in a run when it ran ${seconds(COST_SAMPLE_FLOOR_MS)} or longer, ended the run, retried or failed; the percentiles count the runs it was not sampled in as under ${seconds(COST_SAMPLE_FLOOR_MS)}. **Marginal** is how much sooner the run would have ended without the row, at the median. A failure ${INCIDENT_ROWS} or more rows of one run share is one incident, not a failure of each row. A row past its budget at p95 (preview-e2e ${seconds(E2E_ROW_BUDGET_MS)}, unit ${seconds(UNIT_ROW_WARN_MS)}), or with ${seconds(COST_MARGINAL_BUDGET_MS)} of marginal wall, is proposed: make it faster, or in preview-e2e tag it \`slow\`. An exempt unit row is only ever made faster. A proposal to delete a row must name the coverage that replaces it. [The row budget](https://github.com/iterate/iterate/blob/main/docs/testing.md#the-row-budget)._`,
    ...suites.flatMap(({ suite, runs: runCount, since, rows, incidents }) => {
      // Nearest rank over every run in the window, the unsampled ones below the floor.
      const quantile = (values: number[], p: number) => {
        const index = Math.ceil(p * runCount) - 1 - (runCount - values.length);
        if (index < 0) return undefined;
        return values.toSorted((a, b) => a - b)[Math.min(index, values.length - 1)];
      };
      const budgetMs = suite === "unit" ? UNIT_ROW_WARN_MS : E2E_ROW_BUDGET_MS;
      const lines = [...rows].map(([name, row]) => {
        const durations = row.samples.map((sample) => sample.durationMs);
        const p95 = quantile(durations, 0.95) || 0;
        const marginal = quantile(
          row.samples.map((sample) => sample.marginalMs),
          0.5,
        );
        const exempt = suite === "unit" && !!UNIT_ROW_WARN_EXEMPTIONS[name];
        const overBudget = p95 > budgetMs || (marginal || 0) >= COST_MARGINAL_BUDGET_MS;
        const proposal = row.tags.includes("slow")
          ? "tagged `slow`"
          : exempt
            ? "exempt"
            : !overBudget
              ? "—"
              : suite === "unit"
                ? "make faster"
                : "make faster, or tag `slow`";
        const p50 = quantile(durations, 0.5);
        return {
          marginal: marginal || 0,
          p95,
          line: [
            escape(name),
            p50 ? seconds(p50) : floor,
            p95 ? seconds(p95) : floor,
            marginal ? seconds(marginal) : "—",
            row.samples.filter((sample) => sample.retried).length,
            row.samples.filter((sample) => sample.failed && !sample.main).length,
            proposal,
          ].join(" | "),
        };
      });
      const worst = incidents.toSorted((a, b) => b.rows - a.rows);
      return [
        "",
        `### ${escape(suite)}: ${runCount} run${runCount === 1 ? "" : "s"} since ${shortDate(since)} UTC · ${worst.length} incident${worst.length === 1 ? "" : "s"}`,
        "",
        "row | p50 | p95 | marginal | retries | PR failures | proposal",
        "--- | --- | --- | --- | --- | --- | ---",
        ...lines
          .sort((a, b) => b.marginal - a.marginal || b.p95 - a.p95)
          .slice(0, 15)
          .map((line) => line.line),
        ...worst
          .slice(0, 5)
          .map(
            (incident) =>
              `- incident, ${shortDate(incident.at)} UTC: ${incident.rows} rows failed an attempt with \`${incident.error.replaceAll("`", "'").replaceAll("|", "\\|")}\``,
          ),
      ];
    }),
  ];
}

// One map across kinds, honest per section: green = the expected thing happened (a pass, or a pin
// passing unexpectedly — worth a look), red = the tracked failure struck (a flake, a held pin, a
// retried-pass), ❌ = an unexpected error that proves nothing.
const OUTCOME_EMOJI = {
  pass: "🟩",
  "unexpected-pass": "🟩",
  "flake-fail": "🟥",
  "pinned-fail": "🟥",
  "retried-pass": "🟥",
  "unexpected-error": "❌",
} as const;

/**
 * The deliberate canary flakes are identified by naming convention: every suite's sentinel test
 * contains this phrase ("flake sentinel", "flake sentinel (specs)", …), which needs no field in the
 * record.
 */
function isSentinel(testName: string) {
  return testName.includes("flake sentinel");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 4, 7:16am" (UTC): ISO timestamps read like log spam in the table. */
function shortDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hours = date.getUTCHours();
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${hours % 12 || 12}:${minutes}${hours >= 12 ? "pm" : "am"}`;
}
