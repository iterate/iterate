import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assembleTrace } from "./tracing.ts";

const CHILD_VITEST_MS = 15_000;

// Each row's body is one whole child Vitest run (`vitestRun`), bounded by its spawnSync timeout,
// so the row gets that bound too: Vitest's 5 s default is not one. CI took up to 1.3 s, a loaded
// 4-core machine more than 5 s (2026-09-24).
test(
  "real Vitest tests appear in CI traces with normalized outcomes and aggregate retries",
  () => {
    using fixture = vitestRun("1");
    expect(fixture.result, fixture.result.stderr).toMatchObject({ status: 1 });
    expect(fixture.events.filter((event: any) => event.kind === "test-start")).toMatchObject([
      { title: "ordinary pass", framework: "vitest" },
      { title: "passes after retry", framework: "vitest" },
      { title: "expected failure", framework: "vitest" },
      { title: "ordinary failure", framework: "vitest" },
    ]);
    const spans = fixture.trace.resourceSpans[0].scopeSpans[0].spans;
    const tests = spans.filter((span) => attributes(span)["ci.kind"] === "test");
    expect(tests.map((span) => ({ name: span.name, status: span.status }))).toEqual([
      { name: "ordinary pass", status: { code: 0 } },
      { name: "passes after retry · 1 retry", status: { code: 0 } },
      { name: "expected failure", status: { code: 0 } },
      { name: "ordinary failure", status: { code: 2 } },
    ]);
    const retried = tests[1]!;
    expect(attributes(retried)).toMatchObject({
      "test.framework": "vitest",
      "test.retry_count": "1",
      "test.attempt_detail": "aggregate-only",
      "ci.status": "passed",
      "ci.evidence": "Vitest startTime + duration; includes hooks and all retries",
    });
    const start = fixture.events.find((event: any) => event.title === "passes after retry");
    const end = fixture.events.find(
      (event: any) => event.kind === "test-end" && event.id === start.id,
    );
    expect(retried).toMatchObject({
      parentSpanId: spans.find((span) => attributes(span)["ci.kind"] === "step")!.spanId,
      startTimeUnixNano: String(BigInt(Math.round(start.time * 1000)) * 1000n),
      endTimeUnixNano: String(BigInt(Math.round(end.time * 1000)) * 1000n),
    });
    expect(JSON.stringify(fixture.events)).not.toContain("private failure payload");

    // A killed runner can leave a start without a completion record.
    const unfinishedStart = fixture.events.find(
      (event: any) => event.title === "passes after retry",
    );
    const lines = fixture.lines.filter((line) => {
      const event = JSON.parse(line.body.slice("@@ci-trace ".length));
      return event.kind !== "test-end" || event.id !== unfinishedStart.id;
    });
    const interrupted = assembleTrace(fixture.workflow, new Map([["attempt", lines]]));
    const span = interrupted.resourceSpans[0].scopeSpans[0].spans.find(
      (span) => span.name === "passes after retry",
    )!;
    expect(attributes(span)).toMatchObject({
      "ci.status": "incomplete",
      "test.attempt_detail": "aggregate-only",
    });
    expect(attributes(span)).not.toHaveProperty("test.retry_count");
    expect(span).toMatchObject({
      endTimeUnixNano: String(
        BigInt(Date.parse(fixture.workflow.jobs[0]!.attempts[0]!.finishedAt)) * 1_000_000n,
      ),
    });
  },
  CHILD_VITEST_MS,
);

test(
  "Vitest tracing is opt-in",
  () => {
    using fixture = vitestRun("0");
    expect(fixture.result, fixture.result.stderr).toMatchObject({ status: 1 });
    expect(fixture).toMatchObject({ events: [] });
  },
  CHILD_VITEST_MS,
);

function vitestRun(enabled: string) {
  const directory = mkdtempSync(join(tmpdir(), "vitest-ci-trace-"));
  const startedAt = new Date().toISOString();
  const reporter = fileURLToPath(
    new URL(
      "../../../packages/shared/src/test-support/e2e-policy/retry-telemetry-reporter.ts",
      import.meta.url,
    ),
  );
  writeFileSync(
    join(directory, "cases.test.js"),
    `
    test("ordinary pass", () => {});
    let attempts = 0;
    test("passes after retry", { retry: 1 }, () => {
      if (++attempts === 1) throw new Error("private failure payload");
    });
    test.fails("expected failure", () => { throw new Error("private failure payload"); });
    test("ordinary failure", () => { throw new Error("private failure payload"); });
    test.skip("never ran", () => {});
  `,
  );
  writeFileSync(
    join(directory, "vitest.config.mjs"),
    `export default ${JSON.stringify({
      test: { globals: true, include: ["*.test.js"], reporters: [reporter] },
    })}`,
  );
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    [join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: CHILD_VITEST_MS,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !key.startsWith("VITEST") &&
              !key.startsWith("TEST_TELEMETRY_") &&
              key !== "TEST" &&
              key !== "GITHUB_WORKSPACE",
          ),
        ),
        CI_TRACE_ENABLED: enabled,
        TEST_TELEMETRY_ARTIFACT_DIR: join(directory, "telemetry"),
        FLAKE_RECORD_DIR: join(directory, "flakes"),
      },
    },
  );
  const events = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("@@ci-trace "))
    .map((line) => JSON.parse(line.slice("@@ci-trace ".length)));
  const workflow = {
    workflowId: "workflow",
    workflowName: "Preview OS",
    workflowPath: "preview-os.yml",
    repo: "iterate/iterate",
    headSha: "head",
    sha: "merge",
    ref: "refs/pull/1/merge",
    workflowStatus: "failed",
    workflowCreatedAt: startedAt,
    workflowFinishedAt: new Date().toISOString(),
    executions: [{ executionId: "execution", execution: 1, createdAt: startedAt }],
    jobs: [
      {
        jobId: "e2e",
        jobKey: "preview-os.yml:e2e",
        status: "failed",
        attempts: [
          {
            attemptId: "attempt",
            attempt: 1,
            status: "failed",
            startedAt,
            finishedAt: new Date().toISOString(),
          },
        ],
      },
    ],
  };
  const lines = [
    { kind: "shell-start", id: "shell", step: "e2e", time: Date.parse(startedAt) },
    ...events,
    { kind: "shell-end", id: "shell", time: Date.now(), exitCode: 1 },
  ].map((event) => ({
    body: `@@ci-trace ${JSON.stringify(event)}`,
    stepKey: "e2e",
    stepId: "e2e",
  }));
  return {
    result,
    events,
    workflow,
    lines,
    trace: assembleTrace(workflow, new Map([["attempt", lines]])),
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function attributes(span: any) {
  return Object.fromEntries(
    span.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue]),
  );
}
