import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { parse } from "yaml";
import { z } from "zod";

/** Measured work inside a CI step. Parallel operations keep their own parent. */
export async function traceOperation<T>(
  name: string,
  operation: (span: { fail(): void }) => Promise<T>,
) {
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
  const inlineReport = workflow.jobs.some((job) => job.jobKey.endsWith(":trace"));
  if (inlineReport) {
    workflow.jobs = workflow.jobs.filter((job) => !job.jobKey.endsWith(":trace"));
    if (
      !workflow.jobs.length ||
      workflow.jobs.some(
        (job) => !["finished", "failed", "cancelled", "skipped"].includes(job.status),
      )
    )
      throw new Error("Preview jobs have not settled");
    // The report job keeps the outer workflow running. Bound this trace by the
    // completed producer jobs, not by our own collection/upload time.
    const ends = workflow.jobs
      .flatMap((job) => [job.finishedAt, ...job.attempts.map((attempt) => attempt.finishedAt)])
      .filter(Boolean)
      .map((time) => Date.parse(time));
    workflow.workflowFinishedAt = new Date(Math.max(...ends)).toISOString();
    workflow.workflowStatus = workflow.jobs.some((job) => job.status === "failed")
      ? "failed"
      : workflow.jobs.some((job) => job.status === "cancelled")
        ? "cancelled"
        : workflow.jobs.every((job) => job.status === "skipped")
          ? "skipped"
          : "finished";
  }
  // A collector-only retry creates an execution without new preview work.
  // Keep the original execution identity instead of starting after its jobs ended.
  const execution = [...workflow.executions]
    .sort((a, b) => b.execution - a.execution)
    .find(
      (execution) =>
        !inlineReport || Date.parse(execution.createdAt) <= Date.parse(workflow.workflowFinishedAt),
    );
  if (!execution) throw new Error("Depot workflow has no execution for its preview jobs");
  const traceId = hash(`${workflow.workflowId}/${execution.executionId}`, 32);
  const spans: Span[] = [];
  const dependencies: { sourceId: string; targetId: string; milestone: string }[] = [];
  const rootStart = Date.parse(execution.createdAt);
  const rootEnd = Date.parse(workflow.workflowFinishedAt);
  const greenSignals: { time: number; evidence: string }[] = [];
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
      ...(inlineReport && {
        "ci.report.scope": "Preview jobs through cleanup; report generation excluded",
      }),
      "ci.status": workflow.workflowStatus,
      "ci.workflow.id": workflow.workflowId,
      "ci.execution.id": execution.executionId,
      "ci.source.sha": workflow.headSha,
      "ci.workflow.sha": workflow.sha,
      "ci.source.ref": workflow.ref,
      "ci.url": `https://depot.dev/orgs/0p91s0lz49/workflows/${workflow.workflowId}`,
      "ci.evidence":
        "Depot timestamps; shell and Playwright lifecycle markers. Uninstrumented action time remains in its enclosing job/phase.",
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
  for (const job of workflow.jobs) {
    const key = job.jobKey.replace(/^.*:preview:/, "");
    const labels: Record<string, string> = {
      plan: "Plan",
      prepare: "Prepare",
      apps: "App tests",
      finish: "Reports & cleanup",
    };
    const name =
      labels[key] ||
      job.jobKey
        .replace(/^.*:preview:/, "")
        .replace(/playwright:matrix-(\d+)/, (_, index) => `Playwright ${Number(index) + 1}/6`);
    const attempts = job.attempts.filter(
      (attempt) =>
        attempt.startedAt &&
        Date.parse(attempt.finishedAt || workflow.workflowFinishedAt) >= rootStart,
    );
    if (!attempts.length) {
      add(
        job.jobId,
        root,
        name,
        rootEnd,
        rootEnd,
        { "ci.kind": "job", "ci.status": job.status, "ci.evidence": "No runner attempt started" },
        false,
      );
    }
    for (const attempt of attempts) {
      const start = Date.parse(attempt.startedAt);
      const end = Date.parse(attempt.finishedAt || workflow.workflowFinishedAt);
      const jobSpan = add(
        attempt.attemptId,
        root,
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
          "ci.url": `https://depot.dev/orgs/0p91s0lz49/workflows/${workflow.workflowId}?job=${job.jobId}&attempt=${attempt.attemptId}`,
        },
        attempt.status === "failed",
      );
      const events = (logs.get(attempt.attemptId) || []).flatMap((line) => {
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
      });
      const shells = events.filter((event) => event.kind === "shell-start");
      const shellEnds = new Map(
        events.filter((event) => event.kind === "shell-end").map((event) => [event.id, event]),
      );
      const green = events.find((event) => event.kind === "check-green");
      if (green) {
        greenSignals.push({ time: green.time, evidence: "GitHub check update acknowledged" });
      } else if (key === "finish") {
        // Historical runs predate the explicit marker. A successful end of
        // the early-green step bounds the acknowledgement a few ms earlier.
        const publish = shells.find((event) => event.step === "tests_passed");
        const done = publish && shellEnds.get(publish.id);
        if (done?.exitCode === 0)
          greenSignals.push({ time: done.time, evidence: "Successful early-green step end" });
      }
      const testEnds = new Map(
        events.filter((event) => event.kind === "test-end").map((event) => [event.id, event]),
      );
      const wait = shells.find(
        (event) => event.step === "wait_for_preview" || event.step === "consumers",
      );
      const tests = shells.find(
        (event) => event.step === "playwright" || event.step === "app_tests",
      );
      const boundaries = [{ name: "Setup", time: start }];
      if (wait) boundaries.push({ name: "Wait", time: wait.time });
      if (tests) {
        boundaries.push({ name: "Test", time: tests.time });
        const done = shellEnds.get(tests.id);
        if (done) boundaries.push({ name: "Finish", time: done.time });
      } else if (wait) {
        const done = shellEnds.get(wait.id);
        if (done) boundaries.push({ name: "Finish", time: done.time });
      }
      const phases =
        wait || tests
          ? boundaries.map((boundary, index) => {
              // Depot job finishes have whole-second precision. A final marker can
              // fall later within that second: retain both source timestamps,
              // but give the derived trailing phase zero duration, not negative.
              const phaseEnd = boundaries[index + 1]?.time || Math.max(boundary.time, end);
              return {
                start: boundary.time,
                end: phaseEnd,
                id: add(
                  `${attempt.attemptId}/phase/${index}`,
                  jobSpan,
                  boundary.name,
                  boundary.time,
                  phaseEnd,
                  {
                    "ci.kind": "phase",
                    "ci.phase": boundary.name.toLowerCase(),
                    "ci.evidence":
                      "Grouping from measured step boundaries; includes action/runner gaps",
                  },
                  false,
                ),
              };
            })
          : [];
      const stepParents = new Map<string, string>();
      const stepEnds = new Map<string, number>();
      for (const shell of shells) {
        const done = shellEnds.get(shell.id);
        // Cancellation can record a job finish before always() cleanup starts.
        // With no exit marker, keep it incomplete at its start instead of
        // inventing a negative duration. Measured intervals still validate below.
        const shellEnd = done?.time || Math.max(shell.time, end);
        const parent =
          phases.findLast((phase) => shell.time >= phase.start && shell.time < phase.end)?.id ||
          jobSpan;
        const id = add(
          `${attempt.attemptId}/shell/${shell.id}`,
          parent,
          shell.stepName || shell.stepId || shell.command || shell.step,
          shell.time,
          shellEnd,
          {
            "ci.kind": "step",
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
        stepEnds.set(shell.stepKey, shellEnd);
      }
      for (const event of events) {
        if (event.kind === "milestone") {
          add(
            `${attempt.attemptId}/milestone/${event.name}`,
            stepParents.get(event.stepKey) || jobSpan,
            event.name,
            event.time,
            event.time,
            { "ci.kind": "milestone", "ci.evidence": "Status publication succeeded" },
            false,
          );
        }
        if (event.kind === "dependency") {
          dependencies.push({
            sourceId: stepParents.get(event.stepKey) || jobSpan,
            targetId: event.targetId,
            milestone: event.milestone,
          });
        }
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
          operationIds.get(operation.parentId) || stepParents.get(operation.stepKey) || jobSpan,
          operation.name,
          operation.time,
          done?.time || Math.max(operation.time, enclosingEnd),
          {
            "ci.kind": "operation",
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
      for (const test of events.filter((event) => event.kind === "test-start")) {
        const done = testEnds.get(test.id);
        add(
          `${attempt.attemptId}/test/${test.id}`,
          stepParents.get(test.stepKey) || jobSpan,
          `${test.title}${test.retry ? ` · retry ${test.retry}` : ""}`,
          test.time,
          done?.time || Math.max(test.time, end),
          {
            "ci.kind": "test",
            "ci.status": done?.status || "incomplete",
            "ci.evidence": done
              ? "Playwright startTime + duration"
              : test.time > end
                ? "incomplete; enclosing finish precedes start"
                : "incomplete; end bounded by job finish",
            "test.file": test.file,
            "test.line": String(test.line),
            "test.project": test.project,
            "test.retry": String(test.retry),
            "test.expected_status": done?.expectedStatus || "unknown",
            "test.worker": done ? String(done.worker) : "unknown",
          },
          !!done && done.status !== done.expectedStatus && done.status !== "skipped",
        );
      }
    }
  }
  // Resolve after collecting every job; Depot need not return producers first.
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  for (const dependency of dependencies) {
    const source = byId.get(dependency.sourceId)!;
    const milestone =
      dependency.milestone &&
      byId.get(hash(`${traceId}/${dependency.targetId}/milestone/${dependency.milestone}`, 16));
    // Cancelled runners can have an attempt ID without ever starting. Their
    // evidence is the zero-duration job placeholder, not an invented attempt.
    const unstartedJob = workflow.jobs.find((job) =>
      job.attempts.some(
        (attempt) => attempt.attemptId === dependency.targetId && !attempt.startedAt,
      ),
    );
    const target =
      milestone || byId.get(hash(`${traceId}/${unstartedJob?.jobId || dependency.targetId}`, 16));
    if (!target) throw new Error(`Missing CI dependency target: ${dependency.targetId}`);
    source.links.push({
      traceId,
      spanId: target.spanId,
      attributes: [
        {
          key: "ci.link.label",
          value: {
            stringValue: dependency.milestone
              ? `Requires ${dependency.milestone}${milestone ? "" : " (not observed)"}`
              : "Waits for job to settle",
          },
        },
      ],
    });
  }
  const firstGreen = greenSignals
    .filter((signal) => signal.time >= rootStart && signal.time <= rootEnd)
    .sort((a, b) => a.time - b.time)[0];
  // Without early completion, a successful workflow goes green at its end.
  // Failed/cancelled workflows have no green time unless one was observed.
  const green =
    firstGreen ||
    (workflow.workflowStatus === "finished"
      ? { time: rootEnd, evidence: "Successful workflow completion" }
      : null);
  if (green) {
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
    const red = failedAt === undefined ? rootEnd : failedAt;
    const evidence =
      failedAt === undefined
        ? "Failed workflow completion (upper bound; no failed job completion recorded)"
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
  links: { traceId: string; spanId: string; attributes: Span["attributes"] }[];
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

const TraceEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dependency"),
    targetId: z.string().min(1),
    milestone: z.string(),
  }),
  z.object({
    kind: z.literal("milestone"),
    name: z.string().min(1),
    time: z.number().finite(),
  }),
  z.object({
    kind: z.literal("check-green"),
    time: z.number().finite(),
    checkId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("span-start"),
    id: z.string(),
    parentId: z.string(),
    name: z.string(),
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
    worker: z.number(),
  }),
]);

function hash(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

const SourceWorkflow = z.object({
  jobs: z.record(z.string(), z.object({ steps: z.array(z.unknown()) })),
});
const Step = z.object({
  id: z.string().optional(),
  run: z.string().optional(),
  parallel: z.array(z.unknown()).optional(),
  sequential: z.array(z.unknown()).optional(),
});
