import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unknownFlakeRecordFromTelemetry } from "@iterate-com/shared/test-support/flake-record";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { FlakeSuiteSummary } from "@iterate-com/shared/test-support/flake-suite-summary";
import {
  analyzeTestTelemetryCompleteness,
  testTelemetryFailed,
} from "./test-telemetry-completeness.ts";

/** Called only by full-suite CI finalizers, never by focused test invocations. */
export async function writeFlakeSuiteSummaries(input: {
  directory: string;
  group: "unit" | "preview";
  artifacts: TestTelemetryArtifact[];
  expectedWorkspaces: string[];
  cancelled: boolean;
  headSha: string;
}) {
  const suites = input.group === "unit" ? ["unit"] : ["specs", "preview-e2e"];
  for (const suite of suites) {
    const matchesSuite = (source: { producer: string; testKind: string; workspace?: string }) => {
      if (suite === "unit") return source.testKind === "unit";
      return suite === "specs"
        ? source.producer === "playwright-telemetry-reporter" && source.workspace === "iterate-root"
        : source.producer === "vitest-retry-telemetry-reporter" && source.workspace === "os";
    };
    // Keep this suite's declarations as well as its runners. A missing sibling
    // suite must not prevent this one from proving its own test inventory.
    const evidence = input.artifacts.flatMap((artifact) => {
      const expectedArtifactSources = (artifact.expectedArtifactSources || []).filter(matchesSuite);
      return matchesSuite({ ...artifact.context, producer: artifact.producer }) ||
        expectedArtifactSources.length
        ? [{ ...artifact, expectedArtifactSources }]
        : [];
    });
    const artifacts = evidence.filter((artifact) =>
      matchesSuite({ ...artifact.context, producer: artifact.producer }),
    );
    const source = artifacts[0] || input.artifacts[0];
    if (!source) throw new Error("Cannot identify the CI run for the flake suite summary");
    const branch = source.ci.branch || "";
    const completeness = analyzeTestTelemetryCompleteness(
      evidence,
      suite === "unit" ? input.expectedWorkspaces : [],
    );
    const diagnostics = [
      ...(!branch ? ["Missing source branch"] : []),
      ...(input.cancelled ? ["CI run cancelled"] : []),
      ...(artifacts.length === 0 ? ["No test runner result received"] : []),
      ...(suite !== "unit" && artifacts.length !== 1
        ? [`Expected 1 full-suite runner results, received ${artifacts.length}`]
        : []),
      ...completeness.missingArtifactSources.map(
        ({ source }) => `Missing runner: ${source.producer}@${source.workspace}`,
      ),
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
        // iterate-lint-disable-next-line terminology/no-metaphorical-lane-door-seam -- existing test telemetry wire field
        ...artifact.lanes.flatMap((result) => result.collectionErrors),
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
      tests: tests.map((test) => ({
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
      })),
      unknownFlakeCount: tests.filter((test) => unknownFlakeRecordFromTelemetry(test) !== null)
        .length,
      failedCount: tests.filter(testTelemetryFailed).length,
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
}
