import { expect, test } from "vitest";
import { assembleTrace } from "./trace-model.ts";

test("quiet steps retain their duration, retries have distinct parents, and unfinished tests stay incomplete", () => {
  const workflow = {
    workflowId: "workflow",
    workflowName: "Preview",
    workflowPath: "preview.yml",
    repo: "iterate/iterate",
    headSha: "abc",
    ref: "refs/pull/2681/merge",
    workflowStatus: "cancelled",
    workflowCreatedAt: at(0),
    workflowStartedAt: at(1),
    workflowFinishedAt: at(100),
    executions: [{ executionId: "execution", execution: 1, createdAt: at(0) }],
    jobs: [
      {
        jobId: "shard",
        jobKey: "preview.yml:preview:playwright:matrix-0",
        status: "cancelled",
        attempts: [
          {
            attemptId: "attempt",
            attempt: 1,
            status: "cancelled",
            startedAt: at(2),
            finishedAt: at(99),
          },
        ],
      },
    ],
  };
  const logs = new Map([
    [
      "attempt",
      [
        line("install_dependencies", {
          kind: "shell-start",
          id: "install",
          step: "__run",
          time: ms(3),
        }),
        line("install_dependencies", {
          kind: "shell-end",
          id: "install",
          time: ms(33),
          exitCode: 0,
        }),
        line("wait_for_preview", {
          kind: "shell-start",
          id: "wait",
          step: "wait_for_preview",
          time: ms(33),
        }),
        line("wait_for_preview", { kind: "shell-end", id: "wait", time: ms(60), exitCode: 0 }),
        line("playwright", { kind: "shell-start", id: "tests", step: "playwright", time: ms(61) }),
        line("playwright", {
          kind: "test-start",
          id: "test/0",
          title: "greets",
          file: "specs/greeting.spec.ts",
          line: 5,
          project: "web",
          retry: 0,
          time: ms(62),
        }),
        line("playwright", {
          kind: "test-end",
          id: "test/0",
          time: ms(82),
          status: "failed",
          expectedStatus: "passed",
          worker: 0,
        }),
        line("playwright", {
          kind: "test-start",
          id: "test/1",
          title: "greets",
          file: "specs/greeting.spec.ts",
          line: 5,
          project: "web",
          retry: 1,
          time: ms(83),
        }),
      ],
    ],
  ]);
  const report = assembleTrace(workflow, logs);
  const spans = report.resourceSpans[0].scopeSpans[0].spans;
  const install = spans.find((span) => span.name === "install dependencies")!;
  expect(Number(install.endTimeUnixNano) - Number(install.startTimeUnixNano)).toBe(30e9);
  const tests = spans.filter((span) => span.name.startsWith("greets"));
  expect(tests).toHaveLength(2);
  expect(tests[0].spanId).not.toBe(tests[1].spanId);
  expect(tests[0].parentSpanId).toBe(tests[1].parentSpanId);
  expect(spans.find((span) => span.spanId === tests[0].parentSpanId)).toMatchObject({
    name: "playwright",
  });
  expect(tests[1].attributes).toContainEqual({
    key: "ci.evidence",
    value: { stringValue: "incomplete; end bounded by job finish" },
  });
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  expect(spans.filter((span) => ["Setup", "Wait", "Test"].includes(span.name))).toHaveLength(3);
  expect(
    spans.every(
      (span) => !span.parentSpanId || spans.some((parent) => parent.spanId === span.parentSpanId),
    ),
  ).toBe(true);
});

test("cancelling before runner startup does not invent an attempt duration", () => {
  const trace = assembleTrace(
    {
      workflowId: "cancelled",
      workflowName: "Preview",
      workflowPath: "preview.yml",
      repo: "iterate/iterate",
      headSha: "abc",
      ref: "refs/pull/1/merge",
      workflowStatus: "cancelled",
      workflowCreatedAt: at(0),
      workflowFinishedAt: at(2),
      executions: [{ executionId: "one", execution: 1, createdAt: at(0) }],
      jobs: [
        {
          jobId: "job",
          jobKey: "preview.yml:preview:prepare",
          status: "cancelled",
          attempts: [
            { attemptId: "never-started", attempt: 1, status: "cancelled", finishedAt: at(2) },
          ],
        },
      ],
    },
    new Map(),
  );
  const job = trace.resourceSpans[0].scopeSpans[0].spans[1];
  expect(job.startTimeUnixNano).toBe(job.endTimeUnixNano);
  expect(job.attributes).toContainEqual({
    key: "ci.evidence",
    value: { stringValue: "No runner attempt started" },
  });
});

const ms = (seconds: number) => Date.parse("2026-09-16T12:00:00Z") + seconds * 1000;
const at = (seconds: number) => new Date(ms(seconds)).toISOString();
const line = (stepKey: string, event: object) => ({
  stepKey: `opaque-${stepKey}`,
  stepId: stepKey,
  body: `@@ci-trace ${JSON.stringify(event)}`,
});
