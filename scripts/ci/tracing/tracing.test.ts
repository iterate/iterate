import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { assembleTrace, renderTrace, stepCommands, traceCommitStatus } from "./tracing.ts";

test("the shell hook preserves failures and does not double-count nested bash", async () => {
  const result = await promisify(execFile)("bash", ["-c", "bash -c 'echo nested'; exit 7"], {
    env: {
      ...process.env,
      BASH_ENV: resolve("ci/tracing/shell.sh"),
      GITHUB_ACTION: "install_dependencies",
    },
  }).catch((error) => error);
  expect(result.code).toBe(7);
  const events = markers(result.stdout);
  expect(events).toMatchObject([
    { kind: "shell-start", step: "install_dependencies" },
    { kind: "shell-end", exitCode: 7 },
  ]);
  expect(events[1].time).toBeGreaterThanOrEqual(events[0].time);
});

test("reporter lifecycle records retain both retry attempts without exception payloads", async () => {
  // Exercise the public reporter interface in its own process: no global console
  // mocks, and no nested test runner competing with the monorepo's worker pool.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import Reporter from ${JSON.stringify(new URL("./tracing.ts", import.meta.url).href)};
        const reporter = new Reporter();
        const test = { id: "greets", repeatEachIndex: 0, title: "a quiet retry",
          location: { file: process.cwd() + "/specs/greeting.spec.ts", line: 1 },
          parent: { project: () => ({ name: "web" }) }, expectedStatus: "passed" };
        for (const retry of [0, 1]) {
          const result = { retry, startTime: new Date(), duration: 20, workerIndex: retry,
            status: retry ? "passed" : "failed", errors: [{ message: "secret exception payload" }] };
          reporter.onTestBegin(test, result);
          reporter.onTestEnd(test, result);
        }
      `,
    ],
    {
      cwd: resolve(".."),
      env: { ...process.env, CI_TRACE_ENABLED: "1" },
    },
  );
  const events = markers(stdout);
  expect(events).toMatchObject([
    { kind: "test-start", retry: 0, title: "a quiet retry" },
    { kind: "test-end", status: "failed" },
    { kind: "test-start", retry: 1, title: "a quiet retry" },
    { kind: "test-end", status: "passed" },
  ]);
  expect(events[0].id).not.toBe(events[2].id);
  expect(JSON.stringify(events)).not.toContain("secret exception payload");
});

test("nested concurrent deploys and readiness become measured children of their CI step", async () => {
  const startedAt = new Date().toISOString();
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { traceOperation } from ${JSON.stringify(new URL("./tracing.ts", import.meta.url).href)};
        let release;
        let started = 0;
        const bothStarted = new Promise(resolve => { release = resolve; });
        process.stdout.write("transforming...");
        const result = await traceOperation("Deploy", async () => {
          await Promise.all(["OS", "Auth"].map(name => traceOperation(name, async () => {
            if (++started === 2) release();
            await bothStarted;
            return traceOperation("HTTP readiness", async () => {
              process.stdout.write("transforming...");
              return name;
            });
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
      attributes: expect.arrayContaining([{ key: "ci.status", value: { stringValue: "passed" } }]),
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

test("quiet steps retain their duration, retries have distinct parents, and unfinished tests stay incomplete", () => {
  const workflow = {
    workflowId: "workflow",
    workflowName: "Preview",
    workflowPath: "preview.yml",
    repo: "iterate/iterate",
    headSha: "abc",
    sha: "merge",
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
          kind: "span-start",
          id: "interrupted-child",
          parentId: "",
          name: "Interrupted setup operation",
          time: ms(4),
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
  expect(spans.find((span) => span.name === "Interrupted setup operation")).toMatchObject({
    parentSpanId: install.spanId,
    endTimeUnixNano: install.endTimeUnixNano,
    attributes: expect.arrayContaining([
      { key: "ci.status", value: { stringValue: "incomplete" } },
    ]),
  });
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

test("a second-precision Depot finish does not invent a negative finish phase", () => {
  const report = assembleTrace(
    {
      workflowId: "failed-wait",
      workflowName: "Preview",
      workflowPath: "preview.yml",
      repo: "iterate/iterate",
      headSha: "abc",
      sha: "merge",
      ref: "refs/pull/2681/merge",
      workflowStatus: "failed",
      workflowCreatedAt: at(0),
      workflowFinishedAt: at(34),
      executions: [{ executionId: "one", execution: 1, createdAt: at(0) }],
      jobs: [
        {
          jobId: "shard",
          jobKey: "preview.yml:preview:playwright:matrix-0",
          status: "failed",
          attempts: [
            {
              attemptId: "attempt",
              attempt: 1,
              status: "failed",
              startedAt: at(1),
              finishedAt: at(33),
            },
          ],
        },
      ],
    },
    new Map([
      [
        "attempt",
        [
          line("wait_for_preview", {
            kind: "shell-start",
            id: "wait",
            step: "wait_for_preview",
            time: ms(2),
          }),
          line("wait_for_preview", { kind: "shell-end", id: "wait", time: ms(33.5), exitCode: 1 }),
        ],
      ],
    ]),
  );
  const spans = report.resourceSpans[0].scopeSpans[0].spans;
  const wait = spans.find((span) => span.name === "wait for preview")!;
  const finish = spans.find((span) => span.name === "Finish")!;
  expect(wait).toMatchObject({
    status: { code: 2 },
    endTimeUnixNano: String(BigInt(ms(33.5)) * 1_000_000n),
  });
  expect(finish.startTimeUnixNano).toBe(wait.endTimeUnixNano);
  expect(finish.endTimeUnixNano).toBe(finish.startTimeUnixNano);
  expect(spans.find((span) => span.name === "Playwright 1/6")).toMatchObject({
    endTimeUnixNano: String(BigInt(ms(33)) * 1_000_000n),
  });
});

test("cancelling before runner startup does not invent an attempt duration", () => {
  const trace = assembleTrace(
    {
      workflowId: "cancelled",
      workflowName: "Preview",
      workflowPath: "preview.yml",
      repo: "iterate/iterate",
      headSha: "abc",
      sha: "merge",
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

test("uses authored commands, strips Doppler wrappers and walks parallel/sequential steps", () => {
  const commands = stepCommands(`
jobs:
  prepare:
    steps:
      - id: install_dependencies
        run: pnpm install --frozen-lockfile --prefer-offline
      - id: prepare
        run: >-
          doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN --
          pnpm preview ci-prepare $PREVIEW_TARGET_ARGS
  finish:
    steps:
      - parallel:
          - id: erase
            run: doppler run --project _shared --config prd -- pnpm preview erase
          - sequential:
              - id: merge_reports
                run: pnpm preview ci-finish
`);
  expect(Object.fromEntries(commands)).toEqual({
    "prepare/install_dependencies": "pnpm install --frozen-lockfile --prefer-offline",
    "prepare/prepare": "pnpm preview ci-prepare $PREVIEW_TARGET_ARGS",
    "finish/erase": "pnpm preview erase",
    "finish/merge_reports": "pnpm preview ci-finish",
  });
});

test("the trace status points at the tested commit and keeps the newest execution on replay", () => {
  const run = {
    headSha: "tested-head",
    createdAt: "2026-09-16T12:00:00Z",
    url: "https://iterate.iterate.app/explainers/ci-trace-run1?sha=abc",
  };
  const first = traceCommitStatus(undefined, run);
  expect(first).toMatchObject({
    sha: "tested-head",
    context: "CI trace",
    state: "success",
    target_url: run.url,
  });
  const next = traceCommitStatus(first!, {
    ...run,
    createdAt: "2026-09-16T13:00:00Z",
    url: run.url.replace("run1", "run2"),
  });
  expect(next).toMatchObject({ target_url: run.url.replace("run1", "run2") });
  expect(traceCommitStatus(next!, run)).toBeNull();
  expect(traceCommitStatus(first!, run)).toBeNull();
  // Reconciliation can decide that an execution already has a report before uploading.
  expect(traceCommitStatus(first!, { ...run, url: "" })).toBeNull();
});

test("the standalone report embeds OTLP without allowing source names to break out of JSON", async () => {
  const report = assembleTrace(
    {
      workflowId: "run",
      workflowName: '</script><img src=x onerror="alert(1)">',
      workflowPath: "preview.yml",
      repo: "iterate/iterate",
      headSha: "abc",
      sha: "merge",
      ref: "refs/pull/1/merge",
      workflowStatus: "finished",
      workflowCreatedAt: "2026-09-16T12:00:00Z",
      workflowFinishedAt: "2026-09-16T12:01:00Z",
      executions: [{ executionId: "one", execution: 1, createdAt: "2026-09-16T12:00:00Z" }],
      jobs: [],
    },
    new Map(),
  );
  const html = await renderTrace(report);
  expect(html).not.toContain("<img src=x");
  expect(
    JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)![1]),
  ).toEqual(report);
});

function markers(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("@@ci-trace "))
    .map((line) => JSON.parse(line.slice(11)));
}

const ms = (seconds: number) => Date.parse("2026-09-16T12:00:00Z") + seconds * 1000;
const at = (seconds: number) => new Date(ms(seconds)).toISOString();
const line = (stepKey: string, event: object) => ({
  stepKey: `opaque-${stepKey}`,
  stepId: stepKey,
  body: `@@ci-trace ${JSON.stringify(event)}`,
});
