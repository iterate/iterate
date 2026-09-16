import { createHash } from "node:crypto";
import { z } from "zod";

/** ExportTraceServiceRequest (OTLP/JSON). IDs are deterministic per Depot execution. */
export function assembleTrace(
  input: unknown,
  logs: Map<string, { stepKey: string; body: string }[]>,
) {
  const workflow = Workflow.parse(input);
  const execution = [...workflow.executions].sort((a, b) => b.execution - a.execution)[0];
  if (!execution) throw new Error("Depot workflow has no execution");
  const traceId = hash(`${workflow.workflowId}/${execution.executionId}`, 32);
  const spans: Span[] = [];
  const rootStart = Date.parse(execution.createdAt);
  const rootEnd = Date.parse(workflow.workflowFinishedAt);
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
      "ci.status": workflow.workflowStatus,
      "ci.workflow.id": workflow.workflowId,
      "ci.execution.id": execution.executionId,
      "ci.source.sha": workflow.headSha,
      "ci.source.ref": workflow.ref,
      "ci.url": `https://depot.dev/orgs/0p91s0lz49/workflows/${workflow.workflowId}`,
      "ci.evidence":
        "Depot timestamps; shell and Playwright lifecycle markers. Uninstrumented action time remains in its enclosing job/phase.",
    },
    workflow.workflowStatus === "failed",
  );
  for (const job of workflow.jobs) {
    const name = job.jobKey
      .replace(/^.*:preview:/, "")
      .replace(/playwright:matrix-(\d+)/, (_, index) => `Playwright ${Number(index) + 1}/6`);
    const attempts = job.attempts.filter(
      (attempt) => Date.parse(attempt.finishedAt || workflow.workflowFinishedAt) >= rootStart,
    );
    if (!attempts.length) {
      add(
        job.jobId,
        root,
        name,
        rootEnd,
        rootEnd,
        { "ci.kind": "job", "ci.status": job.status, "ci.evidence": "No runner attempt" },
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
        return [
          {
            ...TraceEvent.parse(JSON.parse(line.body.slice("@@ci-trace ".length))),
            stepKey: line.stepKey,
          },
        ];
      });
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
          ? boundaries.map((boundary, index) => ({
              start: boundary.time,
              end: boundaries[index + 1]?.time || end,
              id: add(
                `${attempt.attemptId}/phase/${index}`,
                jobSpan,
                boundary.name,
                boundary.time,
                boundaries[index + 1]?.time || end,
                {
                  "ci.kind": "phase",
                  "ci.phase": boundary.name.toLowerCase(),
                  "ci.evidence":
                    "Grouping from measured step boundaries; includes action/runner gaps",
                },
                false,
              ),
            }))
          : [];
      const stepParents = new Map<string, string>();
      for (const shell of shells) {
        const done = shellEnds.get(shell.id);
        const parent =
          phases.findLast((phase) => shell.time >= phase.start && shell.time < phase.end)?.id ||
          jobSpan;
        const id = add(
          `${attempt.attemptId}/shell/${shell.id}`,
          parent,
          shell.step.replaceAll("_", " "),
          shell.time,
          done?.time || end,
          {
            "ci.kind": "step",
            "ci.step.key": shell.stepKey,
            "ci.status": done ? (done.exitCode ? "failed" : "passed") : "incomplete",
            "ci.evidence": done
              ? "Measured shell start/exit"
              : "incomplete; end bounded by job finish",
          },
          !!done?.exitCode,
        );
        stepParents.set(shell.stepKey, id);
      }
      for (const test of events.filter((event) => event.kind === "test-start")) {
        const done = testEnds.get(test.id);
        add(
          `${attempt.attemptId}/test/${test.id}`,
          stepParents.get(test.stepKey) || jobSpan,
          `${test.title}${test.retry ? ` · retry ${test.retry}` : ""}`,
          test.time,
          done?.time || end,
          {
            "ci.kind": "test",
            "ci.status": done?.status || "incomplete",
            "ci.evidence": done
              ? "Playwright startTime + duration"
              : "incomplete; end bounded by job finish",
            "test.file": test.file,
            "test.line": String(test.line),
            "test.project": test.project,
            "test.retry": String(test.retry),
            "test.worker": done ? String(done.worker) : "unknown",
          },
          !!done && done.status !== done.expectedStatus && done.status !== "skipped",
        );
      }
    }
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

export type Trace = ReturnType<typeof assembleTrace>;
export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } }[];
  status: { code: number };
};

export const Workflow = z.object({
  workflowId: z.string(),
  workflowName: z.string(),
  workflowPath: z.string(),
  repo: z.string(),
  headSha: z.string(),
  ref: z.string(),
  workflowStatus: z.string(),
  workflowCreatedAt: z.string(),
  workflowFinishedAt: z.string(),
  executions: z.array(
    z.object({ executionId: z.string(), execution: z.number(), createdAt: z.string() }),
  ),
  jobs: z.array(
    z.object({
      jobId: z.string(),
      jobKey: z.string(),
      status: z.string(),
      attempts: z
        .array(
          z.object({
            attemptId: z.string(),
            attempt: z.number(),
            status: z.string(),
            startedAt: z.string(),
            finishedAt: z.string().default(""),
          }),
        )
        .default([]),
    }),
  ),
});

const TraceEvent = z.discriminatedUnion("kind", [
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
