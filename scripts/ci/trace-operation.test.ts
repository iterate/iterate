import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { assembleTrace } from "./trace-model.ts";

test("nested concurrent deploys and readiness become measured children of their CI step", async () => {
  const startedAt = new Date().toISOString();
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { traceOperation } from ${JSON.stringify(new URL("./trace-operation.ts", import.meta.url).href)};
        let release;
        let started = 0;
        const bothStarted = new Promise(resolve => { release = resolve; });
        const result = await traceOperation("Deploy", async () => {
          await Promise.all(["OS", "Auth"].map(name => traceOperation(name, async () => {
            if (++started === 2) release();
            await bothStarted;
            return traceOperation("HTTP readiness", async () => name);
          })));
          return "deployed";
        });
        if (result !== "deployed") throw new Error("lost return value");
        await traceOperation("Shared readiness", async () => {
          throw new Error("private diagnostic payload");
        }).catch(error => {
          if (error.message !== "private diagnostic payload") throw error;
        });
        await traceOperation("Failed command", async span => { span.fail(); });
      `,
    ],
    { env: { ...process.env, CI_TRACE_ENABLED: "1" } },
  );
  const events = stdout.split("\n").filter((line) => line.startsWith("@@ci-trace "));
  expect(stdout).not.toContain("private diagnostic payload");
  const finishedAt = new Date().toISOString();
  const trace = assembleTrace(
    {
      workflowId: "workflow",
      workflowName: "Preview",
      workflowPath: "preview.yml",
      repo: "iterate/iterate",
      headSha: "head",
      sha: "merge",
      ref: "refs/pull/2681/merge",
      workflowStatus: "failed",
      workflowCreatedAt: startedAt,
      workflowFinishedAt: finishedAt,
      executions: [{ executionId: "execution", execution: 1, createdAt: startedAt }],
      jobs: [
        {
          jobId: "prepare",
          jobKey: "preview.yml:preview:prepare",
          status: "failed",
          attempts: [{ attemptId: "attempt", attempt: 1, status: "failed", startedAt, finishedAt }],
        },
      ],
    },
    new Map([
      [
        "attempt",
        [
          `@@ci-trace ${JSON.stringify({ kind: "shell-start", id: "shell", step: "prepare", time: Date.parse(startedAt) })}`,
          ...events,
          `@@ci-trace ${JSON.stringify({ kind: "shell-end", id: "shell", exitCode: 1, time: Date.parse(finishedAt) })}`,
        ].map((body) => ({ body, stepKey: "step", stepId: "prepare" })),
      ],
    ]),
  );
  const spans = trace.resourceSpans[0].scopeSpans[0].spans;
  const byName = (name: string) => spans.find((span) => span.name === name)!;
  const deploy = byName("Deploy");
  const shell = byName("prepare");
  expect(deploy).toMatchObject({ parentSpanId: shell.spanId, status: { code: 0 } });
  for (const name of ["OS", "Auth"]) {
    const app = byName(name);
    expect(app).toMatchObject({ parentSpanId: deploy.spanId });
    expect(spans.find((span) => span.parentSpanId === app.spanId)).toMatchObject({
      name: "HTTP readiness",
    });
  }
  expect(byName("Shared readiness")).toMatchObject({
    parentSpanId: shell.spanId,
    status: { code: 2 },
  });
  expect(byName("Failed command")).toMatchObject({ status: { code: 2 } });
  expect(
    spans.every((span) => BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)),
  ).toBe(true);
});
