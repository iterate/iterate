import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { assembleTrace, jobKeyInWorkflow, renderTrace, stepCommands } from "./tracing.ts";

test("workflow queue is visible without removing it from elapsed time", () => {
  const workflow = producerWorkflow("finished");
  const spans = assembleTrace(
    {
      ...workflow,
      workflowStartedAt: at(40),
      executions: [{ ...workflow.executions[0], startedAt: at(40) }],
      jobs: [],
    },
    new Map(),
  ).resourceSpans[0].scopeSpans[0].spans;
  expect(spans[0]).toMatchObject({
    startTimeUnixNano: String(BigInt(ms(0)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(ms(90)) * 1_000_000n),
  });
  expect(spans.find((span) => span.name === "Workflow queue")).toMatchObject({
    parentSpanId: spans[0].spanId,
    startTimeUnixNano: String(BigInt(ms(0)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(ms(40)) * 1_000_000n),
    attributes: expect.arrayContaining([{ key: "ci.phase", value: { stringValue: "wait" } }]),
  });
});

test("queue timing uses the selected rerun, not the original workflow start", () => {
  const workflow = producerWorkflow("finished");
  const spans = assembleTrace(
    {
      ...workflow,
      workflowStartedAt: at(2),
      executions: [
        { ...workflow.executions[0], startedAt: at(2) },
        { executionId: "rerun", execution: 2, createdAt: at(30), startedAt: at(35) },
      ],
    },
    new Map(),
  ).resourceSpans[0].scopeSpans[0].spans;
  expect(spans.find((span) => span.name === "Workflow queue")).toMatchObject({
    startTimeUnixNano: String(BigInt(ms(30)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(ms(35)) * 1_000_000n),
  });
});

test("a workflow cancelled before start shows its wait ending at cancellation", () => {
  const spans = assembleTrace({ ...producerWorkflow("cancelled"), jobs: [] }, new Map())
    .resourceSpans[0].scopeSpans[0].spans;
  expect(spans.find((span) => span.name === "Workflow queue (cancelled)")).toMatchObject({
    startTimeUnixNano: String(BigInt(ms(0)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(ms(90)) * 1_000_000n),
    attributes: expect.arrayContaining([
      { key: "ci.status", value: { stringValue: "cancelled" } },
      {
        key: "ci.evidence",
        value: {
          stringValue: "No execution or runner start recorded; wait ended at workflow cancellation",
        },
      },
    ]),
  });
});

test.each([false, true])(
  "a cancelled rerun does not inherit old runner starts (inline %s)",
  (inline) => {
    const workflow = producerWorkflow("cancelled");
    workflow.jobs[0].attempts[0].finishedAt = at(20);
    const spans = assembleTrace(
      {
        ...workflow,
        executions: [
          { ...workflow.executions[0], startedAt: at(1) },
          { executionId: "cancelled-rerun", execution: 2, createdAt: at(30) },
        ],
        jobs: [
          { ...workflow.jobs[0], finishedAt: at(90) },
          ...(inline
            ? [
                {
                  jobId: "trace",
                  jobKey: "preview-os.yml:trace",
                  status: "cancelled",
                  attempts: [],
                },
              ]
            : []),
        ],
      },
      new Map(),
    ).resourceSpans[0].scopeSpans[0].spans;
    expect(spans[0]).toMatchObject({
      attributes: expect.arrayContaining([
        { key: "ci.execution.id", value: { stringValue: "cancelled-rerun" } },
      ]),
    });
    expect(spans.find((span) => span.name === "Workflow queue (cancelled)")).toMatchObject({
      startTimeUnixNano: String(BigInt(ms(30)) * 1_000_000n),
      endTimeUnixNano: String(BigInt(ms(90)) * 1_000_000n),
    });
  },
);

test("missing execution start does not turn unmeasured runner setup into queue time", () => {
  const spans = assembleTrace(producerWorkflow("cancelled"), new Map()).resourceSpans[0]
    .scopeSpans[0].spans;
  expect(spans.some((span) => span.name.startsWith("Workflow queue"))).toBe(false);
});

test.each(["finished", "failed", "cancelled"])(
  "inline collection reports %s preview jobs while the collector is still running",
  (status) => {
    const workflow = producerWorkflow(status);
    workflow.workflowStatus = "running";
    workflow.workflowFinishedAt = "";
    workflow.jobs.push({
      jobId: "trace",
      jobKey: "preview-os.yml:trace",
      status: "running",
      attempts: [
        {
          attemptId: "trace-attempt",
          attempt: 1,
          status: "running",
          startedAt: at(95),
          finishedAt: "",
        },
      ],
    });
    const spans = assembleTrace(workflow, new Map()).resourceSpans[0].scopeSpans[0].spans;
    expect(spans[0]).toMatchObject({
      endTimeUnixNano: String(BigInt(ms(90)) * 1_000_000n),
      attributes: expect.arrayContaining([
        { key: "ci.status", value: { stringValue: status } },
        {
          key: "ci.report.scope",
          value: { stringValue: "Preparation and tests; reporting and cleanup excluded" },
        },
      ]),
    });
    expect(
      spans.some((span) =>
        span.attributes.some(
          (a) => a.key === "ci.attempt.id" && a.value.stringValue === "trace-attempt",
        ),
      ),
    ).toBe(false);
  },
);

test("replaying an inline report excludes a failed collector from the preview outcome", () => {
  const workflow = producerWorkflow("finished");
  workflow.workflowStatus = "failed";
  workflow.workflowFinishedAt = at(100);
  workflow.jobs.push({
    jobId: "trace",
    jobKey: "preview-os.yml:trace",
    status: "failed",
    attempts: [
      {
        attemptId: "trace-attempt",
        attempt: 1,
        status: "failed",
        startedAt: at(95),
        finishedAt: at(100),
      },
    ],
  });
  expect(assembleTrace(workflow, new Map()).resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
    endTimeUnixNano: String(BigInt(ms(90)) * 1_000_000n),
    attributes: expect.arrayContaining([{ key: "ci.status", value: { stringValue: "finished" } }]),
  });
});

test("retrying only the collector retains the execution that ran the preview", () => {
  const workflow = producerWorkflow("running");
  workflow.workflowFinishedAt = "";
  workflow.jobs[0].status = "finished";
  workflow.jobs[0].attempts[0].status = "finished";
  workflow.executions.push({ executionId: "collector-retry", execution: 2, createdAt: at(120) });
  workflow.jobs.push({
    jobId: "trace",
    jobKey: "preview-os.yml:trace",
    status: "running",
    attempts: [
      {
        attemptId: "trace-retry",
        attempt: 2,
        status: "running",
        startedAt: at(125),
        finishedAt: "",
      },
    ],
  });
  expect(assembleTrace(workflow, new Map()).resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
    startTimeUnixNano: String(BigInt(ms(0)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(ms(90)) * 1_000_000n),
    attributes: expect.arrayContaining([
      { key: "ci.execution.id", value: { stringValue: "execution" } },
    ]),
  });
});

test("inline collection refuses to label still-running preview jobs as finished", () => {
  const workflow = producerWorkflow("running");
  workflow.jobs.push({
    jobId: "trace",
    jobKey: "preview-os.yml:trace",
    status: "running",
    attempts: [],
  });
  expect(() => assembleTrace(workflow, new Map())).toThrow("Preview jobs have not settled");
});

test("time to red uses the first failed job, ignoring a recovered job attempt", () => {
  const workflow = producerWorkflow("failed");
  workflow.jobs.push({
    jobId: "recovered",
    jobKey: "preview-os.yml:e2e",
    status: "finished",
    attempts: [
      { attemptId: "old", attempt: 1, status: "failed", startedAt: at(1), finishedAt: at(20) },
      { attemptId: "new", attempt: 2, status: "finished", startedAt: at(21), finishedAt: at(40) },
    ],
  });
  const trace = assembleTrace(workflow, new Map());
  expect(trace.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
    attributes: expect.arrayContaining([
      { key: "ci.time_to_red_ms", value: { stringValue: "90000" } },
      { key: "ci.red.evidence", value: { stringValue: "First failed job completion (Depot)" } },
    ]),
    events: [
      expect.objectContaining({
        name: "ci.check.red",
        timeUnixNano: String(BigInt(ms(90)) * 1_000_000n),
      }),
    ],
  });
});

test.each(["finished", "cancelled"])("%s workflows do not acquire a time to red", (status) => {
  const workflow = producerWorkflow(status);
  const trace = assembleTrace(workflow, new Map());
  expect(
    trace.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(
      (a) => a.key === "ci.time_to_red_ms",
    ),
  ).toBeUndefined();
});

test.each(["missing", "previous execution"])(
  "a rerun without a current failed job timestamp uses workflow completion (%s)",
  (timing) => {
    const workflow = producerWorkflow("failed");
    workflow.executions.push({ executionId: "rerun", execution: 2, createdAt: at(30) });
    workflow.jobs[0] = { ...workflow.jobs[0], finishedAt: at(90) } as any;
    workflow.jobs[0].attempts[0].finishedAt = timing === "missing" ? "" : at(20);
    const trace = assembleTrace(workflow, new Map());
    expect(trace.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
      attributes: expect.arrayContaining([
        { key: "ci.time_to_red_ms", value: { stringValue: "60000" } },
        {
          key: "ci.red.evidence",
          value: {
            stringValue: "Preview completion (upper bound; no failed job completion recorded)",
          },
        },
      ]),
    });
  },
);

test.each(["finished", "failed", "cancelled"])(
  "only successful completion establishes green (%s)",
  (status) => {
    const trace = assembleTrace(producerWorkflow(status), new Map());
    const root = trace.resourceSpans[0].scopeSpans[0].spans[0];
    const green = root.attributes.find((attribute) => attribute.key === "ci.time_to_green_ms");
    expect(green?.value.stringValue).toBe(status === "finished" ? "90000" : undefined);
  },
);

test("the shell hook preserves failures and does not double-count nested bash", async () => {
  const result = await promisify(execFile)("bash", ["-c", "bash -c 'echo nested'; exit 7"], {
    env: {
      ...process.env,
      BASH_ENV: resolve("ci/tracing/shell.sh"),
      GITHUB_ACTION: "install_dependencies",
      GITHUB_OUTPUT: "",
    },
  }).catch((error) => error);
  expect(result).toMatchObject({ code: 7 });
  const events = markers(result.stdout);
  expect(events).toMatchObject([
    { kind: "shell-start", step: "install_dependencies" },
    { kind: "shell-end", exitCode: 7 },
  ]);
  expect(events[1].time).toBeGreaterThanOrEqual(events[0].time);
});

test.each([0, 7])(
  "the shell hook makes exit %s available to the next step without Depot logs",
  async (exitCode) => {
    const directory = await mkdtemp(resolve(tmpdir(), "ci-verdict-"));
    try {
      const output = resolve(directory, "step-output");
      const result = await promisify(execFile)("bash", ["-c", `exit ${exitCode}`], {
        env: {
          ...process.env,
          BASH_ENV: resolve("ci/tracing/shell.sh"),
          CI_TRACE_SHELL: "",
          GITHUB_OUTPUT: output,
        },
      }).catch((error) => error);
      expect(result.code || 0).toBe(exitCode);
      const record = JSON.parse((await readFile(output, "utf8")).trim().split("ci-trace-end=")[1]);
      expect(record).toEqual(markers(result.stdout).at(-1));
      expect(record).toMatchObject({ kind: "shell-end", exitCode, time: expect.any(Number) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
  expect(events[0]).not.toMatchObject({ id: events[2].id });
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
        const result = await traceOperation("Deploy apps", async () => {
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
      workflowName: "Preview OS",
      workflowPath: "preview-os.yml",
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
          jobId: "deploy",
          jobKey: "preview-os.yml:deploy",
          status: "failed",
          attempts: [{ attemptId: "attempt", attempt: 1, status: "failed", startedAt, finishedAt }],
        },
      ],
    },
    new Map([
      [
        "attempt",
        [
          `@@ci-trace ${JSON.stringify({ kind: "shell-start", id: "shell", step: "deploy", time: Date.parse(startedAt) })}`,
          ...events,
          `@@ci-trace ${JSON.stringify({ kind: "shell-end", id: "shell", exitCode: 1, time: Date.parse(finishedAt) })}`,
        ].map((body) => ({ body, stepKey: "step", stepId: "deploy" })),
      ],
    ]),
  );
  const spans = trace.resourceSpans[0].scopeSpans[0].spans;
  const byName = (name: string) => spans.find((span) => span.name === name)!;
  const deploy = byName("Deploy apps");
  const shell = byName("deploy");
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
    workflowName: "Preview OS",
    workflowPath: "preview-os.yml",
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
        jobId: "e2e",
        jobKey: "preview-os.yml:e2e",
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
        {
          ...line("install_dependencies", {
            kind: "shell-start",
            id: "install",
            step: "__run",
            time: ms(3),
          }),
          stepName: "Install dependencies",
          command: "pnpm install",
        },
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
        {
          ...line("e2e", { kind: "shell-start", id: "tests", step: "suite", time: ms(61) }),
          stepId: "",
          command: "pnpm spec",
        },
        line("e2e", {
          kind: "test-start",
          id: "test/0",
          title: "greets",
          file: "specs/greeting.spec.ts",
          line: 5,
          project: "web",
          retry: 0,
          time: ms(62),
        }),
        line("e2e", {
          kind: "test-end",
          id: "test/0",
          time: ms(82),
          status: "failed",
          expectedStatus: "passed",
          worker: 0,
        }),
        line("e2e", {
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
  const install = spans.find((span) => span.name === "Install dependencies")!;
  expect(install).toMatchObject({
    attributes: expect.arrayContaining([
      { key: "ci.step.name", value: { stringValue: "Install dependencies" } },
      { key: "ci.step.id", value: { stringValue: "install_dependencies" } },
      { key: "ci.command", value: { stringValue: "pnpm install" } },
    ]),
  });
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
  expect(tests[0]).not.toMatchObject({ spanId: tests[1].spanId });
  expect(tests[0]).toMatchObject({ parentSpanId: tests[1].parentSpanId });
  expect(spans.find((span) => span.spanId === tests[0].parentSpanId)).toMatchObject({
    name: "pnpm spec",
  });
  expect(tests[1].attributes).toContainEqual({
    key: "ci.evidence",
    value: { stringValue: "incomplete; end bounded by job finish" },
  });
  expect([...new Set(spans.map((span) => span.traceId))]).toHaveLength(1);
  expect(spans.filter((span) => ["Setup", "Test"].includes(span.name))).toHaveLength(2);
  expect(
    spans.every(
      (span) => !span.parentSpanId || spans.some((parent) => parent.spanId === span.parentSpanId),
    ),
  ).toBe(true);
});

test("a step starting after Depot records cancellation stays incomplete", () => {
  // Preview 9dsvdkskfv: Depot finished the job at 08:22:19, but erase
  // started at 08:22:21.311 without an exit marker.
  const workflow = producerWorkflow("cancelled");
  const report = assembleTrace(
    workflow,
    new Map([
      [
        "deploy-attempt",
        [line("erase", { kind: "shell-start", id: "erase", step: "erase", time: ms(92.311) })],
      ],
    ]),
  );
  const spans = report.resourceSpans[0].scopeSpans[0].spans;
  expect(spans.find((span) => span.name === "erase")).toMatchObject({
    startTimeUnixNano: String(BigInt(ms(92.311)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(ms(92.311)) * 1_000_000n),
    attributes: expect.arrayContaining([
      { key: "ci.status", value: { stringValue: "incomplete" } },
      { key: "ci.evidence", value: { stringValue: "incomplete; enclosing finish precedes start" } },
    ]),
  });
  for (const name of ["Preview OS", "Deploy preview"]) {
    expect(spans.find((span) => span.name === name)).toMatchObject({
      endTimeUnixNano: String(BigInt(ms(90)) * 1_000_000n),
      attributes: expect.arrayContaining([
        { key: "ci.status", value: { stringValue: "cancelled" } },
      ]),
    });
  }
});

test.for([
  {
    kind: "operation",
    event: { kind: "span-start", id: "operation", parentId: "", name: "Erase namespace" },
  },
  {
    kind: "test",
    event: {
      kind: "test-start",
      id: "test",
      title: "cleanup probe",
      file: "specs/cleanup.spec.ts",
      line: 1,
      project: "web",
      retry: 0,
    },
  },
])("unfinished $kind after cancellation keeps its start and unknown outcome", ({ kind, event }) => {
  const report = assembleTrace(
    producerWorkflow("cancelled"),
    new Map([
      [
        "deploy-attempt",
        [
          line("erase", { kind: "shell-start", id: "erase", step: "erase", time: ms(89) }),
          line("erase", { ...event, time: ms(92.311) }),
        ],
      ],
    ]),
  );
  const spans = report.resourceSpans[0].scopeSpans[0].spans;
  const unfinished = spans.find((span) =>
    span.attributes.some(
      (attribute) => attribute.key === "ci.kind" && attribute.value.stringValue === kind,
    ),
  );
  expect(unfinished).toMatchObject({
    startTimeUnixNano: String(BigInt(ms(92.311)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(ms(92.311)) * 1_000_000n),
    attributes: expect.arrayContaining([
      { key: "ci.status", value: { stringValue: "incomplete" } },
      { key: "ci.evidence", value: { stringValue: "incomplete; enclosing finish precedes start" } },
    ]),
  });
});

test.for([
  {
    start: { kind: "shell-start", id: "erase", step: "erase" },
    end: { kind: "shell-end", id: "erase", exitCode: 0 },
    name: "erase",
  },
  {
    start: { kind: "span-start", id: "operation", parentId: "", name: "Erase namespace" },
    end: { kind: "span-end", id: "operation", status: "passed" },
    name: "Erase namespace",
  },
  {
    start: {
      kind: "test-start",
      id: "test",
      title: "cleanup probe",
      file: "specs/cleanup.spec.ts",
      line: 1,
      project: "web",
      retry: 0,
    },
    end: { kind: "test-end", id: "test", status: "passed", expectedStatus: "passed", worker: 0 },
    name: "cleanup probe",
  },
])(
  "$name keeps measured times after cancellation and rejects reversed endpoints",
  ({ start, end, name }) => {
    const workflow = producerWorkflow("cancelled");
    const report = assembleTrace(
      workflow,
      new Map([
        [
          "deploy-attempt",
          [line("erase", { ...start, time: ms(92.311) }), line("erase", { ...end, time: ms(94) })],
        ],
      ]),
    );
    expect(
      report.resourceSpans[0].scopeSpans[0].spans.find((span) => span.name === name),
    ).toMatchObject({
      startTimeUnixNano: String(BigInt(ms(92.311)) * 1_000_000n),
      endTimeUnixNano: String(BigInt(ms(94)) * 1_000_000n),
      attributes: expect.arrayContaining([{ key: "ci.status", value: { stringValue: "passed" } }]),
    });
    expect(() =>
      assembleTrace(
        workflow,
        new Map([
          [
            "deploy-attempt",
            [
              line("erase", { ...start, time: ms(92.311) }),
              line("erase", { ...end, time: ms(91) }),
            ],
          ],
        ]),
      ),
    ).toThrow(`Invalid span interval: ${name}`);
  },
);

test("a second-precision Depot finish does not invent a negative finish phase", () => {
  const report = assembleTrace(
    {
      workflowId: "failed-e2e",
      workflowName: "Preview OS",
      workflowPath: "preview-os.yml",
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
          jobId: "e2e",
          jobKey: "preview-os.yml:e2e",
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
          line("suite", { kind: "shell-start", id: "suite", step: "suite", time: ms(2) }),
          line("suite", { kind: "shell-end", id: "suite", time: ms(33.5), exitCode: 1 }),
        ],
      ],
    ]),
  );
  const spans = report.resourceSpans[0].scopeSpans[0].spans;
  const suite = spans.find((span) => span.name === "suite")!;
  const finish = spans.find((span) => span.name === "Finish")!;
  expect(suite).toMatchObject({
    status: { code: 2 },
    endTimeUnixNano: String(BigInt(ms(33.5)) * 1_000_000n),
  });
  expect(finish).toMatchObject({
    startTimeUnixNano: suite.endTimeUnixNano,
    endTimeUnixNano: finish.startTimeUnixNano,
  });
  expect(spans.find((span) => span.name === "E2E tests")).toMatchObject({
    endTimeUnixNano: String(BigInt(ms(33)) * 1_000_000n),
  });
});

test("cancelling before runner startup does not invent an attempt duration", () => {
  const trace = assembleTrace(
    {
      workflowId: "cancelled",
      workflowName: "Preview OS",
      workflowPath: "preview-os.yml",
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
          jobKey: "preview-os.yml:deploy",
          status: "cancelled",
          attempts: [
            { attemptId: "never-started", attempt: 1, status: "cancelled", finishedAt: at(2) },
          ],
        },
      ],
    },
    new Map(),
  );
  const job = trace.resourceSpans[0].scopeSpans[0].spans.find(
    (span) => span.name === "Deploy preview",
  )!;
  expect(job).toMatchObject({ startTimeUnixNano: job.endTimeUnixNano });
  expect(job.attributes).toContainEqual({
    key: "ci.evidence",
    value: { stringValue: "No runner attempt started" },
  });
});

test("uses authored commands, strips Doppler wrappers and walks parallel/sequential steps", () => {
  const commands = stepCommands(`
jobs:
  deploy:
    steps:
      - id: install_dependencies
        run: pnpm install --frozen-lockfile --prefer-offline
      - id: deploy
        run: >-
          doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN --
          pnpm preview deploy $PREVIEW_ARGS
  e2e:
    steps:
      - parallel:
          - id: specs
            run: doppler run --project _shared --config prd -- pnpm spec
          - sequential:
              - id: e2e
                run: pnpm preview e2e
`);
  expect(Object.fromEntries(commands)).toEqual({
    "deploy/install_dependencies": "pnpm install --frozen-lockfile --prefer-offline",
    "deploy/deploy": "pnpm preview deploy $PREVIEW_ARGS",
    "e2e/specs": "pnpm spec",
    "e2e/e2e": "pnpm preview e2e",
  });
});

test("the standalone report embeds OTLP without allowing source names to break out of JSON", async () => {
  const report = assembleTrace(
    {
      workflowId: "run",
      workflowName: '</script><img src=x onerror="alert(1)">',
      workflowPath: "preview-os.yml",
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

// --- the Preview OS workflow: Deploy preview → E2E tests and Browser specs, then the trace job ---

test("the preview trace covers the deploy and both test jobs: green at the last one's completion, the trace job excluded", () => {
  const trace = assembleTrace(
    osPreviewWorkflow(),
    new Map([
      [
        "e2e-attempt",
        [
          line("install", { kind: "shell-start", id: "install", step: "install", time: ms(42) }),
          line("install", { kind: "shell-end", id: "install", time: ms(50), exitCode: 0 }),
          line("suite", { kind: "shell-start", id: "suite", step: "suite", time: ms(52) }),
          line("suite", { kind: "shell-end", id: "suite", time: ms(170), exitCode: 0 }),
        ],
      ],
      [
        "specs-attempt",
        [
          line("suite", { kind: "shell-start", id: "suite", step: "suite", time: ms(50) }),
          line("suite", { kind: "shell-end", id: "suite", time: ms(110), exitCode: 0 }),
        ],
      ],
    ]),
  );
  const spans = trace.resourceSpans[0].scopeSpans[0].spans;
  expect(spans.map((span) => span.name)).toEqual([
    "Preview OS",
    "Workflow queue",
    "Deploy preview",
    "E2E tests",
    "Setup",
    "Test",
    "Finish",
    "install",
    "suite",
    "Browser specs",
    "Setup",
    "Test",
    "Finish",
    "suite",
  ]);
  expect(spans[0]).toMatchObject({
    endTimeUnixNano: String(BigInt(ms(180)) * 1_000_000n),
    attributes: expect.arrayContaining([
      { key: "ci.status", value: { stringValue: "finished" } },
      { key: "ci.time_to_green_ms", value: { stringValue: "180000" } },
    ]),
  });
  // Each job's suite step opens its Test phase; its exit opens Finish (telemetry and uploads).
  expect(spans.filter((span) => span.name === "Test")).toMatchObject([
    {
      startTimeUnixNano: String(BigInt(ms(52)) * 1_000_000n),
      endTimeUnixNano: String(BigInt(ms(170)) * 1_000_000n),
    },
    {
      startTimeUnixNano: String(BigInt(ms(50)) * 1_000_000n),
      endTimeUnixNano: String(BigInt(ms(110)) * 1_000_000n),
    },
  ]);
});

test("a failed deploy is red at its completion and neither suite ran", () => {
  const workflow = osPreviewWorkflow();
  workflow.jobs[0]!.status = "failed";
  workflow.jobs[0]!.attempts[0]!.status = "failed";
  for (const suite of [workflow.jobs[1]!, workflow.jobs[2]!]) {
    suite.status = "skipped";
    suite.attempts = [];
  }
  const root = assembleTrace(workflow, new Map()).resourceSpans[0].scopeSpans[0].spans[0];
  expect(root).toMatchObject({
    attributes: expect.arrayContaining([
      { key: "ci.status", value: { stringValue: "failed" } },
      { key: "ci.time_to_red_ms", value: { stringValue: "40000" } },
      { key: "ci.red.evidence", value: { stringValue: "First failed job completion (Depot)" } },
    ]),
  });
});

test.each([
  ["preview-os.yml:e2e", "e2e"],
  ["preview-os.yml:specs", "specs"],
  ["preview-os.yml:deploy", "deploy"],
])("%s is job %s of its workflow", (jobKey, key) => {
  expect(jobKeyInWorkflow(jobKey)).toBe(key);
});

function markers(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("@@ci-trace "))
    .map((line) => JSON.parse(line.slice(11)));
}

function producerWorkflow(status: string) {
  return {
    workflowId: "green-workflow",
    workflowName: "Preview OS",
    workflowPath: "preview-os.yml",
    repo: "iterate/iterate",
    headSha: "head",
    sha: "merge",
    ref: "refs/pull/2695/merge",
    workflowStatus: status,
    workflowCreatedAt: at(0),
    workflowFinishedAt: at(90),
    executions: [{ executionId: "execution", execution: 1, createdAt: at(0) }],
    jobs: [
      {
        jobId: "deploy",
        jobKey: "preview-os.yml:deploy",
        status,
        attempts: [
          {
            attemptId: "deploy-attempt",
            attempt: 1,
            status,
            startedAt: at(10),
            finishedAt: at(90),
          },
        ],
      },
    ],
  };
}

/** A Preview OS run: the deploy and both test jobs passed; the trace job is still running. */
function osPreviewWorkflow() {
  const job = (key: string, status: string, startedAt: number, finishedAt: number) => ({
    jobId: key,
    jobKey: `preview-os.yml:${key}`,
    status,
    attempts:
      status === "skipped"
        ? []
        : [
            {
              attemptId: `${key}-attempt`,
              attempt: 1,
              status,
              startedAt: at(startedAt),
              finishedAt: status === "running" ? "" : at(finishedAt),
            },
          ],
  });
  return {
    workflowId: "os-preview",
    workflowName: "Preview OS",
    workflowPath: "preview-os.yml",
    repo: "iterate/iterate",
    headSha: "head",
    sha: "merge",
    ref: "refs/pull/2900/merge",
    workflowStatus: "running",
    workflowCreatedAt: at(0),
    workflowFinishedAt: "",
    executions: [{ executionId: "execution", execution: 1, createdAt: at(0), startedAt: at(2) }],
    jobs: [
      job("deploy", "finished", 3, 40),
      job("e2e", "finished", 41, 180),
      job("specs", "finished", 41, 120),
      job("trace", "running", 181, 0),
    ],
  };
}

const ms = (seconds: number) => Date.parse("2026-09-16T12:00:00Z") + seconds * 1000;
const at = (seconds: number) => new Date(ms(seconds)).toISOString();
const line = (stepKey: string, event: object) => ({
  stepKey: `opaque-${stepKey}`,
  stepId: stepKey,
  body: `@@ci-trace ${JSON.stringify(event)}`,
});
