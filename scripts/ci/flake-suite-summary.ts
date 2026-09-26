import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unknownFlakeRecordFromTelemetry } from "@iterate-com/shared/test-support/flake-record";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { FlakeSuiteSummary } from "@iterate-com/shared/test-support/flake-suite-summary";
import {
  analyzeTestTelemetryCompleteness,
  testTelemetryFailed,
} from "./test-telemetry-completeness.ts";

/** The suites a CI job summarizes: the Test job's unit tests, and one each for the Preview OS and
 *  Main OS e2e workflows' Browser specs and E2E tests jobs. */
export type FlakeSuite = "unit" | "specs" | "preview-e2e";

/** Called only by full-suite CI finalizers, never by focused test invocations. */
export async function writeFlakeSuiteSummary(input: {
  directory: string;
  suite: FlakeSuite;
  artifacts: TestTelemetryArtifact[];
  expectedWorkspaces: string[];
  cancelled: boolean;
  headSha: string;
}) {
  const { suite } = input;
  const matchesSuite = (source: { producer: string; testKind: string; workspace?: string }) => {
    if (suite === "unit") return source.testKind === "unit";
    return suite === "specs"
      ? source.producer === "playwright-telemetry-reporter" && source.workspace === "iterate-root"
      : source.producer === "vitest-retry-telemetry-reporter" && source.workspace === "os";
  };
  // Only this suite's runners: another suite's result must not stand in for its own.
  const artifacts = input.artifacts.filter((artifact) =>
    matchesSuite({ ...artifact.context, producer: artifact.producer }),
  );
  const source = artifacts[0] || input.artifacts[0];
  if (!source) throw new Error("Cannot identify the CI run for the flake suite summary");
  const branch = source.ci.branch || "";
  const completeness = analyzeTestTelemetryCompleteness(
    artifacts,
    suite === "unit" ? input.expectedWorkspaces : [],
  );
  const diagnostics = [
    ...(!branch ? ["Missing source branch"] : []),
    ...(input.cancelled ? ["CI run cancelled"] : []),
    ...(artifacts.length === 0 ? ["No test runner result received"] : []),
    ...(suite !== "unit" && artifacts.length !== 1
      ? [`Expected 1 full-suite runner results, received ${artifacts.length}`]
      : []),
    ...completeness.missingWorkspaces.map((name) => `Missing workspace: ${name}`),
    ...completeness.incompleteArtifactIds.map((id) => `Incomplete runner result: ${id}`),
    ...completeness.foreignArtifactIds.map((id) => `Result belongs to another CI run: ${id}`),
    ...artifacts.flatMap((artifact) => [
      ...(artifact.ci.branch !== branch
        ? [`Result belongs to another branch: ${artifact.artifactId}`]
        : []),
      ...(artifact.ci.headSha !== input.headSha
        ? [`Result belongs to another commit: ${artifact.artifactId}`]
        : []),
      ...(!["passed", "failed"].includes(artifact.run.status)
        ? [`Runner ${artifact.artifactId}: ${artifact.run.status}`]
        : []),
      ...(artifact.run.error
        ? [`Runner ${artifact.artifactId}: ${artifact.run.error.message}`]
        : []),
      ...artifact.run.collectionErrors,
      ...artifact.tests
        .filter(
          (test) =>
            ["pending", "interrupted"].includes(test.state) ||
            (test.state === "skipped" &&
              !["skip", "skipped", "todo"].includes(test.expectedState || "")),
        )
        .map((test) => `Test did not finish: ${test.fullName}`),
    ]),
  ];
  const tests = artifacts.flatMap((artifact) => artifact.tests);
  if (tests.length === 0) diagnostics.push("No tests reported");
  // Whether the rows tagged `slow` ran (apps/os/scripts/slow-rows.ts); a tree with none says nothing.
  const slowRows = tests.filter((test) => test.tags.includes("slow"));
  const startedAt =
    artifacts.map((artifact) => artifact.run.startedAt).sort()[0] || new Date().toISOString();
  const finishedAt =
    artifacts
      .map((artifact) => artifact.run.finishedAt)
      .sort()
      .at(-1) || startedAt;
  const summary = FlakeSuiteSummary.parse({
    headSha: input.headSha,
    branch,
    status: diagnostics.length === 0 ? "complete" : "incomplete",
    startedAt,
    finishedAt,
    testCount: tests.length,
    tests: tests.map((test) => {
      const failed = testTelemetryFailed(test);
      const error =
        (failed || test.retryCount > 0) && (test.firstFailure || test.errors[0]?.message);
      return {
        name: test.leafName || test.fullName,
        outcome:
          test.state === "passed" &&
          test.retryCount === 0 &&
          !test.passedAfterRetry &&
          (!test.expectedState || test.expectedState === "passed")
            ? "pass"
            : ["skipped", "pending", "interrupted"].includes(test.state)
              ? "skip"
              : "fail",
        durationMs: Math.round(test.durationMs),
        ...(test.startedAt && {
          startMs: Math.max(0, Date.parse(test.startedAt) - Date.parse(startedAt)),
        }),
        ...(test.tags.length > 0 && { tags: test.tags }),
        ...(test.retryCount > 0 && { retries: test.retryCount }),
        failed,
        ...(error && { error: error.slice(0, 300) }),
      };
    }),
    unknownFlakeCount: tests.filter((test) => unknownFlakeRecordFromTelemetry(test) !== null)
      .length,
    failedCount: tests.filter(testTelemetryFailed).length,
    ...(suite === "preview-e2e" &&
      slowRows.length > 0 && {
        slowRows: slowRows.some((test) => test.state !== "skipped") ? "ran" : "skipped",
      }),
    diagnostics: [...new Set(diagnostics)],
    runUrl:
      source.ci.depotJobUrl ||
      source.ci.workflowRunUrl ||
      `https://github.com/${source.ci.repository}/commit/${input.headSha}`,
  });
  const directory = suite === "unit" ? input.directory : join(input.directory, suite);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "suite-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}
