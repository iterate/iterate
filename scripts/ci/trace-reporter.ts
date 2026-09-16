import { relative } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/** Lifecycle records survive a killed test run in Depot's existing log storage. */
export default class TraceReporter implements Reporter {
  onTestBegin(test: TestCase, result: TestResult) {
    if (process.env.CI_TRACE_ENABLED !== "1") return;
    console.log(
      `@@ci-trace ${JSON.stringify({
        kind: "test-start",
        id: `${test.id}/${test.repeatEachIndex}/${result.retry}`,
        time: result.startTime.getTime(),
        title: test.title,
        file: relative(process.cwd(), test.location.file),
        line: test.location.line,
        project: test.parent.project()?.name || "default",
        retry: result.retry,
      })}`,
    );
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (process.env.CI_TRACE_ENABLED !== "1") return;
    console.log(
      `@@ci-trace ${JSON.stringify({
        kind: "test-end",
        id: `${test.id}/${test.repeatEachIndex}/${result.retry}`,
        time: result.startTime.getTime() + result.duration,
        status: result.status,
        expectedStatus: test.expectedStatus,
        worker: result.workerIndex,
      })}`,
    );
  }
}
