import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { parse } from "yaml";
import { z } from "zod";
import { DEPOT_ORG } from "../depot.ts";

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
  const finish = workflow.jobs.find((job) => job.jobKey.endsWith(":finish"));
  workflow.jobs = workflow.jobs.filter((job) => !/:(finish|trace|cleanup|sweep)$/.test(job.jobKey));
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
  const producerEnd = ends.length ? Math.max(...ends) : Date.parse(workflow.workflowFinishedAt);
  // Retrying only cleanup/reporting must not create a new test execution.
  const executions = [...workflow.executions].sort((a, b) => b.execution - a.execution);
  const execution = executions.find((execution) => Date.parse(execution.createdAt) <= producerEnd);
  if (!execution) throw new Error("Depot workflow has no execution for its preview jobs");
  const nextExecution = executions[executions.indexOf(execution) - 1];
  const rootStart = Date.parse(execution.createdAt);
  const executionEnd = nextExecution ? Date.parse(nextExecution.createdAt) : Infinity;
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
  // Read only the test verdict from finish. Its setup, reporting and cleanup are
  // deliberately outside this trace, even when they later fail the Depot job.
  const verdictEvents = (finish?.attempts || [])
    .flatMap((attempt) => eventsByAttempt.get(attempt.attemptId) || [])
    .filter((event) => "time" in event && event.time >= rootStart && event.time < executionEnd);
  const greenMarker = verdictEvents.find((event) => event.kind === "check-green");
  const greenStep = verdictEvents.find(
    (event) => event.kind === "shell-start" && event.step === "tests_passed",
  );
  const greenEnd =
    greenStep?.kind === "shell-start"
      ? verdictEvents.find(
          (event) =>
            event.kind === "shell-end" && event.id === greenStep.id && event.exitCode === 0,
        )
      : undefined;
  const observedGreen =
    greenMarker?.kind === "check-green"
      ? { time: greenMarker.time, evidence: "GitHub check update acknowledged" }
      : greenEnd?.kind === "shell-end"
        ? { time: greenEnd.time, evidence: "Successful early-green step end" }
        : null;
  const verdictFailure = observedGreen
    ? undefined
    : verdictEvents
        .flatMap((event) => {
          if (event.kind !== "shell-end" || event.exitCode === 0) return [];
          const start = verdictEvents.find(
            (item) => item.kind === "shell-start" && item.id === event.id,
          );
          const step = event.stepId || (start?.kind === "shell-start" ? start.step : "");
          return ["consumers", "merge_reports", "tests_passed"].includes(step)
            ? [{ time: event.time, evidence: `Failed test-result validation (${step})` }]
            : [];
        })
        .sort((a, b) => a.time - b.time)[0];
  const rootEnd = Math.max(
    producerEnd,
    observedGreen?.time || producerEnd,
    verdictFailure?.time || producerEnd,
  );
  workflow.workflowFinishedAt = new Date(rootEnd).toISOString();
  if (verdictFailure || workflow.jobs.some((job) => job.status === "failed"))
    workflow.workflowStatus = "failed";
  else if (workflow.jobs.some((job) => job.status === "cancelled"))
    workflow.workflowStatus = "cancelled";
  else if (workflow.jobs.length && workflow.jobs.every((job) => job.status === "skipped"))
    workflow.workflowStatus = "skipped";
  else if (finish) workflow.workflowStatus = observedGreen ? "finished" : "incomplete";
  else if (workflow.jobs.length) workflow.workflowStatus = "finished";
  const traceId = hash(`${workflow.workflowId}/${execution.executionId}`, 32);
  const spans: Span[] = [];
  const dependencies: { sourceId: string; targetId: string; milestone: string }[] = [];
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
        "Depot timestamps; shell and test lifecycle markers. Uninstrumented action time remains in its enclosing job/phase.",
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
    const key = jobKeyInWorkflow(job.jobKey);
    const labels: Record<string, string> = {
      plan: "Plan",
      prepare: "Prepare",
      apps: "App tests",
      deploy: "Deploy",
      e2e: "E2E",
    };
    const name =
      labels[key] ||
      key.replace(/playwright:matrix-(\d+)/, (_, index) => `Playwright ${Number(index) + 1}/6`);
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
          "ci.url": `https://depot.dev/orgs/${DEPOT_ORG}/workflows/${workflow.workflowId}?job=${job.jobId}&attempt=${attempt.attemptId}`,
        },
        attempt.status === "failed",
      );
      const events = eventsByAttempt.get(attempt.attemptId) || [];
      const shells = events.filter((event) => event.kind === "shell-start");
      const shellEnds = new Map(
        events.filter((event) => event.kind === "shell-end").map((event) => [event.id, event]),
      );
      const testEnds = new Map(
        events.filter((event) => event.kind === "test-end").map((event) => [event.id, event]),
      );
      const wait = shells.find(
        (event) => event.step === "wait_for_preview" || event.step === "consumers",
      );
      const tests = shells.find(
        (event) =>
          event.step === "playwright" || event.step === "app_tests" || event.step === "e2e",
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
          stepParents.get(test.stepKey) || jobSpan,
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
  const green =
    workflow.workflowStatus === "finished"
      ? observedGreen || { time: rootEnd, evidence: "Successful preview completion" }
      : null;
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
    const failure = [
      ...(failedAt === undefined
        ? []
        : [{ time: failedAt, evidence: "First failed job completion (Depot)" }]),
      ...(verdictFailure ? [verdictFailure] : []),
    ].sort((a, b) => a.time - b.time)[0];
    const red = failure ? failure.time : rootEnd;
    const evidence = failure
      ? failure.evidence
      : "Preview completion (upper bound; no failed job completion recorded)";
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

/**
 * A job's key inside its workflow file: `preview-os-next.yml:e2e` → `e2e`. The legacy preview called
 * a reusable workflow, whose jobs were `preview.yml:preview:<job>`.
 */
export function jobKeyInWorkflow(jobKey: string) {
  return jobKey.replace(/^.*?\.yml:(preview:)?/, "");
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
    // Historical markers were emitted only by Playwright.
    framework: z.enum(["playwright", "vitest"]).default("playwright"),
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
const Step = z.object({
  id: z.string().optional(),
  run: z.string().optional(),
  parallel: z.array(z.unknown()).optional(),
  sequential: z.array(z.unknown()).optional(),
});
