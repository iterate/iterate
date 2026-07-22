import { relative } from "node:path";
import type { TestEvent } from "node:test/reporters";
import {
  ciTelemetrySourceFromEnvironment,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryRecord,
} from "@iterate-com/shared/test-support/ci-telemetry";

type ResultEvent = Extract<TestEvent, { type: "test:pass" | "test:fail" }>;

/**
 * Silent secondary reporter for Node's native test runner. The normal `spec`
 * reporter still owns console output; this reporter only writes the same
 * artifact contract used by Vitest and Playwright.
 */
export default async function* nodeTestTelemetryReporter(source: AsyncIterable<TestEvent>) {
  const runStartedAtMs = Date.now();
  const workspace =
    process.env.TEST_TELEMETRY_WORKSPACE ?? process.env.npm_package_name ?? process.cwd();
  const context = testTelemetryContextFromEnvironment("node-test", {
    testKind: "unit",
    lane: "unit",
    workspace,
  });
  const artifactId = testTelemetryArtifactId("node-test", workspace, process.pid, runStartedAtMs);
  const ci = ciTelemetrySourceFromEnvironment(
    process.env,
    `local-node-test-${process.pid}-${runStartedAtMs}`,
  );
  writeTestTelemetryFailureSentinel({
    artifactId,
    producer: "node-test-telemetry-reporter",
    startedAt: new Date(runStartedAtMs).toISOString(),
    ci,
    context,
  });
  const attempts = new Map<string, Array<Array<{ event: ResultEvent; observedAtMs: number }>>>();
  let summary: Extract<TestEvent, { type: "test:summary" }> | undefined;

  for await (const event of source) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      if (event.data.details.type !== "suite") {
        // Node's name is only the leaf title, locations can point at a shared
        // helper, and testNumber is only ordinal within the parent. Preserve
        // every first attempt as a distinct observation. Only Node's explicit
        // rerun attempt number is allowed to join two result events.
        const observed = { event, observedAtMs: Date.now() };
        const key = testIdentityCandidate(event);
        const observations = attempts.get(key) ?? [];
        const attempt = event.data.details.attempt;
        if (attempt === undefined || attempt === 0) {
          observations.push([observed]);
        } else {
          const observation = observations.find(
            (candidate) => (candidate.at(-1)?.event.data.details.attempt ?? 0) === attempt - 1,
          );
          if (!observation) {
            throw new Error(
              `Node test telemetry received rerun attempt ${attempt} without its prior attempt: ${key}`,
            );
          }
          observation.push(observed);
        }
        attempts.set(key, observations);
      }
    } else if (event.type === "test:summary" && event.data.file === undefined) {
      summary = event;
    }
  }

  if (!process.env.TEST_TELEMETRY_ARTIFACT_DIR && !process.env.TEST_TELEMETRY_ARTIFACT_FILE) return;
  if (!summary) throw new Error("Node test telemetry did not receive a run summary");
  const observedTestCount = [...attempts.values()].reduce(
    (count, observations) => count + observations.length,
    0,
  );
  if (observedTestCount !== summary.data.counts.tests) {
    throw new Error(
      `Node test telemetry completeness failure: observed ${observedTestCount} tests, summary reported ${summary.data.counts.tests}`,
    );
  }

  const repositoryRoot = process.env.GITHUB_WORKSPACE;
  const tests: TestTelemetryRecord[] = [];
  for (const observations of attempts.values()) {
    for (const testAttempts of observations) {
      const final = testAttempts.at(-1)!.event;
      const moduleId = normalizeModuleId(final.data.file, repositoryRoot);
      const finalState = testState(final);
      const errors = testAttempts.flatMap(({ event }) =>
        event.type === "test:fail"
          ? [
              {
                name: event.data.details.error.name,
                message: String(event.data.details.error.message),
                ...(event.data.details.error.stack
                  ? { stack: String(event.data.details.error.stack) }
                  : {}),
              },
            ]
          : [],
      );
      tests.push({
        fullName: final.data.name,
        moduleId,
        tags: [],
        annotations: [],
        retryCount: Math.max(0, testAttempts.length - 1),
        passedAfterRetry: finalState === "passed" && testAttempts.length > 1,
        state: finalState,
        durationMs: testAttempts.reduce(
          (total, { event }) => total + event.data.details.duration_ms,
          0,
        ),
        attemptDetail: "complete",
        startedAt: new Date(
          testAttempts[0]!.observedAtMs - testAttempts[0]!.event.data.details.duration_ms,
        ).toISOString(),
        startedAtSource: "inferred",
        scheduleDelayMs: Math.max(
          0,
          testAttempts[0]!.observedAtMs -
            testAttempts[0]!.event.data.details.duration_ms -
            runStartedAtMs,
        ),
        attempts: testAttempts.map(({ event, observedAtMs }, index) => {
          const durationMs = event.data.details.duration_ms;
          const previousFinishedAtMs = testAttempts[index - 1]?.observedAtMs ?? runStartedAtMs;
          const startedAtMs = observedAtMs - durationMs;
          return {
            attemptIndex: index,
            state: testState(event),
            durationMs,
            startedAt: new Date(startedAtMs).toISOString(),
            startedAtSource: "inferred",
            scheduleDelayMs: Math.max(0, startedAtMs - previousFinishedAtMs),
            ...(event.type === "test:fail"
              ? {
                  error: {
                    name: event.data.details.error.name,
                    message: String(event.data.details.error.message),
                    ...(event.data.details.error.stack
                      ? { stack: String(event.data.details.error.stack) }
                      : {}),
                  },
                }
              : {}),
            phases: [],
          };
        }),
        phases: [],
        errors,
        ...(errors[0] ? { firstFailure: errors[0].message.slice(0, 300) } : {}),
        ...(final.data.testNumber === undefined ? {} : { testNumber: final.data.testNumber }),
        ...(final.data.line === undefined ? {} : { testLine: final.data.line }),
        ...(final.data.column === undefined ? {} : { testColumn: final.data.column }),
      });
    }
  }
  const finishedAtMs = Date.now();
  writeTestTelemetryArtifact({
    artifactSchemaVersion: 1,
    artifactId,
    producer: "node-test-telemetry-reporter",
    createdAt: new Date(finishedAtMs).toISOString(),
    ci,
    context,
    run: {
      status: summary.data.success ? "passed" : "failed",
      startedAt: new Date(runStartedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: summary.data.duration_ms,
    },
    lanes: [
      {
        context,
        status: summary.data.success ? "passed" : "failed",
        durationMs: summary.data.duration_ms,
        testCount: tests.length,
        retryCount: tests.reduce((total, test) => total + test.retryCount, 0),
        collectionErrors: [],
      },
    ],
    tests,
    modules: [],
  });
  // Node's reporter contract requires an async iterator. Human output comes
  // from the parallel `spec` reporter, so this destination stays silent.
  yield "";
}

function testIdentityCandidate(event: ResultEvent) {
  return [
    event.data.file ?? "unknown",
    event.data.line ?? 0,
    event.data.column ?? 0,
    event.data.nesting,
    event.data.testNumber,
    event.data.name,
  ].join(":");
}

function testState(event: ResultEvent) {
  if (event.data.skip) return "skipped";
  if (event.data.todo) return "todo";
  return event.type === "test:pass" ? "passed" : "failed";
}

function normalizeModuleId(moduleId: string | undefined, repositoryRoot: string | undefined) {
  if (!moduleId) return "unknown";
  return repositoryRoot && moduleId.startsWith(repositoryRoot)
    ? relative(repositoryRoot, moduleId)
    : moduleId;
}
