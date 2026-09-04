/**
 * The wire format of test-health telemetry: one JSON line per observed
 * outcome, appended to `$FLAKE_RECORD_DIR`, shipped by CI as
 * `flake-records-<suite>` artifacts, and folded by the flake dashboard
 * (packages/iterate/src/starter-apps/flake-dashboard — its contract mirrors
 * this shape in zod).
 *
 * Three producers write records:
 * - `createFlake` (./flake-test.ts): kind "flake" — pass / flake-fail /
 *   unexpected-error, plus `sentinel: true` for the deliberate canary tests.
 * - `createFailing` (./failing-test.ts): kind "failing" — pinned-fail (the
 *   pin held) / unexpected-pass (the bug looks fixed) / unexpected-error.
 * - The telemetry reporters (vitest's RetryTelemetryReporter, the root
 *   playwright reporter): kind "unknown" — retried-pass for a PLAIN test
 *   that failed and then passed on retry, carrying the failed attempt's
 *   error text. That record is the adoption funnel: the dashboard shows the
 *   error samples a person or agent turns into a createFlake pattern.
 */
export interface FlakeRecord {
  name: string;
  kind: "flake" | "failing" | "unknown";
  outcome:
    | "pass"
    | "flake-fail"
    | "unexpected-error"
    | "pinned-fail"
    | "unexpected-pass"
    | "retried-pass";
  /** Source of the tracked-error RegExp; absent for kind "unknown". */
  pattern?: string;
  /** Deliberate canary flakes (the monthly sentinels) — grouped separately on the dashboard. */
  sentinel?: boolean;
  durationMs: number;
  at: string;
  /** First line of the relevant error, when there is one. */
  error?: string;
}

/**
 * The telemetry shape both reporters already produce, reduced to the fields
 * this module reads. `expectedState === "passed"` is what excludes
 * createFlake/createFailing registrations — those run in the runner's
 * expected-fail mode, so their retried outcomes must never masquerade as
 * unknown flakes.
 */
export interface RetriedTestTelemetry {
  fullName: string;
  expectedState?: string;
  passedAfterRetry: boolean;
  durationMs: number;
  startedAt?: string;
  firstFailure?: string;
}

/**
 * A plain test that failed and then passed on retry is a certified flake
 * nobody has classified yet — worth a `kind: "unknown"` record. Returns null
 * for everything else: never-retried tests, tests that failed all retries
 * (that is just red CI, already visible), and expected-fail registrations.
 */
export function unknownFlakeRecordFromTelemetry(test: RetriedTestTelemetry): FlakeRecord | null {
  if (!test.passedAfterRetry) return null;
  // Missing expectedState means a plain test: vitest only reports options for
  // tests that set any, and both wrappers always do (fails mode).
  if (test.expectedState !== undefined && test.expectedState !== "passed") return null;
  return {
    name: test.fullName,
    kind: "unknown",
    outcome: "retried-pass",
    durationMs: test.durationMs,
    at: test.startedAt || new Date().toISOString(),
    ...(test.firstFailure === undefined ? {} : { error: test.firstFailure }),
  };
}

/**
 * Append one record to `$FLAKE_RECORD_DIR/flake-records-<pid>.jsonl`. A no-op
 * when the variable is unset (local runs). Per-pid files keep parallel test
 * workers from interleaving writes. Recording failures are logged, never
 * thrown — telemetry must not change a test's outcome.
 *
 * A relative FLAKE_RECORD_DIR is rebased against GITHUB_WORKSPACE (the same
 * rule as TEST_TELEMETRY_ARTIFACT_DIR in ci-telemetry.ts): root `pnpm test`
 * runs each workspace with its own cwd, so without the rebase every package
 * would write under its own directory and the CI reporter — which reads from
 * the repo root — would find nothing.
 */
export async function appendFlakeRecord(record: FlakeRecord): Promise<void> {
  const dir = typeof process === "undefined" ? undefined : process.env.FLAKE_RECORD_DIR;
  if (!dir) return;
  try {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const repositoryRoot = process.env.GITHUB_WORKSPACE;
    const resolved = repositoryRoot ? resolve(repositoryRoot, dir) : dir;
    mkdirSync(resolved, { recursive: true });
    appendFileSync(
      join(resolved, `flake-records-${process.pid}.jsonl`),
      JSON.stringify(record) + "\n",
    );
  } catch (error) {
    console.error("[flake-record] failed to append flake record:", error);
  }
}
