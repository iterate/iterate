import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { unknownFlakeRecordFromTelemetry } from "@iterate-com/shared/test-support/flake-record";
import { writeFlakeSuiteSummaries } from "./flake-suite-summary.ts";

test("a complete clean browser run publishes a summary even without flake records", async () => {
  using output = temporaryDirectory();
  await writeFlakeSuiteSummaries({
    directory: output.path,
    group: "preview",
    artifacts: [browserResult()],
    expectedWorkspaces: [],
    cancelled: false,
    headSha: "abc123",
  });
  expect(
    JSON.parse(readFileSync(join(output.path, "specs/suite-summary.json"), "utf8")),
  ).toMatchObject({
    status: "complete",
    testCount: 1,
    tests: [{ name: "sends a message", outcome: "pass" }],
    failedCount: 0,
    diagnostics: [],
  });
  expect(
    JSON.parse(readFileSync(join(output.path, "preview-e2e/suite-summary.json"), "utf8")),
  ).toMatchObject({
    status: "incomplete",
    testCount: 0,
  });
});

test("per-test evidence uses the retry record's identity and never counts retries or skips as clean", async () => {
  using output = temporaryDirectory();
  const artifact = browserResult();
  const base = artifact.tests[0]!;
  artifact.tests = [
    { ...base, fullName: "chromium › chat › sends a message", leafName: "sends a message" },
    { ...base, leafName: "retry", retryCount: 1, passedAfterRetry: true, outcome: "flaky" },
    { ...base, leafName: "failure", state: "failed", outcome: "unexpected" },
    { ...base, leafName: "skip", state: "skipped", expectedState: "skipped" },
    { ...base, leafName: "expected failure", expectedState: "failed" },
  ];
  await writeFlakeSuiteSummaries({
    directory: output.path,
    group: "preview",
    artifacts: [artifact],
    expectedWorkspaces: [],
    cancelled: false,
    headSha: "abc123",
  });
  const summary = JSON.parse(readFileSync(join(output.path, "specs/suite-summary.json"), "utf8"));
  expect(summary).toMatchObject({
    status: "complete",
    testCount: 5,
    // The retried pass and the hard failure: both leave a kind "unknown" record.
    unknownFlakeCount: 2,
    tests: [
      { name: "sends a message", outcome: "pass" },
      { name: unknownFlakeRecordFromTelemetry(artifact.tests[1]!)!.name, outcome: "fail" },
      { name: "failure", outcome: "fail" },
      { name: "skip", outcome: "skip" },
      { name: "expected failure", outcome: "fail" },
    ],
  });
});

test("each row carries what the dashboard's Cost section reads", async () => {
  using output = temporaryDirectory();
  const artifact = browserResult();
  const base = artifact.tests[0]!;
  artifact.tests = [
    { ...base, startedAt: "2026-09-15T12:00:13.000Z", durationMs: 181_400.4, tags: ["slow"] },
    {
      ...base,
      leafName: "retried",
      retryCount: 1,
      passedAfterRetry: true,
      outcome: "flaky",
      firstFailure: "socket closed",
    },
    {
      ...base,
      leafName: "failed",
      state: "failed",
      outcome: "unexpected",
      errors: [{ message: "x".repeat(400) }],
    },
  ];
  await writeFlakeSuiteSummaries({
    directory: output.path,
    group: "preview",
    artifacts: [artifact],
    expectedWorkspaces: [],
    cancelled: false,
    headSha: "abc123",
  });
  const summary = JSON.parse(readFileSync(join(output.path, "specs/suite-summary.json"), "utf8"));
  expect(summary).toMatchObject({
    tests: [
      {
        name: "sends a message",
        outcome: "pass",
        durationMs: 181_400,
        startMs: 13_000,
        tags: ["slow"],
      },
      { name: "retried", outcome: "fail", durationMs: 20, retries: 1, error: "socket closed" },
      { name: "failed", outcome: "fail", durationMs: 20, failed: true, error: "x".repeat(300) },
    ],
  });
});

test.each(["interrupted", "missing workspace", "wrong commit", "unexecuted test"])(
  "%s cannot publish a clean complete result",
  async (failure) => {
    using output = temporaryDirectory();
    const artifact = browserResult();
    artifact.context.testKind = "unit";
    if (failure === "interrupted") artifact.run.status = "interrupted";
    if (failure === "wrong commit") artifact.ci.headSha = "old";
    if (failure === "unexecuted test") artifact.tests[0]!.state = "skipped";
    await writeFlakeSuiteSummaries({
      directory: output.path,
      group: "unit",
      artifacts: [artifact],
      expectedWorkspaces: failure === "missing workspace" ? ["another-package"] : [],
      cancelled: false,
      headSha: "abc123",
    });
    expect(JSON.parse(readFileSync(join(output.path, "suite-summary.json"), "utf8"))).toMatchObject(
      {
        status: "incomplete",
        diagnostics: expect.arrayContaining([expect.any(String)]),
      },
    );
  },
);

test.each(["specs", "preview-e2e"])(
  "missing %s results leave the other suite complete",
  async (missing) => {
    using output = temporaryDirectory();
    const browser = browserResult();
    const backend = TestTelemetryArtifact.parse({
      ...browser,
      artifactId: "vitest",
      producer: "vitest-retry-telemetry-reporter",
      context: { ...browser.context, framework: "vitest", workspace: "os" },
    });
    await writeFlakeSuiteSummaries({
      directory: output.path,
      group: "preview",
      artifacts: [missing === "specs" ? backend : browser],
      expectedWorkspaces: [],
      cancelled: false,
      headSha: "abc123",
    });
    for (const suite of ["specs", "preview-e2e"]) {
      expect(
        JSON.parse(readFileSync(join(output.path, suite, "suite-summary.json"), "utf8")),
      ).toMatchObject({ status: suite === missing ? "incomplete" : "complete" });
    }
  },
);

test.each([
  { states: ["passed", "failed"], slowRows: "ran" },
  { states: ["skipped", "skipped"], slowRows: "skipped" },
  { states: [], slowRows: undefined },
])(
  "the preview e2e summary says whether its rows tagged slow ran: $states → $slowRows",
  async ({ states, slowRows }) => {
    using output = temporaryDirectory();
    const artifact = browserResult();
    const base = artifact.tests[0]!;
    artifact.producer = "vitest-retry-telemetry-reporter";
    artifact.context = { ...artifact.context, framework: "vitest", workspace: "os" };
    artifact.tests = [
      { ...base, leafName: "a plain row" },
      ...states.map((state, index) => ({
        ...base,
        leafName: `slow ${index}`,
        state,
        tags: ["slow"],
      })),
    ];
    await writeFlakeSuiteSummaries({
      directory: output.path,
      group: "preview",
      artifacts: [artifact],
      expectedWorkspaces: [],
      cancelled: false,
      headSha: "abc123",
    });
    const summary = JSON.parse(
      readFileSync(join(output.path, "preview-e2e/suite-summary.json"), "utf8"),
    );
    expect(summary).toEqual(
      slowRows
        ? expect.objectContaining({ slowRows })
        : expect.not.objectContaining({ slowRows: expect.anything() }),
    );
  },
);

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "flake-summary-"));
  return {
    path,
    [Symbol.dispose]() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

function browserResult() {
  return TestTelemetryArtifact.parse({
    artifactSchemaVersion: 2,
    artifactId: "playwright-1",
    producer: "playwright-telemetry-reporter",
    createdAt: "2026-09-15T12:01:00.000Z",
    ci: {
      repository: "iterate/iterate",
      headSha: "abc123",
      branch: "main",
      workflowRunId: "1",
      workflowRunAttempt: "1",
      runnerProvider: "depot",
      executionContext: "ci",
      depotJobUrl: "https://depot.dev/runs/1",
    },
    context: {
      framework: "playwright",
      testKind: "e2e",
      suite: "playwright",
      workspace: "iterate-root",
    },
    run: {
      status: "passed",
      startedAt: "2026-09-15T12:00:00.000Z",
      finishedAt: "2026-09-15T12:01:00.000Z",
      durationMs: 60_000,
    },
    tests: [
      {
        fullName: "sends a message",
        moduleId: "specs/chat.spec.ts",
        expectedState: "passed",
        state: "passed",
        outcome: "expected",
        tags: [],
        annotations: [],
        retryCount: 0,
        passedAfterRetry: false,
        durationMs: 20,
        attemptDetail: "complete",
        attempts: [],
        phases: [],
        errors: [],
      },
    ],
    modules: [],
    runners: [],
  });
}
