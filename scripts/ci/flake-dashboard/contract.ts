import { FlakeSuiteSummary } from "@iterate-com/shared/test-support/flake-suite-summary";
import { z } from "zod";

export const flakeEventTypes = {
  created: "events.iterate.com/flakes/created",
  runRecorded: "events.iterate.com/flakes/run-recorded",
  transitionProposed: "events.iterate.com/flakes/transition-proposed",
} as const;

const StreamOffset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * One test outcome. Mirrors `FlakeRecord` in
 * `@iterate-com/shared/test-support/flake-record` — the wrappers and the
 * telemetry reporters write these lines to `FLAKE_RECORD_DIR` and CI ships
 * them here verbatim.
 */
const FlakeOutcome = z.enum([
  "pass",
  "flake-fail",
  "unexpected-error",
  "pinned-fail",
  "unexpected-pass",
  "retried-pass",
]);

/**
 * Which wrapper (or reporter) produced a record: createFlake, createFailing,
 * or the telemetry reporters' records for plain tests nobody has classified
 * yet (retried-pass when a retry rescued one, unexpected-error when it failed
 * every attempt).
 */
const FlakeKind = z.enum(["flake", "failing", "unknown"]);

export const FlakeRecord = z.object({
  name: z.string().min(1).max(1_000),
  kind: FlakeKind,
  outcome: FlakeOutcome,
  // Optional: kind "unknown" records carry error samples instead of a pattern.
  pattern: z.string().min(1).max(2_000).optional(),
  durationMs: z.number().nonnegative(),
  at: z.string().min(1),
  error: z.string().max(4_000).optional(),
});

const FlakeDashboardConfig = z.object({
  repository: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  issueTitle: z.string().min(1).max(200),
  defaultBranch: z.string().min(1),
});

export const FlakeRunRecorded = z.object({
  runId: z.string().min(1).max(200),
  suite: z.string().min(1).max(200),
  branch: z.string().min(1).max(500),
  commit: z.string().min(1).max(100),
  records: z.array(FlakeRecord).max(10_000),
  // An artifact without suite-summary.json (e.g. a cancelled run) has records only; it cannot
  // certify a complete suite.
  summary: FlakeSuiteSummary.optional(),
});

const MainSuiteRun = z.object({
  runId: z.string(),
  commit: z.string(),
  summary: FlakeSuiteSummary,
});

const FlakeTransition = z.enum(["unwrap", "switch-to-failing", "unwrap-failing"]);

export const FlakeTransitionProposed = z.object({
  testName: z.string().min(1),
  transition: FlakeTransition,
  evidence: z.object({
    consecutiveRuns: z.number().int().positive(),
    firstAt: z.string().min(1),
    lastAt: z.string().min(1),
  }),
});

/**
 * A run of consecutive same-outcome recorded runs on the default branch.
 * `unexpected-error` outcomes and outcome changes reset it. The streak is the
 * whole input to transition proposals, so it lives in reduced state rather
 * than being recomputed from history.
 */
const DefaultBranchStreak = z.object({
  // Any outcome except unexpected-error, which resets the streak instead.
  outcome: FlakeOutcome,
  runs: z.number().int().positive(),
  firstAt: z.string().min(1),
  lastAt: z.string().min(1),
});

const TrackedTest = z.object({
  /** Latest record's kind wins: adopting an unknown flake into createFlake migrates its row. */
  kind: FlakeKind.default("flake"),
  /** Empty for kind "unknown" — those rows show error samples instead. */
  pattern: z.string().default(""),
  suites: z.array(z.string()).default([]),
  /**
   * Per suite, the offset of the newest run-recorded event (any branch) whose
   * records included this test. Compared against the suite's
   * `recentRunOffsets` window at render time: a test absent from all of its
   * suite's last few ingested runs is retired from the table — hidden, not
   * deleted, so a transient absence self-heals on the next record.
   */
  lastSeenOffset: z.record(z.string(), StreamOffset).default({}),
  /**
   * The latest (up to) 10 outcomes on any branch, ordered by test time — the
   * render's emoji streak bar, each entry carrying the commit that produced
   * it so the square can link straight to that commit's checks. All branches,
   * like the counts, for debugging PR failures too. The numeric
   * defaultBranchStreak below stays main-only and carries the
   * transition-threshold counts past what 10 entries can show.
   */
  recent: z
    .array(z.object({ outcome: FlakeOutcome, commit: z.string().min(1).max(100), at: z.string() }))
    .max(10)
    .default([]),
  /** Keyed by outcome value ("pass", "pinned-fail", …). */
  counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /**
   * The last few error samples worth showing (retried-pass and
   * unexpected-error records) — for unknown flakes these are the copy-paste
   * material for the createFlake pattern.
   */
  recentErrors: z
    .array(z.object({ error: z.string().max(4_000), commit: z.string(), at: z.string() }))
    .max(3)
    .default([]),
  lastFlakeAt: z.string().nullable().default(null),
  firstRecordedAt: z.string(),
  lastRecordedAt: z.string(),
  defaultBranchStreak: DefaultBranchStreak.nullable().default(null),
  /** Older retry evidence cannot undo a wrapper observed on main in this suite. */
  lastMainWrapperAt: z.record(z.string(), z.string()).default({}),
  /**
   * One entry per proposal already made, keyed `${transition}:${streak.firstAt}`
   * — a streak proposes at most once however long it grows.
   */
  proposed: z.array(z.string()).default([]),
});

export const FlakeDashboardState = z.object({
  birthCertificate: z.object({ config: FlakeDashboardConfig }).nullable().default(null),
  tests: z.record(z.string(), TrackedTest).default({}),
  /**
   * Main-only unknowns, isolated by suite. Healthy rows are hidden, retaining
   * their streak so late failures can correct an apparent recovery.
   */
  unknownFlakes: z
    .record(
      z.string(),
      z.record(
        z.string(),
        z.object({
          record: FlakeRecord,
          passStreak: z.number().int().nonnegative(),
          /** Newest run that actually contained this test, including skips. */
          lastRunAt: z.string(),
          recent: z
            .array(z.object({ outcome: FlakeOutcome, commit: z.string(), at: z.string() }))
            .max(10),
        }),
      ),
    )
    .default({}),
  mainRuns: z
    .record(
      z.string(),
      z.object({
        latest: MainSuiteRun,
        complete: MainSuiteRun.nullable(),
        // The last full test list; mainRuns snapshots strip per-test lists (fold.ts), so this
        // carries it forward.
        inventory: z
          .object({ startedAt: z.iso.datetime(), names: z.array(z.string()) })
          .nullable()
          .default(null),
      }),
    )
    .default({}),
  /**
   * The newest three ingested results across all branches retire absent
   * tracked tests. This preserves visibility during partial PR runs. Unknown
   * flakes retire after 20 main passes, wrapper adoption, or proven absence
   * from their suite's full main inventory.
   */
  suites: z
    .record(z.string(), z.object({ recentRunOffsets: z.array(StreamOffset).max(3).default([]) }))
    .default({}),
  /**
   * The Cost section, per suite (fold.ts `foldRunCost`): the start of each of its last
   * COST_RUNS complete runs, and each row's samples from those runs. A sample is
   * [run start (epoch ms), duration ms, marginal wall ms, retried, failed, on the default
   * branch], taken only when the row ran 10 s or longer, ended the run, retried or failed.
   * A failed attempt 8 or more rows of one run share, retried or not, is an incident, never a row's
   * retry or failure.
   */
  costs: z
    .record(
      z.string(),
      z.object({
        runs: z.array(z.number().int()),
        rows: z.record(
          z.string(),
          z.object({
            tags: z.array(z.string()),
            samples: z.array(
              z.tuple([z.number(), z.number(), z.number(), z.boolean(), z.boolean(), z.boolean()]),
            ),
          }),
        ),
        incidents: z.array(
          z.object({ at: z.number().int(), error: z.string(), rows: z.number().int() }),
        ),
      }),
    )
    .default({}),
  /** Offset of the newest reduced event (created / run-recorded / transition-proposed). */
  lastDataOffset: StreamOffset.default(0),
});

/**
 * Suggest unwrapping createFlake after 20 consecutive main passes, regardless
 * of elapsed time. Unknown flakes retire automatically at the same count.
 * Propose createFailing after 25 matched failures over >=2 days.
 * Tunable constants. Sentinel tests are excluded from proposals entirely —
 * they are designed to flake.
 */
export const flakeTransitionThresholds = {
  unwrap: { runs: 20, minSpanMs: 0 },
  "switch-to-failing": { runs: 25, minSpanMs: 2 * 24 * 60 * 60 * 1000 },
  // A pin that keeps passing unexpectedly looks fixed: propose deleting the
  // createFailing wrapper after a sustained streak.
  "unwrap-failing": { runs: 10, minSpanMs: 2 * 24 * 60 * 60 * 1000 },
} as const;

/**
 * The facts the fold consumes, in the order the writer ingested them. On the
 * legacy platform these were `/flakes` stream events and `offset` was the
 * stream offset; the writer keeps the same numbering in its saved state.
 */
export type FlakeDashboardEvent =
  | {
      type: typeof flakeEventTypes.created;
      offset: number;
      payload: { config: z.infer<typeof FlakeDashboardConfig> };
    }
  | {
      type: typeof flakeEventTypes.runRecorded;
      offset: number;
      payload: z.infer<typeof FlakeRunRecorded>;
    }
  | {
      type: typeof flakeEventTypes.transitionProposed;
      offset: number;
      payload: z.infer<typeof FlakeTransitionProposed>;
    };

export type FlakeDashboardState = z.infer<typeof FlakeDashboardState>;
export type FlakeRecord = z.infer<typeof FlakeRecord>;
