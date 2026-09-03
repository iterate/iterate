/**
 * Known-flaky tests: the body asserts real behavior, passes are welcome, and
 * exactly one error pattern is tolerated as "the flake". Anything else is a
 * real failure.
 *
 * The sibling of `failing` (./failing-test.ts) — same registration trick,
 * different contract. `createFlake` registers through the runner's own
 * expected-fail variant (vitest `test.fails`, playwright `test.fail`) and
 * inverts outcomes so that:
 *
 * - body fails matching the pattern → rethrown → GREEN (the flake struck; recorded)
 * - body passes → the wrapper throws "Flaky test passed this run" → GREEN (recorded)
 * - body fails with anything else → logged, returned as success, which the
 *   expected-fail machinery rejects → RED (a real failure, not the known flake)
 * - body still running at the wrapper's deadline → RED for the same reason
 *   (without this, a runner-level timeout would satisfy the expected-fail
 *   machinery and a hang would vanish into a vacuous green)
 *
 * ```ts
 * const flake = createFlake(test, /CPU startup time exceeded \d+ms/);
 * flake("Worker can be deployed", async () => {
 *   const deployment = await system.deploy();
 *   await expect.poll(() => fetch(deployment.url)).toMatchObject({ status: 200 });
 * });
 * ```
 *
 * A flake test therefore never blocks unrelated work, but it keeps running and
 * keeps producing data. When `FLAKE_RECORD_DIR` is set, every execution
 * appends one JSON line (see {@link FlakeRecord}) to a per-process file in
 * that directory; CI ships those lines to the flake dashboard. Local runs
 * without the variable record nothing.
 *
 * Lifecycle (see docs/testing.md): a test that seems flaky moves from a plain
 * test to `createFlake`; if it stops passing entirely, switch to `failing`;
 * once it passes consistently, unwrap it back to a plain test. Wrapping is a
 * human/agent diagnosis; the unwrap and switch-to-`failing` directions are
 * proposed automatically from the recorded data.
 *
 * There is no retry and no repetition: one body execution per run, one
 * recorded sample. Retry-until-pass would bias the flake rate — the one
 * number this exists to measure. On vitest this needs an explicit per-test
 * `retry: 0`: a suite-level `retry` re-runs the body on the wrapper's thrown
 * green outcomes (the retry fires before the `.fails` inversion is applied),
 * which recorded every green run twice in the preview e2e suite.
 */
export interface FlakeRecord {
  name: string;
  outcome: "pass" | "flake-fail" | "unexpected-error";
  /** Source of the allowed-error RegExp, e.g. "CPU startup time exceeded \\d+ms". */
  pattern: string;
  durationMs: number;
  at: string;
  /** First line of the error, present for both failure outcomes. */
  error?: string;
}

export function createFlake<TestFn extends (...args: any[]) => any>(
  test: TestFn,
  flake: RegExp,
  options?: { timeoutMs: number },
): TestFn {
  const timeoutMs = options?.timeoutMs || 30_000;
  const failer: unknown = "fails" in test ? test.fails : "fail" in test ? test.fail : undefined;
  if (typeof failer !== "function") {
    throw new Error(
      "createFlake(test, pattern): test has neither .fails (vitest) nor .fail (playwright)",
    );
  }
  const register = (...args: any[]) => {
    const body = args.at(-1);
    if (typeof body !== "function") {
      throw new Error("createFlake(test, pattern): the last argument must be the test body");
    }
    const name = String(args[0]);
    // The body's own arguments pass through untouched — playwright fixtures,
    // vitest context — whatever the wrapped test function provides.
    const wrapped = async (...bodyArgs: any[]) => {
      (test as any).setTimeout?.(timeoutMs + 1000);
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // `as const` keeps the outcome union discriminated (same reasoning as
      // the identical race in failing-test.ts).
      const outcome = await Promise.race([
        (async () => body(...bodyArgs))().then(
          () => ({ kind: "succeeded" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        new Promise<{ kind: "timed-out" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      const durationMs = Date.now() - startedAt;

      const record = async (result: FlakeRecord["outcome"], error?: unknown): Promise<void> => {
        await appendFlakeRecord({
          name,
          outcome: result,
          pattern: flake.source,
          durationMs,
          at: new Date(startedAt).toISOString(),
          ...(error === undefined ? {} : { error: String(error).split("\n")[0] }),
        });
      };

      if (outcome.kind === "failed") {
        if (flake.test(String(outcome.error))) {
          await record("flake-fail", outcome.error);
          // The known flake: rethrow to satisfy the expected-fail machinery.
          throw outcome.error;
        }
        await record("unexpected-error", outcome.error);
        console.error(
          `[flake-test] Failure does not match the allowed flake pattern /${flake.source}/ — ` +
            `this is a real failure, not the known flake:`,
          outcome.error,
        );
        return; // success here is what makes test.fails / test.fail go red
      }
      if (outcome.kind === "timed-out") {
        await record("unexpected-error", `hung: still running after ${timeoutMs}ms`);
        console.error(
          `[flake-test] The body is still running after ${timeoutMs}ms — a hang is not the ` +
            `allowed flake. Raise createFlake()'s options.timeoutMs (keeping it below the ` +
            `runner's test timeout) if the body legitimately needs longer.`,
        );
        return; // same inversion: success → the expected-fail machinery goes red
      }
      await record("pass");
      // A pass is also green: throw so the expected-fail machinery is
      // satisfied. If the dashboard shows this test passing consistently,
      // unwrap it back to a plain test.
      throw new Error("Flaky test passed this run");
    };
    // Present the body's own source when the runner parses for destructured
    // fixture names — same trick, and same reasoning, as failing-test.ts.
    Object.defineProperty(wrapped, "toString", { value: () => body.toString() });
    // Same runner-timeout coordination as failing(): the runner must never
    // fire before the wrapper's own deadline resolves, or a hang would read
    // as the expected failure.
    if ("setTimeout" in test) {
      // playwright-like, no `timeout` option, we set the timeout manually above
      return failer(...args.slice(0, -1), wrapped);
    } else {
      // vitest-like: pass the timeout option, and pin per-test retry to zero
      // — a suite-level `retry` re-runs the body whenever the wrapper throws
      // (both green outcomes) because the retry fires before the `.fails`
      // inversion, so one run would execute and record the body twice.
      // args.slice(1, -1) is either `[]` or `[{ ...otherOptions }]`
      const options = Object.assign({}, ...args.slice(1, -1), {
        timeout: timeoutMs + 1000,
        retry: 0,
      });
      return failer(args[0], options, wrapped);
    }
  };
  // Same contract-preserving cast as failing(): every argument forwards
  // unchanged except the trailing body.
  return register as TestFn;
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
async function appendFlakeRecord(record: FlakeRecord): Promise<void> {
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
    console.error("[flake-test] failed to append flake record:", error);
  }
}
