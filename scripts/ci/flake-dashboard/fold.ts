// THE FLAKE DASHBOARD'S FOLD, ported from the legacy platform's flake-dashboard starter app
// (packages/iterate/src/starter-apps/flake-dashboard/worker.ts, deleted in #2837): the reducer, the
// transition proposal rule, the artifact parser, the issue renderer and the zip reader are that
// app's code. The platform's Durable Object, processor host and itx GitHub integration are gone;
// ./update.ts is the scheduled writer that feeds this fold from Depot artifacts and writes #2580.
import type { z } from "zod";
import {
  FlakeRecord,
  FlakeSuiteSummary,
  flakeEventTypes,
  flakeTransitionThresholds,
  FlakeDashboardState,
  type FlakeDashboardEvent,
  type FlakeRunRecorded,
  type FlakeTransitionProposed,
} from "./contract.ts";

/** Artifacts named `flake-records-<suite>` carry one suite's records and summary. */
export const ARTIFACT_PREFIX = "flake-records-";

/** The first line of the issue body: the marker, not the title, is authority. */
export const DASHBOARD_MARKER = "<!-- iterate-flake-dashboard -->";

/**
 * Fold one fact into the dashboard state — the legacy processor's `reduce`, event for event.
 */
export function reduceFlakeDashboard(
  state: FlakeDashboardState,
  event: FlakeDashboardEvent,
): FlakeDashboardState {
  switch (event.type) {
    case flakeEventTypes.created:
      if (state.birthCertificate) return state;
      return { ...state, birthCertificate: event.payload, lastDataOffset: event.offset };

    case flakeEventTypes.runRecorded: {
      const config = state.birthCertificate?.config;
      if (!config) return state;
      const onDefaultBranch = event.payload.branch === config.defaultBranch;
      const { summary, suite, runId, commit, records } = event.payload;
      const tests = { ...state.tests };
      for (const record of event.payload.records) {
        const existing = tests[record.name];
        const runAt = summary?.startedAt || record.at;
        const wrapperAt = existing?.lastMainWrapperAt[suite];
        const unknownAt = state.unknownFlakes[suite]?.[record.name]?.lastRunAt;
        const staleKind =
          existing &&
          onDefaultBranch &&
          (record.kind === "unknown"
            ? wrapperAt && runAt < wrapperAt
            : unknownAt && runAt < unknownAt);
        const kind = staleKind ? existing.kind : record.kind;
        const counts = { ...existing?.counts };
        counts[record.outcome] = (counts[record.outcome] || 0) + 1;
        const streak = existing?.defaultBranchStreak || null;
        const nextStreak =
          !onDefaultBranch || staleKind
            ? streak
            : record.outcome === "unexpected-error"
              ? null
              : streak && streak.outcome === record.outcome
                ? { ...streak, runs: streak.runs + 1, lastAt: record.at }
                : { outcome: record.outcome, runs: 1, firstAt: record.at, lastAt: record.at };
        const flakeStruck = record.outcome === "flake-fail" || record.outcome === "retried-pass";
        // Error samples worth keeping: an unknown flake's evidence, or an
        // unexpected error anywhere. A matched flake-fail / pinned-fail is
        // already described by the pattern.
        const errorSample =
          record.error &&
          (record.outcome === "retried-pass" || record.outcome === "unexpected-error")
            ? { error: record.error, commit: event.payload.commit, at: record.at }
            : null;
        tests[record.name] = {
          kind,
          pattern: staleKind ? existing.pattern : record.pattern || existing?.pattern || "",
          suites: existing?.suites.includes(event.payload.suite)
            ? existing.suites
            : [...(existing?.suites || []), event.payload.suite],
          lastSeenOffset: { ...existing?.lastSeenOffset, [event.payload.suite]: event.offset },
          recent: [
            ...(existing?.recent || []),
            { outcome: record.outcome, commit: event.payload.commit, at: record.at },
          ]
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            .slice(-10),
          counts,
          recentErrors: errorSample
            ? [...(existing?.recentErrors || []), errorSample]
                .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
                .slice(-3)
            : existing?.recentErrors || [],
          lastFlakeAt:
            flakeStruck &&
            (!existing?.lastFlakeAt || Date.parse(record.at) > Date.parse(existing.lastFlakeAt))
              ? record.at
              : existing?.lastFlakeAt || null,
          // Dates the test's CURRENT kind (Failures render it as "pinned
          // since"): a flake that later becomes a pin restarts the clock.
          firstRecordedAt:
            existing && existing.kind === kind ? existing.firstRecordedAt : record.at,
          lastRecordedAt:
            existing && Date.parse(existing.lastRecordedAt) > Date.parse(record.at)
              ? existing.lastRecordedAt
              : record.at,
          defaultBranchStreak: nextStreak,
          lastMainWrapperAt:
            onDefaultBranch && record.kind !== "unknown"
              ? {
                  ...existing?.lastMainWrapperAt,
                  [suite]: wrapperAt && wrapperAt > runAt ? wrapperAt : runAt,
                }
              : existing?.lastMainWrapperAt || {},
          proposed: existing?.proposed || [],
        };
      }
      const suites = {
        ...state.suites,
        [event.payload.suite]: {
          recentRunOffsets: [
            ...(state.suites[event.payload.suite]?.recentRunOffsets || []),
            ...((
              event.payload.summary
                ? event.payload.summary.status === "complete"
                : event.payload.records.length > 0
            )
              ? [event.offset]
              : []),
          ].slice(-3),
        },
      };
      const mainRuns = { ...state.mainRuns };
      const previousInventory = mainRuns[suite]?.inventory || null;
      const inventory =
        onDefaultBranch &&
        summary?.status === "complete" &&
        summary.tests &&
        (!previousInventory || summary.startedAt >= previousInventory.startedAt)
          ? {
              startedAt: summary.startedAt,
              names: [...new Set(summary.tests.map((test) => test.name))],
            }
          : previousInventory;
      const unknownFlakes = { ...state.unknownFlakes };
      if (onDefaultBranch) {
        const unknowns = { ...unknownFlakes[suite] };
        const recordedNames = new Set(records.map((record) => record.name));
        const results = new Map<string, "pass" | "fail" | "skip">();
        for (const test of summary?.tests || []) {
          // A shared title across projects/workspaces gets one vote per run.
          // Every instance must pass; any failure breaks the streak.
          const previous = results.get(test.name);
          results.set(
            test.name,
            previous === "fail" || test.outcome === "fail"
              ? "fail"
              : previous === "skip" || test.outcome === "skip"
                ? "skip"
                : "pass",
          );
        }
        if (summary) {
          for (const [name, test] of Object.entries(unknowns)) {
            if (recordedNames.has(name)) continue;
            const wrapperAt = tests[name]?.lastMainWrapperAt[suite];
            if (wrapperAt && summary.startedAt < wrapperAt) continue;
            const outcome = results.get(name);
            if (!outcome) continue;
            const pass = outcome === "pass" && summary.status === "complete";
            const fail = outcome === "fail";
            // Late passes cannot advance a streak. Late failures still break
            // it: a newer incomplete result is not evidence of recovery.
            if (!fail && summary.startedAt <= test.lastRunAt) continue;
            const passStreak = fail ? 0 : test.passStreak + Number(pass);
            unknowns[name] = {
              ...test,
              passStreak,
              lastRunAt: summary.startedAt > test.lastRunAt ? summary.startedAt : test.lastRunAt,
              recent:
                pass || fail
                  ? test.recent
                      .concat({
                        outcome: pass ? "pass" : "unexpected-error",
                        commit,
                        at: summary.startedAt,
                      })
                      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
                      .slice(-10)
                  : test.recent,
            };
          }
        }
        for (const record of records) {
          const previous = unknowns[record.name];
          const lastRunAt = summary?.startedAt || record.at;
          const wrapperAt = tests[record.name]?.lastMainWrapperAt[suite];
          if (record.kind === "unknown" && wrapperAt && lastRunAt < wrapperAt) continue;
          if (record.kind !== "unknown") {
            if (previous && lastRunAt <= previous.lastRunAt) continue;
            // Wrapping the test on main moves it to Flakes/Failures.
            delete unknowns[record.name];
            continue;
          }
          // A retry is evidence even if the rest of its suite was interrupted.
          unknowns[record.name] = {
            record:
              previous && Date.parse(previous.record.at) > Date.parse(record.at)
                ? previous.record
                : record,
            passStreak: 0,
            lastRunAt: previous && previous.lastRunAt > lastRunAt ? previous.lastRunAt : lastRunAt,
            recent: [
              ...(previous?.recent || []),
              { outcome: record.outcome, commit, at: record.at },
            ]
              .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
              .slice(-10),
          };
        }
        if (inventory) {
          const names = new Set(inventory.names);
          for (const [name, test] of Object.entries(unknowns)) {
            // A newer observation can reintroduce a deleted test. An older
            // delayed retry cannot undo its absence from a full main run.
            if (test.lastRunAt <= inventory.startedAt && !names.has(name)) delete unknowns[name];
          }
        }
        unknownFlakes[suite] = unknowns;
      }
      if (onDefaultBranch && summary) {
        const previous = mainRuns[suite];
        // Per-test evidence is folded above; don't duplicate it in snapshots.
        const incoming = { runId, commit, summary: { ...summary, tests: undefined } };
        mainRuns[suite] = {
          inventory,
          latest:
            !previous || summary.startedAt >= previous.latest.summary.startedAt
              ? incoming
              : previous.latest,
          complete:
            summary.status === "complete" &&
            (!previous?.complete || summary.startedAt >= previous.complete.summary.startedAt)
              ? incoming
              : previous?.complete || null,
        };
      }
      return { ...state, tests, suites, mainRuns, unknownFlakes, lastDataOffset: event.offset };
    }

    case flakeEventTypes.transitionProposed: {
      const test = state.tests[event.payload.testName];
      if (!test) return { ...state, lastDataOffset: event.offset };
      const marker = `${event.payload.transition}:${event.payload.evidence.firstAt}`;
      return {
        ...state,
        tests: {
          ...state.tests,
          [event.payload.testName]: {
            ...test,
            proposed: test.proposed.includes(marker) ? test.proposed : [...test.proposed, marker],
          },
        },
        lastDataOffset: event.offset,
      };
    }
  }
}

/**
 * The lifecycle proposals a folded run-recorded fact makes due — the legacy processor's
 * processEvent, which appended each as a `transition-proposed` event. The caller folds them in the
 * same way, so a streak proposes at most once however long it grows.
 */
export function proposeFlakeTransitions(
  state: FlakeDashboardState,
): z.infer<typeof FlakeTransitionProposed>[] {
  const proposals: z.infer<typeof FlakeTransitionProposed>[] = [];
  for (const [testName, test] of Object.entries(state.tests)) {
    // Sentinels are designed to flake: their streaks prove the pipeline
    // works and must never propose lifecycle changes.
    if (isSentinel(testName)) continue;
    const streak = test.defaultBranchStreak;
    if (!streak) continue;
    const transition =
      streak.outcome === "pass"
        ? "unwrap"
        : streak.outcome === "flake-fail"
          ? "switch-to-failing"
          : streak.outcome === "unexpected-pass"
            ? "unwrap-failing"
            : null;
    if (!transition) continue;
    const threshold = flakeTransitionThresholds[transition];
    const spanMs = Date.parse(streak.lastAt) - Date.parse(streak.firstAt);
    if (streak.runs < threshold.runs || spanMs < threshold.minSpanMs) continue;
    const marker = `${transition}:${streak.firstAt}`;
    // The streak's firstAt keys the proposal: as the streak keeps growing, later runs re-derive the
    // same marker, which the fold has already recorded — one proposal per streak.
    if (test.proposed.includes(marker)) continue;
    proposals.push({
      testName,
      transition,
      evidence: {
        consecutiveRuns: streak.runs,
        firstAt: streak.firstAt,
        lastAt: streak.lastAt,
      },
    });
  }
  return proposals;
}

/** A fold and the offset its next fact takes: what the writer keeps between runs. */
export type FlakeDashboardFold = { state: FlakeDashboardState; nextOffset: number };

/** A new dashboard: the legacy app's birth certificate, folded at offset 0. */
export function startFlakeDashboard(repository: {
  owner: string;
  repo: string;
}): FlakeDashboardFold {
  return {
    state: reduceFlakeDashboard(FlakeDashboardState.parse({}), {
      type: flakeEventTypes.created,
      offset: 0,
      payload: { config: { repository, issueTitle: "Flake dashboard", defaultBranch: "main" } },
    }),
    nextOffset: 1,
  };
}

/**
 * Fold run-recorded facts in order, each followed by the proposals it made due — the order the
 * legacy `/flakes` stream held them in.
 */
export function foldFlakeRuns(
  fold: FlakeDashboardFold,
  runs: z.infer<typeof FlakeRunRecorded>[],
): FlakeDashboardFold {
  let { state, nextOffset } = fold;
  for (const payload of runs) {
    state = reduceFlakeDashboard(state, {
      type: flakeEventTypes.runRecorded,
      offset: nextOffset++,
      payload,
    });
    for (const proposal of proposeFlakeTransitions(state)) {
      state = reduceFlakeDashboard(state, {
        type: flakeEventTypes.transitionProposed,
        offset: nextOffset++,
        payload: proposal,
      });
    }
  }
  return { state, nextOffset };
}

/**
 * One downloaded `flake-records-<suite>` artifact as the run-recorded fact the legacy ingestion
 * appended: every valid record, the suite summary, and a torn record or a count mismatch downgrading
 * the summary to incomplete. `undefined` when the artifact carries neither records nor a summary,
 * or its summary cannot be trusted.
 */
export async function runRecordedFromArtifact(input: {
  zip: Uint8Array;
  runId: string;
  suite: string;
  /** Used only when the artifact has no summary to name its own branch and commit. */
  branch: string;
  commit: string;
}): Promise<z.infer<typeof FlakeRunRecorded> | undefined> {
  const { runId, suite } = input;
  const files = await unzip(input.zip);
  const malformedRecords: string[] = [];
  const records = Object.entries(files)
    .filter(([name]) => name.endsWith(".jsonl"))
    .flatMap(([name, bytes]) =>
      new TextDecoder()
        .decode(bytes)
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
          // Keep valid history, but a torn record prevents a clean snapshot.
          let json: unknown;
          try {
            json = JSON.parse(line);
          } catch {
            malformedRecords.push(`Malformed record in ${name}`);
            return [];
          }
          const parsed = FlakeRecord.safeParse(json);
          if (!parsed.success) {
            malformedRecords.push(`Malformed record in ${name}`);
            return [];
          }
          return [parsed.data];
        }),
    );
  const summaryBytes = Object.entries(files).find(
    ([name]) => name === "suite-summary.json" || name.endsWith("/suite-summary.json"),
  )?.[1];
  let summary: z.infer<typeof FlakeSuiteSummary> | undefined;
  if (summaryBytes) {
    try {
      summary = FlakeSuiteSummary.parse(JSON.parse(new TextDecoder().decode(summaryBytes)));
    } catch {
      // Its provenance and test inventory cannot be trusted. Keep the
      // previous suite state and continue ingesting independent artifacts.
      console.error(
        `[flake-ingest] invalid suite-summary.json in ${ARTIFACT_PREFIX}${suite}; skipping artifact`,
      );
      return undefined;
    }
  }
  if (
    summary &&
    summary.unknownFlakeCount !== records.filter((record) => record.kind === "unknown").length
  ) {
    malformedRecords.push("Unknown flake records do not match the full runner result");
  }
  if (summary?.tests && summary.tests.length !== summary.testCount) {
    malformedRecords.push("Per-test results do not match the full runner test count");
  }
  if (summary && malformedRecords.length > 0) {
    summary.status = "incomplete";
    summary.diagnostics.push(...new Set(malformedRecords));
  }
  if (records.length === 0 && !summary) return undefined;
  return {
    runId,
    suite,
    branch: summary ? summary.branch : input.branch,
    commit: summary ? summary.headSha : input.commit,
    records,
    summary,
  };
}

// One map across kinds, honest per section: green = the expected thing
// happened (a pass, or a pin passing unexpectedly — worth a look), red = the
// tracked failure struck (a flake, a held pin, a retried-pass), ❌ = an
// unexpected error that proves nothing.
const OUTCOME_EMOJI = {
  pass: "🟩",
  "unexpected-pass": "🟩",
  "flake-fail": "🟥",
  "pinned-fail": "🟥",
  "retried-pass": "🟥",
  "unexpected-error": "❌",
} as const;

/**
 * The deliberate canary flakes are identified by naming convention — every
 * suite's sentinel test contains this phrase ("flake sentinel",
 * "flake sentinel (specs)", …). A convention beats a record flag: it needs no
 * wire-format field and holds for all historical records.
 */
function isSentinel(testName: string): boolean {
  return testName.includes("flake sentinel");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 4, 7:16am" (UTC) — ISO timestamps read like log spam in the table. */
function shortDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hours = date.getUTCHours();
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${hours % 12 || 12}:${minutes}${hours >= 12 ? "pm" : "am"}`;
}

/** Exported for tests: the table is a pure projection of folded state. */
export function renderBody(state: FlakeDashboardState): string {
  const tests = Object.entries(state.tests).sort(([a], [b]) => a.localeCompare(b));
  const lastRecordedAt = [
    ...tests.map(([, test]) => test.lastRecordedAt),
    ...Object.values(state.mainRuns).map((result) => result.latest.summary.finishedAt),
  ]
    .sort()
    .at(-1);
  // Tracked tests remain visible while present in the last three ingested
  // results for their suite. Unknowns use their main pass streaks below.
  // History remains in the event log and folded counts after a row disappears.
  const tracked = tests.filter(([, test]) => test.kind !== "unknown");
  const visible = tracked.filter(([, test]) =>
    Object.entries(test.lastSeenOffset).some(([suite, seen]) => {
      const windowStart = state.suites[suite]?.recentRunOffsets[0];
      return windowStart === undefined || seen >= windowStart;
    }),
  );
  const retiredCount = tracked.length - visible.length;
  const config = state.birthCertificate?.config;

  const count = (test: (typeof tests)[number][1], outcome: string) => test.counts[outcome] || 0;
  const row = ([name, test]: (typeof tests)[number]) => {
    const runs = Object.values(test.counts).reduce((total, n) => total + n, 0);
    // Lines inside a cell are <br>-separated; a literal | or backtick in a
    // pattern or error would end the cell or the code span, and a raw newline
    // (playwright timeout messages carry a call log) would split the table
    // row — so all three render collapsed/escaped.
    const pattern = `/${test.pattern}/`
      .replaceAll(/\s+/gu, " ")
      .replaceAll("`", "'")
      .replaceAll("|", "\\|");
    const info = [
      `pattern: \`${pattern}\``,
      `suites: ${test.suites.join(", ")}`,
      ...(test.proposed.length === 0
        ? []
        : [`proposed: ${test.proposed.map((p) => p.split(":")[0]).join(", ")}`]),
    ].join("<br>");
    const gated = count(test, "pass") + count(test, "flake-fail");
    const stats = (
      test.kind === "failing"
        ? [
            `runs: ${runs}`,
            `pin held: ${count(test, "pinned-fail")}`,
            `unexpected passes: ${count(test, "unexpected-pass")}`,
            `pinned since: ${shortDate(test.firstRecordedAt)}`,
          ]
        : [
            `runs: ${runs}`,
            `flake rate: ${gated === 0 ? "—" : `${Math.round((count(test, "flake-fail") / gated) * 100)}%`}`,
            `last flake: ${test.lastFlakeAt ? shortDate(test.lastFlakeAt) : "never"}`,
          ]
    ).join("<br>");
    // Tests only exist after birth, so config is always set here; the plain
    // emoji fallback keeps the render total rather than throwing over a link.
    const squares = test.recent
      .map((entry) => {
        const emoji = OUTCOME_EMOJI[entry.outcome];
        if (!config) return emoji;
        const { owner, repo } = config.repository;
        return `[${emoji}](https://github.com/${owner}/${repo}/commit/${entry.commit})`;
      })
      .join("");
    const streak = [
      squares || "—",
      ...(!test.defaultBranchStreak || !config
        ? []
        : [
            `${test.defaultBranchStreak.runs}× ${test.defaultBranchStreak.outcome} (${config.defaultBranch})`,
          ]),
    ].join("<br>");
    return [`\`${name}\``, info, stats, streak].join(" | ");
  };

  const sections = [
    {
      title: "Flakes",
      legend: `_createFlake-wrapped: 🟩 passed · 🟥 the known flake struck · ❌ failed differently than expected. Suggest removing the wrapper after ${flakeTransitionThresholds.unwrap.runs} consecutive main passes, with no minimum elapsed time._`,
      tests: visible.filter(([name, test]) => test.kind === "flake" && !isSentinel(name)),
    },
    {
      title: "Failures",
      legend:
        "_createFailing pins: 🟥 the pinned bug is present · 🟩 passed unexpectedly — the bug may be fixed · ❌ failed differently than expected._",
      tests: visible.filter(([, test]) => test.kind === "failing"),
    },
    {
      title: "Sentinels",
      legend:
        "_Deliberate canary flakes proving the recording pipeline works: 🟩 passed · 🟥 the known flake struck · ❌ failed differently than expected._",
      tests: visible.filter(([name, test]) => test.kind === "flake" && isSentinel(name)),
    },
  ].filter((section) => section.tests.length > 0);

  return [
    DASHBOARD_MARKER,
    "Test health, folded from CI-reported runs: [`createFlake`](https://github.com/iterate/iterate/blob/main/packages/shared/src/test-support/flake-test.ts) wraps, [`createFailing`](https://github.com/iterate/iterate/blob/main/packages/shared/src/test-support/failing-test.ts) pins, and unclassified flaky tests caught by CI retries. Maintained automatically — edits to this body will be overwritten. Squares show the last 10 outcomes, oldest→newest, and link to their commits. Wrapped tests show all branches; unknown flakes show main only. Lifecycle streak counts use main only.",
    ...sections.filter((section) => section.title !== "Sentinels").flatMap(renderSection),
    ...renderUnknownFlakes(state),
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
    for (const [, test] of section.tests) {
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

function renderUnknownFlakes(state: FlakeDashboardState): string[] {
  const suites = [
    ...new Set([...Object.keys(state.suites), ...Object.keys(state.mainRuns)]),
  ].sort();
  const escape = (text: string) =>
    text.replaceAll(/\s+/gu, " ").replaceAll(/([\\`*_[\]|<>])/gu, "\\$1");
  const rows = suites.flatMap((suite) =>
    Object.entries(state.unknownFlakes[suite] || {})
      .filter(([, test]) => test.passStreak < flakeTransitionThresholds.unwrap.runs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, test]) => {
        const record = test.record;
        const config = state.birthCertificate!.config;
        const squares = test.recent
          .map(
            ({ outcome, commit }) =>
              `[${OUTCOME_EMOJI[outcome]}](https://github.com/${config.repository.owner}/${config.repository.repo}/commit/${commit})`,
          )
          .join("");
        return [
          escape(record.name),
          `\`${(record.error || "No error sample recorded").replaceAll(/\s+/gu, " ").replaceAll("`", "'").replaceAll("|", "\\|").slice(0, 300)}\``,
          escape(suite),
          `${squares}<br>${test.passStreak}/${flakeTransitionThresholds.unwrap.runs} consecutive passes`,
        ].join(" | ");
      }),
  );
  const completeCount = suites.filter((suite) => state.mainRuns[suite]?.complete).length;
  return [
    "",
    "## Unknown flakes",
    "",
    `_Any main retry adds a test here. Remove it after ${flakeTransitionThresholds.unwrap.runs} consecutive main passes, wrapper adoption, or absence from a complete main run's full test list. Failures reset the streak. Skips and incomplete results cannot advance it or prove deletion. 🟩 passed · 🟥 needed a retry · ❌ failed. PR results do not affect this table._`,
    "",
    ...suites.map((suite) => {
      const result = state.mainRuns[suite];
      if (!result) return `- **${escape(suite)}:** awaiting a complete main result.`;
      const complete = result.complete;
      const incomplete =
        result.latest.summary.status === "incomplete"
          ? ` Latest attempt [${result.latest.commit.slice(0, 7)}](${result.latest.summary.runUrl}) incomplete: ${escape(result.latest.summary.diagnostics.join("; "))}.`
          : "";
      if (!complete) return `- **${escape(suite)}:** awaiting a complete main result.${incomplete}`;
      return `- **${escape(suite)}:** [${complete.commit.slice(0, 7)}](${complete.summary.runUrl}) · ${shortDate(complete.summary.finishedAt)} UTC · ${complete.summary.testCount} tests · ${complete.summary.failedCount} failed.${incomplete}`;
    }),
    "",
    ...(rows.length > 0
      ? ["test | first failure | suite | streak (main)", "--- | --- | --- | ---", ...rows]
      : [
          completeCount === 0
            ? "_Awaiting the first complete main results._"
            : "_No active unknown flakes. Passing streaks are evidence of stability, not proof that the root cause is fixed._",
        ]),
  ];
}

/**
 * Minimal zip reader on the runtime's own DecompressionStream — deliberately
 * not a dependency. The format surface is narrow by construction: one
 * producer (GitHub's artifact service), a 5MB size cap upstream, and reading
 * via the central directory (sizes come from there, so streaming-writer data
 * descriptors don't matter). No zip64 — impossible under the size cap — and
 * anything unexpected throws, which ingestion treats as a logged drop.
 */
export async function unzip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits at the tail, behind an optional
  // comment (max 64KB): scan backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const entryCount = view.getUint16(eocd + 10, true);
  const files: Record<string, Uint8Array> = {};
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("corrupt zip: bad central directory entry signature");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    // The local header's name/extra lengths can differ from the central
    // directory's, so the data offset comes from the local header itself.
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    // slice (not subarray): a copy backed by a plain ArrayBuffer, which both
    // the DOM and Workers Response typings accept without assertions.
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    if (method === 0) {
      files[name] = data;
    } else if (method === 8) {
      const inflated = new Response(data).body!.pipeThrough(new DecompressionStream("deflate-raw"));
      files[name] = new Uint8Array(await new Response(inflated).arrayBuffer());
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
