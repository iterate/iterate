// iterate-lint-disable terminology/no-metaphorical-lane-door-seam -- `lane` is this repo's established name for a CI test-execution category (TEST_TELEMETRY_LANE, docs/testing.md "test lanes"); renaming this field would fork that vocabulary
import { z } from "zod";
import { defineProcessorContract } from "../../processors/index.ts";

export const flakeEventTypes = {
  created: "events.iterate.com/flakes/created",
  runRecorded: "events.iterate.com/flakes/run-recorded",
  transitionProposed: "events.iterate.com/flakes/transition-proposed",
  dashboardRenderSettled: "events.iterate.com/flakes/dashboard-render-settled",
} as const;

const StreamOffset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * One `createFlake` test outcome. Mirrors `FlakeRecord` in
 * `@iterate-com/shared/test-support/flake-test` — the wrapper writes these
 * lines to `FLAKE_RECORD_DIR` and CI ships them here verbatim.
 */
export const FlakeRecord = z.object({
  name: z.string().min(1).max(1_000),
  outcome: z.enum(["pass", "flake-fail", "unexpected-error"]),
  pattern: z.string().min(1).max(2_000),
  durationMs: z.number().nonnegative(),
  at: z.string().min(1),
  error: z.string().max(4_000).optional(),
});

export const FlakeDashboardConfig = z.object({
  repository: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  issueTitle: z.string().min(1).max(200),
  defaultBranch: z.string().min(1),
});

const FlakeRunRecorded = z.object({
  runId: z.string().min(1).max(200),
  lane: z.string().min(1).max(200),
  branch: z.string().min(1).max(500),
  commit: z.string().min(1).max(100),
  records: z.array(FlakeRecord).min(1).max(10_000),
});

export const FlakeTransition = z.enum(["unwrap", "switch-to-failing"]);

const FlakeTransitionProposed = z.object({
  testName: z.string().min(1),
  transition: FlakeTransition,
  evidence: z.object({
    consecutiveRuns: z.number().int().positive(),
    firstAt: z.string().min(1),
    lastAt: z.string().min(1),
  }),
});

const FlakeDashboardRenderResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    issueNumber: z.number().int().positive(),
    issueUrl: z.string().url(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string().min(1).max(8_000),
  }),
]);

/**
 * A run of consecutive same-outcome recorded runs on the default branch.
 * `unexpected-error` outcomes and outcome changes reset it. The streak is the
 * whole input to transition proposals, so it lives in reduced state rather
 * than being recomputed from history.
 */
const DefaultBranchStreak = z.object({
  outcome: z.enum(["pass", "flake-fail"]),
  runs: z.number().int().positive(),
  firstAt: z.string().min(1),
  lastAt: z.string().min(1),
});

const TrackedTest = z.object({
  pattern: z.string(),
  lanes: z.array(z.string()).default([]),
  counts: z
    .object({
      pass: z.number().int().nonnegative().default(0),
      flakeFail: z.number().int().nonnegative().default(0),
      unexpectedError: z.number().int().nonnegative().default(0),
    })
    .default({ pass: 0, flakeFail: 0, unexpectedError: 0 }),
  lastFlakeAt: z.string().nullable().default(null),
  lastRecordedAt: z.string(),
  defaultBranchStreak: DefaultBranchStreak.nullable().default(null),
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
   * Offset of the newest reduced DATA event (created / run-recorded /
   * transition-proposed). Render settlements deliberately do not bump it —
   * that is what stops a settled render from demanding another render.
   */
  lastDataOffset: StreamOffset.default(0),
  render: z
    .object({
      throughOffset: StreamOffset,
      issueNumber: z.number().int().positive().nullable(),
      issueUrl: z.string().nullable(),
    })
    .nullable()
    .default(null),
});

/**
 * Thresholds for the data-provable lifecycle transitions (grilled decision:
 * unwrap after 50 consecutive default-branch passes over >=5 days; propose
 * `failing` after 25 consecutive matched failures over >=2 days). Tunable
 * constants; the ~10% sentinel false-unwraps with probability 0.9^50 ~= 0.5%.
 */
export const flakeTransitionThresholds = {
  unwrap: { runs: 50, minSpanMs: 5 * 24 * 60 * 60 * 1000 },
  "switch-to-failing": { runs: 25, minSpanMs: 2 * 24 * 60 * 60 * 1000 },
} as const;

export const FlakeDashboardProcessorContract = defineProcessorContract({
  slug: "flake-dashboard",
  version: "0.1.0",
  description:
    "Folds createFlake test outcomes reported by CI into per-test flake stats, renders the GitHub 'Flake dashboard' issue, and proposes data-provable lifecycle transitions.",
  stateSchema: FlakeDashboardState,
  events: {
    [flakeEventTypes.created]: {
      description:
        "The flake dashboard exists: target repository, issue title, and which branch counts for transitions.",
      payloadSchema: z.object({ config: FlakeDashboardConfig }),
      examples: [
        {
          description: "The dogfood dashboard for this repo.",
          payload: {
            config: {
              repository: { owner: "iterate", repo: "iterate" },
              issueTitle: "Flake dashboard",
              defaultBranch: "main",
            },
          },
        },
      ],
    },
    [flakeEventTypes.runRecorded]: {
      description:
        "One CI run+lane's createFlake outcomes, appended by the CI reporter script (never by this processor). Idempotency-keyed on run+lane so CI retries cannot double-count.",
      payloadSchema: FlakeRunRecorded,
    },
    [flakeEventTypes.transitionProposed]: {
      description:
        "A test's default-branch streak crossed a lifecycle threshold; downstream automation (an agent) should open the unwrap / switch-to-failing PR. The file-edit guard (a streak is only trustworthy if the test file did not change during it) is applied by that agent, which can read git history — the fold cannot.",
      payloadSchema: FlakeTransitionProposed,
    },
    [flakeEventTypes.dashboardRenderSettled]: {
      description:
        "Terminal fact for one dashboard render attempt: the GitHub issue reached (or the error), and the data offset it covered.",
      payloadSchema: z.object({
        throughOffset: StreamOffset,
        result: FlakeDashboardRenderResult,
      }),
    },
  },
  consumes: [...Object.values(flakeEventTypes)],
  emits: [flakeEventTypes.transitionProposed, flakeEventTypes.dashboardRenderSettled],
});

export type FlakeDashboardProcessorContract = typeof FlakeDashboardProcessorContract;
export type FlakeDashboardState = z.infer<typeof FlakeDashboardState>;
export type FlakeRecord = z.infer<typeof FlakeRecord>;
export type FlakeDashboardRenderResult = z.infer<typeof FlakeDashboardRenderResult>;
