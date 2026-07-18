import { writeFileSync } from "node:fs";

/**
 * One test that needed at least one retry, as recorded by
 * RetryTelemetryReporter. `passedAfterRetry: false` means it burned its
 * retries and still failed (the run is red anyway; the record explains why).
 */
export interface RetriedTestRecord {
  fullName: string;
  moduleId: string;
  retryCount: number;
  passedAfterRetry: boolean;
  state: string;
  durationMs: number;
  /** Errors retained by Vitest from the failed attempt(s), even after a retry passes. */
  errors: RetriedTestError[];
}

/** A JSON-safe diagnostic from one failed test attempt. */
export interface RetriedTestError {
  message: string;
  name?: string;
  stack?: string;
}

/** Shape of the JSON file written to `$E2E_RETRY_TELEMETRY_FILE`. */
export interface RetryTelemetryFile {
  retried: RetriedTestRecord[];
}

/**
 * The structural slice of vitest's reported-test API this reporter reads
 * (`TestCase` / `TestDiagnostic` in vitest/node). Structural on purpose: the
 * workspace resolves more than one vitest instance (apps pin different
 * ranges), and importing `Reporter` from one instance makes the class
 * unassignable in configs typed against another.
 */
interface ReportedTestCase {
  fullName: string;
  diagnostic(): { retryCount: number; flaky: boolean; duration: number } | undefined;
  result(): { state: string; errors?: ReadonlyArray<unknown> };
}

/** Structural slice of vitest's `TestModule` (see {@link ReportedTestCase}). */
interface ReportedTestModule {
  moduleId: string;
  children: { allTests(): Iterable<ReportedTestCase> };
}

/**
 * Policy rule 5: retries are measured, never silent (see ./budgets.ts). A
 * red run detects a 5%-probability race roughly once in 400 runs with one
 * retry; counting retries detects it roughly once in 20. Vitest's built-in
 * JSON reporter drops retry counts entirely (verified in 4.1.5), so this
 * reporter walks the run via the reporter API. `diagnostic()` exposes the
 * retry count, while `result().errors` deliberately retains errors from
 * failed attempts even when the final state is `passed` (verified against
 * Vitest 4.1.8's `TestCase.result()` implementation). The reporter:
 *
 * - writes {@link RetryTelemetryFile} to `$E2E_RETRY_TELEMETRY_FILE` when
 *   set (the preview lane sets it and folds the result into the PR body —
 *   scripts/preview/preview.ts);
 * - prints a plain `[retry-telemetry] ...` line so retries are greppable in
 *   any run log (deliberately ANSI-free: a previous log-grepping check was
 *   silently defeated by vitest's colour codes).
 *
 * Telemetry must never fail a run: any error here is logged and swallowed.
 */
export class RetryTelemetryReporter {
  onTestRunEnd(testModules: ReadonlyArray<ReportedTestModule>): void {
    try {
      const retried: RetriedTestRecord[] = [];
      for (const testModule of testModules) {
        for (const test of testModule.children.allTests()) {
          const diagnostic = test.diagnostic();
          if (!diagnostic || diagnostic.retryCount === 0) {
            continue;
          }
          const result = test.result();
          retried.push({
            fullName: test.fullName,
            moduleId: testModule.moduleId,
            retryCount: diagnostic.retryCount,
            passedAfterRetry: diagnostic.flaky,
            state: result.state,
            durationMs: Math.round(diagnostic.duration),
            errors: (result.errors ?? []).map(toRetriedTestError),
          });
        }
      }

      const outputFile = process.env.E2E_RETRY_TELEMETRY_FILE;
      if (outputFile) {
        const payload: RetryTelemetryFile = { retried };
        writeFileSync(outputFile, JSON.stringify(payload, null, 2));
      }
      if (retried.length > 0) {
        const details = retried
          .map((record) => {
            const firstError = record.errors[0];
            const firstFailure = firstError?.message;
            const cause = firstFailure ? `; first failure: ${oneLine(firstFailure)}` : "";
            const location = firstStackLocation(firstError?.stack);
            const source = location ? `; location: ${location}` : "";
            return `${record.fullName} (x${record.retryCount}${record.passedAfterRetry ? "" : ", still failed"}${cause}${source})`;
          })
          .join("; ");
        console.log(`[retry-telemetry] ${retried.length} test(s) needed retries: ${details}`);
      }
    } catch (error) {
      console.error("[retry-telemetry] failed to record retry telemetry:", error);
    }
  }
}

function toRetriedTestError(error: unknown): RetriedTestError {
  if (typeof error !== "object" || error === null) {
    return { message: String(error) };
  }

  const candidate = error as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message:
      typeof candidate.message === "string" ? candidate.message : "Unknown failed-attempt error",
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    ...(typeof candidate.stack === "string" ? { stack: candidate.stack } : {}),
  };
}

function oneLine(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 400 ? `${compact.slice(0, 397)}...` : compact;
}

function firstStackLocation(stack: string | undefined): string | undefined {
  const location = stack
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  return location === undefined ? undefined : oneLine(location);
}
