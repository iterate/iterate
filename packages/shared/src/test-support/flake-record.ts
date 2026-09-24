/**
 * The wire format of test-health telemetry: one JSON line per observed
 * outcome, appended to `$FLAKE_RECORD_DIR`, shipped by CI as
 * `flake-records-<suite>` artifacts, and folded by the flake dashboard
 * (docs/testing.md#flakes-and-pinned-failures).
 *
 * Three producers write records:
 * - `createFlake` (./flake-test.ts): kind "flake" — pass / flake-fail /
 *   unexpected-error. The deliberate canary tests are just createFlake tests
 *   whose names contain "flake sentinel"; the dashboard groups them by name.
 * - `createFailing` (./failing-test.ts): kind "failing" — pinned-fail (the
 *   pin held) / unexpected-pass (the bug looks fixed) / unexpected-error.
 * - The telemetry reporters (vitest's RetryTelemetryReporter, the
 *   Playwright telemetry reporter): kind "unknown" for a PLAIN test —
 *   retried-pass when it failed and then passed on retry, unexpected-error
 *   when it failed every attempt — carrying the first failed attempt's error
 *   text. That record is the adoption funnel: the dashboard shows the error
 *   samples a person or agent turns into a createFlake pattern, and a CI
 *   retry can no longer be the only place a failure was ever written down.
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
  /**
   * The bare test title, without describe/project/file prefixes. Records key
   * on it when available so that wrapping a surfaced unknown flake with
   * createFlake — which records `args[0]`, the bare title — migrates the SAME
   * dashboard row instead of opening a second one.
   */
  leafName?: string;
  expectedState?: string;
  passedAfterRetry: boolean;
  /** The final attempt's state: vitest's `failed`, Playwright's `failed` / `timedOut`, … */
  state?: string;
  /** Playwright's verdict against `expectedState`; vitest has none. */
  outcome?: string;
  durationMs: number;
  startedAt?: string;
  firstFailure?: string;
}

/**
 * A plain test that failed is worth a `kind: "unknown"` record: retried-pass
 * when a retry rescued it (a certified flake nobody has classified yet),
 * unexpected-error when every attempt failed. The hard failure needs its own
 * record because only a record opens a dashboard row and carries the error:
 * without it a test that failed every attempt on one main push and passed on
 * the next left no trace on #2580. Returns null for tests that passed first
 * time, did not finish (skipped, interrupted), and expected-fail registrations.
 */
export function unknownFlakeRecordFromTelemetry(test: RetriedTestTelemetry): FlakeRecord | null {
  // Missing expectedState means a plain test: vitest only reports options for
  // tests that set any, and both wrappers always do (fails mode).
  if (test.expectedState && test.expectedState !== "passed") return null;
  const outcome = test.passedAfterRetry
    ? "retried-pass"
    : failedOutright(test)
      ? "unexpected-error"
      : null;
  if (!outcome) return null;
  return {
    name: test.leafName || test.fullName,
    kind: "unknown",
    outcome,
    durationMs: test.durationMs,
    at: test.startedAt || new Date().toISOString(),
    error: test.firstFailure,
  };
}

/**
 * The last attempt ran to a failure and, where the runner judges outcomes (Playwright), that was
 * unexpected. A last attempt that was interrupted (a run cancelled during the retry) proves nothing,
 * though Playwright still calls the test "unexpected" when an earlier attempt failed.
 */
function failedOutright(test: RetriedTestTelemetry) {
  if (!test.state || !["failed", "timedout"].includes(test.state.toLowerCase())) return false;
  return !test.outcome || test.outcome === "unexpected";
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
  // Outside Node (a Workers or browser test runner) there is no `process` global at all.
  const dir = globalThis.process?.env.FLAKE_RECORD_DIR;
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
