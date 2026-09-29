import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { parse } from "yaml";
import { z } from "zod";
import { DEPOT_ORG } from "@iterate-com/shared/depot-api";

/** Measured work inside a CI step. Parallel operations keep their own parent. A `phase` colours
 *  its bar in the report: `wait` for time blocked on another job, `setup` for preparation. */
export async function traceOperation<T>(
  what: string | { name: string; phase: OperationPhase },
  operation: (span: { fail(): void }) => Promise<T>,
) {
  const { name, phase } = typeof what === "string" ? { name: what } : what;
  const enabled = process.env.CI_TRACE_ENABLED === "1";
  const id = randomUUID();
  let status = "passed";
  // Build tools write progress without a newline. Keep each marker on its own line.
  if (enabled)
    console.log(
      `\n@@ci-trace ${JSON.stringify({
        kind: "span-start",
        id,
        parentId: parent.getStore() || "",
        name,
        phase,
        time: Date.now(),
      })}`,
    );
  try {
    return await parent.run(id, () =>
      operation({
        fail() {
          status = "failed";
        },
      }),
    );
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    // Names, status and times only: never copy exception payloads into public reports.
    if (enabled)
      console.log(
        `\n@@ci-trace ${JSON.stringify({ kind: "span-end", id, status, time: Date.now() })}`,
      );
  }
}

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
        framework: "playwright",
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

/** ExportTraceServiceRequest (OTLP/JSON). IDs are deterministic per Depot execution. */
export function assembleTrace(
  input: unknown,
  // Step metadata is absent on older Depot records.
  logs: Map<
    string,
    { stepKey: string; body: string; stepId?: string; stepName?: string; command?: string }[]
  >,
) {
  const workflow = Workflow.parse(input);
  // The trace job collects this report, so it is not in it.
  workflow.jobs = workflow.jobs.filter((job) => !job.jobKey.endsWith(":trace"));
  if (
    workflow.jobs.some(
      (job) => !["finished", "failed", "cancelled", "skipped"].includes(job.status),
    )
  )
    throw new Error("Preview jobs have not settled");
  const ends = workflow.jobs
    .flatMap((job) => [job.finishedAt, ...job.attempts.map((attempt) => attempt.finishedAt)])
    .filter(Boolean)
    .map((time) => Date.parse(time));
  const rootEnd = ends.length ? Math.max(...ends) : Date.parse(workflow.workflowFinishedAt);
  // Retrying only cleanup/reporting must not create a new test execution.
  const executions = [...workflow.executions].sort((a, b) => b.execution - a.execution);
  const execution = executions.find((execution) => Date.parse(execution.createdAt) <= rootEnd);
  if (!execution) throw new Error("Depot workflow has no execution for its preview jobs");
  const rootStart = Date.parse(execution.createdAt);
  const eventsByAttempt = new Map(
    [...logs].map(([id, lines]) => [
      id,
      lines.flatMap((line) => {
        if (!line.body.startsWith("@@ci-trace ")) return [];
        const event = TraceEvent.parse(JSON.parse(line.body.slice("@@ci-trace ".length)));
        return [
          {
            ...event,
            ...(event.kind === "shell-start" && { step: line.stepId || event.step }),
            stepKey: line.stepKey,
            stepId: line.stepId || "",
            stepName: line.stepName || "",
            command: line.command || "",
          },
        ];
      }),
    ]),
  );
  workflow.workflowFinishedAt = new Date(rootEnd).toISOString();
  if (workflow.jobs.some((job) => job.status === "failed")) workflow.workflowStatus = "failed";
  else if (workflow.jobs.some((job) => job.status === "cancelled"))
    workflow.workflowStatus = "cancelled";
  else if (workflow.jobs.length && workflow.jobs.every((job) => job.status === "skipped"))
    workflow.workflowStatus = "skipped";
  else if (workflow.jobs.length) workflow.workflowStatus = "finished";
  const traceId = hash(`${workflow.workflowId}/${execution.executionId}`, 32);
  const spans: Span[] = [];
  const add = (
    id: string,
    parentSpanId: string,
    name: string,
    start: number,
    end: number,
    attributes: Record<string, string>,
    failed: boolean,
  ) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error(`Invalid span interval: ${name}`);
    const span: Span = {
      traceId,
      spanId: hash(`${traceId}/${id}`, 16),
      parentSpanId,
      name,
      kind: 1,
      startTimeUnixNano: (BigInt(Math.round(start * 1000)) * 1000n).toString(),
      endTimeUnixNano: (BigInt(Math.round(end * 1000)) * 1000n).toString(),
      attributes: Object.entries(attributes).map(([key, stringValue]) => ({
        key,
        value: { stringValue },
      })),
      status: { code: failed ? 2 : 0 },
      links: [],
    };
    spans.push(span);
    return span.spanId;
  };
  const root = add(
    "workflow",
    "",
    workflow.workflowName,
    rootStart,
    rootEnd,
    {
      "ci.kind": "workflow",
      "ci.report.scope": "Preparation and tests; reporting and cleanup excluded",
      "ci.status": workflow.workflowStatus,
      "ci.workflow.id": workflow.workflowId,
      "ci.execution.id": execution.executionId,
      "ci.source.sha": workflow.headSha,
      "ci.workflow.sha": workflow.sha,
      "ci.source.ref": workflow.ref,
      "ci.url": `https://depot.dev/orgs/${DEPOT_ORG}/workflows/${workflow.workflowId}`,
      "ci.evidence":
        "Depot timestamps; shell and test lifecycle markers. Uninstrumented action time remains in its enclosing job.",
    },
    workflow.workflowStatus === "failed",
  );
  const cancelledBeforeStart =
    !execution.startedAt &&
    workflow.workflowStatus === "cancelled" &&
    !workflow.jobs.some((job) =>
      job.attempts.some(
        (attempt) =>
          attempt.startedAt &&
          Date.parse(attempt.finishedAt || workflow.workflowFinishedAt) >= rootStart,
      ),
    );
  const queueEnd = cancelledBeforeStart ? rootEnd : Date.parse(execution.startedAt);
  if (queueEnd > rootStart) {
    add(
      "workflow-queue",
      root,
      cancelledBeforeStart ? "Workflow queue (cancelled)" : "Workflow queue",
      rootStart,
      queueEnd,
      {
        "ci.kind": "queue",
        "ci.phase": "wait",
        "ci.status": cancelledBeforeStart ? "cancelled" : "finished",
        "ci.evidence": cancelledBeforeStart
          ? "No execution or runner start recorded; wait ended at workflow cancellation"
          : "Depot execution createdAt to startedAt; queue reason is not supplied",
      },
      false,
    );
  }
  /** Each job's row by its key, its newest attempt's: the parent of the jobs nested under it. The
   *  trace job names the parent first (tracing/cli.ts). */
  const jobSpans = new Map<string, string>();
  for (const job of workflow.jobs) {
    const key = jobKeyInWorkflow(job.jobKey);
    const parent = jobSpans.get(nestedJobs.get(key) || "") || root;
    // a matrix leg by its own name, `Browser specs 3/10`
    const name = jobLabels.get(key) || job.jobDisplayName || key;
    const attempts = job.attempts.filter(
      (attempt) =>
        attempt.startedAt &&
        Date.parse(attempt.finishedAt || workflow.workflowFinishedAt) >= rootStart,
    );
    if (!attempts.length) {
      jobSpans.set(
        key,
        add(
          job.jobId,
          parent,
          name,
          rootEnd,
          rootEnd,
          { "ci.kind": "job", "ci.status": job.status, "ci.evidence": "No runner attempt started" },
          false,
        ),
      );
    }
    const newest = Math.max(...attempts.map((attempt) => attempt.attempt));
    for (const attempt of attempts) {
      const start = Date.parse(attempt.startedAt);
      const end = Date.parse(attempt.finishedAt || workflow.workflowFinishedAt);
      const jobSpan = add(
        attempt.attemptId,
        parent,
        `${name}${attempt.attempt > 1 ? ` (attempt ${attempt.attempt})` : ""}`,
        start,
        end,
        {
          "ci.kind": "job",
          "ci.status": attempt.status,
          "ci.job.key": job.jobKey,
          "ci.attempt.id": attempt.attemptId,
          "ci.evidence": attempt.finishedAt
            ? "Depot timestamps"
            : "incomplete; end bounded by workflow finish",
          "ci.url": `https://depot.dev/orgs/${DEPOT_ORG}/workflows/${workflow.workflowId}?job=${job.jobId}&attempt=${attempt.attemptId}`,
        },
        attempt.status === "failed",
      );
      if (attempt.attempt === newest) jobSpans.set(key, jobSpan);
      const events = eventsByAttempt.get(attempt.attemptId) || [];
      const shells = events.filter((event) => event.kind === "shell-start");
      const shellEnds = new Map(
        events.filter((event) => event.kind === "shell-end").map((event) => [event.id, event]),
      );
      const testEnds = new Map(
        events.filter((event) => event.kind === "test-end").map((event) => [event.id, event]),
      );
      // A test job's suite step (`suite` in E2E tests and Browser specs, one definition in
      // preview-os.yml) splits its steps into setup, test and finish, which colour their bars. The
      // steps sit directly under the job.
      const suite = shells.find((event) => event.step === "suite");
      const suiteEnd = suite && shellEnds.get(suite.id)?.time;
      // none for a job without a suite step (Deploy preview)
      const phaseOf = (time: number) => {
        if (!suite) return "";
        if (time < suite.time) return "setup";
        return suiteEnd === undefined || time < suiteEnd ? "test" : "finish";
      };
      // A job whose row holds other jobs keeps its own steps in one row above them: Browser specs'
      // "Coordinate shards", its collect step no row either, that step's wait, downloads and merge
      // beside its checkout and setup.
      const coordinatorRow = coordinatorRows.get(key);
      const collect = coordinatorRow && shells.find((event) => event.step === "collect");
      const home =
        coordinatorRow && shells.length
          ? add(
              `${attempt.attemptId}/coordinate`,
              jobSpan,
              coordinatorRow,
              Math.min(...shells.map((shell) => shell.time)),
              Math.max(
                ...shells.map(
                  (shell) => shellEnds.get(shell.id)?.time || Math.max(shell.time, end),
                ),
              ),
              {
                "ci.kind": "group",
                "ci.status": attempt.status,
                "ci.evidence": "Its steps' first start to their last exit (measured shell markers)",
              },
              attempt.status === "failed",
            )
          : jobSpan;
      const stepParents = new Map<string, string>();
      const stepEnds = new Map<string, number>();
      for (const shell of shells) {
        const done = shellEnds.get(shell.id);
        // Cancellation can record a job finish before always() cleanup starts.
        // With no exit marker, keep it incomplete at its start instead of
        // inventing a negative duration. Measured intervals still validate below.
        const shellEnd = done?.time || Math.max(shell.time, end);
        stepEnds.set(shell.stepKey, shellEnd);
        // A suite step is no row of its own: what it runs sits under the job with its other steps,
        // its set-up and deploy wait as they are, and its tests in one "Run tests" row (below).
        if (shell === suite || shell === collect) continue;
        const id = add(
          `${attempt.attemptId}/shell/${shell.id}`,
          home,
          shell.stepName || shell.stepId || shell.command || shell.step,
          shell.time,
          shellEnd,
          {
            "ci.kind": "step",
            "ci.phase": phaseOf(shell.time),
            "ci.step.key": shell.stepKey,
            "ci.step.id": shell.stepId,
            "ci.step.name": shell.stepName,
            "ci.command": shell.command,
            "ci.status": done ? (done.exitCode ? "failed" : "passed") : "incomplete",
            "ci.evidence": done
              ? "Measured shell start/exit"
              : shell.time > end
                ? "incomplete; enclosing finish precedes start"
                : "incomplete; end bounded by job finish",
          },
          !!done?.exitCode,
        );
        stepParents.set(shell.stepKey, id);
      }
      const operations = events.filter((event) => event.kind === "span-start");
      const operationIds = new Map(
        operations.map((event) => [
          event.id,
          hash(`${traceId}/${attempt.attemptId}/operation/${event.id}`, 16),
        ]),
      );
      const operationEnds = new Map(
        events.filter((event) => event.kind === "span-end").map((event) => [event.id, event]),
      );
      for (const operation of operations) {
        const done = operationEnds.get(operation.id);
        const enclosingEnd = stepEnds.get(operation.stepKey) || end;
        if (operation.parentId && !operationIds.has(operation.parentId))
          throw new Error(`Missing parent for CI operation: ${operation.name}`);
        add(
          `${attempt.attemptId}/operation/${operation.id}`,
          operationIds.get(operation.parentId) || stepParents.get(operation.stepKey) || home,
          operation.name,
          operation.time,
          done?.time || Math.max(operation.time, enclosingEnd),
          {
            "ci.kind": "operation",
            // none, like a step outside a test job
            "ci.phase": operation.phase || "",
            "ci.status": done?.status || "incomplete",
            "ci.evidence": done
              ? "Measured operation start/end"
              : operation.time > enclosingEnd
                ? "incomplete; enclosing finish precedes start"
                : "incomplete; end bounded by enclosing step/job finish",
          },
          done?.status === "failed",
        );
      }
      // RUN TESTS: the suite step's tests, from the end of its set-up and deploy wait (its own
      // operations) to the step's exit, which Playwright's or vitest's start and report fall in.
      // Also a row, with no tests in it, for a suite that failed after its wait and ran none.
      const tests = events.filter((event) => event.kind === "test-start");
      if (suite) {
        const setUp = operations
          .filter((operation) => operation.stepKey === suite.stepKey && !operation.parentId)
          .map((operation) => operationEnds.get(operation.id)?.time || operation.time);
        const suiteTests = tests.filter((test) => test.stepKey === suite.stepKey);
        const runEnd = suiteEnd || Math.max(suite.time, end);
        const runStart = Math.min(
          Math.max(suite.time, ...setUp),
          ...suiteTests.map((test) => test.time),
          runEnd,
        );
        const exitCode = shellEnds.get(suite.id)?.exitCode;
        const setUpFailed = operations.some(
          (operation) =>
            operation.stepKey === suite.stepKey &&
            operationEnds.get(operation.id)?.status === "failed",
        );
        if (suiteTests.length || (exitCode && !setUpFailed))
          stepParents.set(
            suite.stepKey,
            add(
              `${attempt.attemptId}/run-tests`,
              jobSpan,
              "Run tests",
              runStart,
              runEnd,
              {
                "ci.kind": "step",
                "ci.phase": "test",
                "ci.step.key": suite.stepKey,
                "ci.step.id": suite.stepId,
                "ci.step.name": suite.stepName,
                "ci.command": suite.command,
                "ci.status": exitCode === undefined ? "incomplete" : exitCode ? "failed" : "passed",
                "ci.evidence":
                  "The suite step's exit, from the end of its set-up and deploy wait (measured operations)",
              },
              !!exitCode,
            ),
          );
      }
      for (const test of tests) {
        const done = testEnds.get(test.id);
        const aggregate = test.framework === "vitest";
        const retryCount = done?.retryCount || 0;
        const suffix = aggregate
          ? retryCount
            ? ` · ${retryCount} ${retryCount === 1 ? "retry" : "retries"}`
            : ""
          : test.retry
            ? ` · retry ${test.retry}`
            : "";
        add(
          `${attempt.attemptId}/test/${test.id}`,
          stepParents.get(test.stepKey) || home,
          `${test.title}${suffix}`,
          test.time,
          done?.time || Math.max(test.time, end),
          {
            "ci.kind": "test",
            "ci.status": done?.status || "incomplete",
            "ci.evidence": done
              ? aggregate
                ? "Vitest startTime + duration; includes hooks and all retries"
                : "Playwright startTime + duration"
              : test.time > end
                ? "incomplete; enclosing finish precedes start"
                : "incomplete; end bounded by job finish",
            "test.framework": test.framework,
            "test.attempt_detail": aggregate ? "aggregate-only" : "complete",
            ...(aggregate && done && { "test.retry_count": String(retryCount) }),
            "test.file": test.file,
            "test.line": String(test.line),
            "test.project": test.project,
            "test.retry": String(test.retry),
            "test.expected_status": done?.expectedStatus || "unknown",
            "test.worker": typeof done?.worker === "number" ? String(done.worker) : "unknown",
          },
          !!done && done.status !== done.expectedStatus && done.status !== "skipped",
        );
      }
    }
  }
  if (workflow.workflowStatus === "finished") {
    const green = { time: rootEnd, evidence: "Successful preview completion" };
    const workflowSpan = spans[0];
    workflowSpan.attributes.push(
      { key: "ci.time_to_green_ms", value: { stringValue: String(green.time - rootStart) } },
      { key: "ci.green.evidence", value: { stringValue: green.evidence } },
    );
    workflowSpan.events = [
      {
        name: "ci.check.green",
        timeUnixNano: (BigInt(Math.round(green.time * 1000)) * 1000n).toString(),
        attributes: [{ key: "ci.evidence", value: { stringValue: green.evidence } }],
      },
    ];
  }
  if (workflow.workflowStatus === "failed") {
    // Job outcomes, not test/step failures that may recover on retry. Ignore
    // failed attempts of recovered jobs and timestamps from previous executions.
    const failedAt = workflow.jobs
      .filter((job) => job.status === "failed")
      .flatMap((job) => job.attempts)
      .filter((attempt) => attempt.status === "failed" && attempt.finishedAt)
      .map((attempt) => Date.parse(attempt.finishedAt))
      .filter((time) => time >= rootStart && time <= rootEnd)
      .sort((a, b) => a - b)[0];
    const red = failedAt ?? rootEnd;
    const evidence =
      failedAt === undefined
        ? "Preview completion (upper bound; no failed job completion recorded)"
        : "First failed job completion (Depot)";
    spans[0].attributes.push(
      { key: "ci.time_to_red_ms", value: { stringValue: String(red - rootStart) } },
      { key: "ci.red.evidence", value: { stringValue: evidence } },
    );
    spans[0].events = [
      ...(spans[0].events || []),
      {
        name: "ci.check.red",
        timeUnixNano: (BigInt(red) * 1_000_000n).toString(),
        attributes: [{ key: "ci.evidence", value: { stringValue: evidence } }],
      },
    ];
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "iterate-preview-ci" } },
            { key: "vcs.repository.name", value: { stringValue: workflow.repo } },
          ],
        },
        scopeSpans: [{ scope: { name: "iterate.ci", version: "1" }, spans }],
      },
    ],
  };
}

/** A job's key inside its workflow file: `preview-os.yml:e2e` → `e2e`, and a matrix leg's its job's:
 *  `preview-os.yml:specs-shard:matrix-3` → `specs-shard`. */
export function jobKeyInWorkflow(jobKey: string) {
  return jobKey.replace(/^.*?\.yml:/, "").replace(/:matrix-\d+$/, "");
}

/** Use source YAML, never expanded runner commands that could contain credentials. */
export function stepCommands(source: string) {
  const workflow = SourceWorkflow.parse(parse(source));
  const commands = new Map<string, string>();
  for (const [job, definition] of Object.entries(workflow.jobs)) {
    function visit(value: unknown) {
      const step = Step.parse(value);
      if (step.id && step.run) {
        commands.set(
          `${job}/${step.id}`,
          step.run
            .replace(/\\\r?\n\s*/g, " ")
            .replace(/(^|\n)[ \t]*doppler run\b[^\n]*? --[ \t]+/g, "$1")
            .trim(),
        );
      }
      for (const child of [...(step.parallel || []), ...(step.sequential || [])]) visit(child);
    }
    for (const step of definition.steps) visit(step);
  }
  return commands;
}

/**
 * The jobs a workflow's `trace` job needs: the ones its trace covers. A job outside them (Main OS
 * e2e's alert) can still be running while the trace job collects.
 */
export function tracedJobs(source: string) {
  return TraceJob.parse(parse(source)).jobs.trace.needs;
}

export async function renderTrace(trace: ReturnType<typeof assembleTrace>) {
  const template = await readFile(new URL("./viewer.html", import.meta.url), "utf8");
  // Escaping '<' prevents test names containing </script> from executing as HTML.
  return template.replace("__TRACE_DATA__", JSON.stringify(trace).replaceAll("<", "\\u003c"));
}

const parent = new AsyncLocalStorage<string>();

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } }[];
  events?: {
    name: string;
    timeUnixNano: string;
    attributes: { key: string; value: { stringValue: string } }[];
  }[];
  status: { code: number };
  links: never[];
};

export const Workflow = z.object({
  workflowId: z.string(),
  workflowName: z.string(),
  workflowPath: z.string(),
  repo: z.string(),
  headSha: z.string(),
  sha: z.string(),
  ref: z.string(),
  workflowStatus: z.string(),
  workflowCreatedAt: z.string(),
  workflowFinishedAt: z.string().default(""),
  executions: z.array(
    z.object({
      executionId: z.string(),
      execution: z.number(),
      createdAt: z.string(),
      startedAt: z.string().default(""),
    }),
  ),
  jobs: z.array(
    z.object({
      jobId: z.string(),
      jobKey: z.string(),
      jobDisplayName: z.string().default(""),
      status: z.string(),
      finishedAt: z.string().default(""),
      attempts: z
        .array(
          z.object({
            attemptId: z.string(),
            attempt: z.number(),
            status: z.string(),
            startedAt: z.string().default(""),
            finishedAt: z.string().default(""),
          }),
        )
        .default([]),
    }),
  ),
});

const OperationPhase = z.enum(["setup", "wait"]);
type OperationPhase = z.infer<typeof OperationPhase>;

const TraceEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("span-start"),
    id: z.string(),
    parentId: z.string(),
    name: z.string(),
    // absent on markers from before operations had phases, and on most operations since
    phase: OperationPhase.optional(),
    time: z.number().finite(),
  }),
  z.object({
    kind: z.literal("span-end"),
    id: z.string(),
    status: z.enum(["passed", "failed"]),
    time: z.number().finite(),
  }),
  z.object({
    kind: z.literal("shell-start"),
    id: z.string(),
    step: z.string(),
    time: z.number().finite(),
  }),
  z.object({
    kind: z.literal("shell-end"),
    id: z.string(),
    time: z.number().finite(),
    exitCode: z.number(),
  }),
  z.object({
    kind: z.literal("test-start"),
    id: z.string(),
    time: z.number().finite(),
    title: z.string(),
    framework: z.enum(["playwright", "vitest"]),
    file: z.string(),
    line: z.number(),
    project: z.string(),
    retry: z.number(),
  }),
  z.object({
    kind: z.literal("test-end"),
    id: z.string(),
    time: z.number().finite(),
    status: z.string(),
    expectedStatus: z.string(),
    worker: z.number().optional(),
    retryCount: z.number().int().nonnegative().optional(),
  }),
]);

function hash(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

const SourceWorkflow = z.object({
  jobs: z.record(z.string(), z.object({ steps: z.array(z.unknown()) })),
});
/** Jobs drawn under another job's row, by key: the Browser specs shards, the legs of `specs-shard`,
 *  under `specs`, the job that waits for them and gives their verdict (scripts/ci/specs-shards.ts).
 *  That job's own steps sit in one row above them, named here. */
const nestedJobs = new Map([["specs-shard", "specs"]]);
const coordinatorRows = new Map([["specs", "Coordinate shards"]]);
const jobLabels = new Map([
  ["deploy", "Deploy preview"],
  ["e2e", "E2E tests"],
  ["specs", "Browser specs"],
]);
const TraceJob = z.object({
  jobs: z.object({ trace: z.object({ needs: z.array(z.string()).min(1) }) }),
});
const Step = z.object({
  id: z.string().optional(),
  run: z.string().optional(),
  parallel: z.array(z.unknown()).optional(),
  sequential: z.array(z.unknown()).optional(),
});
