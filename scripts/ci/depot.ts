import { z } from "zod";

/** The same API used by `depot ci`; keep job attempts distinct from workflow executions. */
export class Depot {
  private token: string;
  private org: string;
  private fetch: typeof fetch;

  constructor(options: { token: string; org: string }, fetcher = fetch) {
    this.token = z.string().min(1).parse(options.token);
    this.org = z.string().min(1).parse(options.org);
    this.fetch = fetcher;
  }

  async workflow(workflowId: string) {
    return Workflow.parse(await this.request("GetWorkflow", { workflowId }));
  }

  async request(method: string, body: object): Promise<unknown> {
    const response = await this.fetch(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-depot-org": this.org,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Depot ${method} returned HTTP ${response.status}`);
    return response.json();
  }
}

export const terminal = new Set(["finished", "failed", "cancelled", "skipped"]);
const State = z.enum([
  "queued",
  "waiting",
  "running",
  "finished",
  "failed",
  "cancelled",
  "skipped",
]);
export const Workflow = z.object({
  workflowId: z.string(),
  repo: z.string(),
  headSha: z.string(),
  ref: z.string(),
  workflowPath: z.string(),
  workflowStatus: State,
  executions: z.array(
    z.object({ executionId: z.string(), execution: z.number(), createdAt: z.iso.datetime() }),
  ),
  jobs: z.array(
    z.object({
      jobId: z.string(),
      jobKey: z.string(),
      status: State,
      attempts: z
        .array(
          z.object({
            attemptId: z.string(),
            attempt: z.number(),
            status: State,
            // Queued jobs may not yet have a runner or timestamp.
            startedAt: z.iso.datetime().optional(),
            finishedAt: z.iso.datetime().optional(),
          }),
        )
        .default([]),
    }),
  ),
});
export type Workflow = z.infer<typeof Workflow>;

/** Queued reruns cannot consume a previous attempt's signal. */
export function currentAttempt(job: Workflow["jobs"][number]) {
  if (job.status === "queued" || job.status === "waiting") return undefined;
  return job.attempts.toSorted((a, b) => b.attempt - a.attempt)[0];
}

export function latestExecution(workflow: Workflow) {
  const execution = workflow.executions.toSorted((a, b) => b.execution - a.execution)[0];
  if (!execution) throw new Error("Depot workflow has no execution");
  return execution;
}
