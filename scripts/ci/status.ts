import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const State = z.enum([
  "queued",
  "waiting",
  "running",
  "finished",
  "failed",
  "cancelled",
  "skipped",
]);
const Workflow = z.object({
  workflowId: z.string(),
  repo: z.string(),
  headSha: z.string(),
  executions: z.array(z.object({ executionId: z.string(), execution: z.number() })),
  jobs: z.array(
    z.object({
      jobId: z.string(),
      jobKey: z.string(),
      status: State,
      attempts: z
        .array(z.object({ attemptId: z.string(), attempt: z.number(), status: State }))
        .default([]),
    }),
  ),
});
const Statuses = z.object({
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.enum(["pending", "success", "failure", "error"]),
    }),
  ),
});
type Options = {
  depotApi: string;
  githubApi: string;
  depotToken: string;
  githubToken: string;
  jobUrl: string;
  repository: string;
  sha: string;
  pollMs: number;
  timeoutMs: number;
};
const terminal = new Set(["finished", "failed", "cancelled", "skipped"]);

/** Milestones use GitHub; producer liveness and exact attempts come from Depot. */
export class CiStatus {
  private options: Options;
  private org: string;
  private workflowId: string;
  private jobId: string;
  private attemptId: string;
  private signal: AbortSignal;

  constructor(options: Options) {
    this.options = options;
    const url = new URL(options.jobUrl);
    const path = /^\/orgs\/([^/]+)\/workflows\/([^/]+)$/.exec(url.pathname);
    if (!path) throw new Error("DEPOT_JOB_URL must identify the current workflow and job attempt");
    this.org = path[1];
    this.workflowId = path[2];
    this.jobId = z.string().min(1).parse(url.searchParams.get("job"));
    this.attemptId = z.string().min(1).parse(url.searchParams.get("attempt"));
    this.signal = AbortSignal.timeout(options.timeoutMs);
  }

  private async workflow() {
    const data = Workflow.parse(
      await this.request("depot", "/depot.ci.v1.CIService/GetWorkflow", {
        workflowId: this.workflowId,
      }),
    );
    if (
      data.workflowId !== this.workflowId ||
      data.repo !== this.options.repository ||
      data.headSha !== this.options.sha
    )
      throw new Error("Depot workflow does not match this checkout/repository");
    // Retrying only a test job after cleanup reuses an erased environment. This
    // experiment accepts fresh runs only; it never follows a replacement attempt.
    if (
      data.executions.length !== 1 ||
      data.executions[0].execution !== 1 ||
      data.jobs.some(
        (job) => job.attempts.length > 1 || job.attempts.some((attempt) => attempt.attempt !== 1),
      )
    )
      throw new Error(
        "Preview coordination requires a fresh workflow run, not a retry of an erased deployment",
      );
    const self = data.jobs.find((job) => job.jobId === this.jobId);
    if (!self?.attempts.some((attempt) => attempt.attemptId === this.attemptId))
      throw new Error("Current job attempt is absent from this workflow");
    return data;
  }

  async set(milestone: string) {
    const workflow = await this.workflow();
    const context = `ci/${this.workflowId}/${workflow.executions[0].executionId}/${this.jobId}/${this.attemptId}/${milestone}`;
    await this.request("github", `/repos/${this.options.repository}/statuses/${this.options.sha}`, {
      context,
      state: "success",
      description: `Reached ${milestone}`,
      target_url: this.options.jobUrl,
    });
    console.log(`[ci:status] reached ${context}`);
  }

  async waitFor(producer: string, milestone: string) {
    console.log(`[ci:status] waiting for ${producer}/${milestone}`);
    while (true) {
      const workflow = await this.workflow();
      const jobs = workflow.jobs.filter((job) => job.jobKey.endsWith(`:${producer}`));
      if (jobs.length !== 1)
        throw new Error(`Expected exactly one producer ${producer}; found ${jobs.length}`);
      const job = jobs[0];
      const attempt = job.attempts[0];
      if (attempt) {
        const context = `ci/${this.workflowId}/${workflow.executions[0].executionId}/${job.jobId}/${attempt.attemptId}/${milestone}`;
        // Read the signal AFTER liveness. A final status write followed by job
        // termination must not be mistaken for a producer that forgot to signal.
        for (let page = 1; ; page++) {
          const { statuses } = Statuses.parse(
            await this.request(
              "github",
              `/repos/${this.options.repository}/commits/${this.options.sha}/status?per_page=100&page=${page}`,
              null,
            ),
          );
          const status = statuses.find((entry) => entry.context === context);
          if (status?.state === "success") {
            console.log(`[ci:status] reached ${context}`);
            return { producer, attemptId: attempt.attemptId };
          }
          if (status && status.state !== "pending")
            throw new Error(`Milestone ${context}: ${status.state}`);
          if (status || statuses.length < 100) break;
        }
      }
      if (terminal.has(job.status))
        throw new Error(
          `Producer ${producer} ${job.status} without ${milestone}: ${this.options.jobUrl.replace(this.jobId, job.jobId).replace(this.attemptId, attempt?.attemptId || "")}`,
        );
      await delay(this.options.pollMs, undefined, { signal: this.signal });
    }
  }

  /** Return only after every consumer stopped. A failed consumer is still settled. */
  async waitForJobs(producers: string[]) {
    if (!producers.length || new Set(producers).size !== producers.length)
      throw new Error("Specify a nonempty, unique set of consumer jobs");
    console.log(`[ci:status] waiting for all consumers: ${producers.join(", ")}`);
    let previous = "";
    while (true) {
      const workflow = await this.workflow();
      const jobs = producers.map((producer) => {
        const matches = workflow.jobs.filter((job) => job.jobKey.endsWith(`:${producer}`));
        if (matches.length !== 1)
          throw new Error(`Expected exactly one consumer ${producer}; found ${matches.length}`);
        if (matches[0].jobId === this.jobId) throw new Error("A job cannot wait for itself");
        return matches[0];
      });
      const summary = jobs.map((job) => `${job.jobKey}: ${job.status}`).join("; ");
      if (summary !== previous) console.log(`[ci:status] ${summary}`);
      previous = summary;
      if (jobs.every((job) => terminal.has(job.status)))
        return { settled: true, succeeded: jobs.every((job) => job.status === "finished"), jobs };
      await delay(this.options.pollMs, undefined, { signal: this.signal });
    }
  }

  private async request(service: "depot" | "github", path: string, body: object | null) {
    const depot = service === "depot";
    const response = await fetch(
      `${depot ? this.options.depotApi : this.options.githubApi}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${depot ? this.options.depotToken : this.options.githubToken}`,
          "content-type": "application/json",
          ...(depot ? { "x-depot-org": this.org } : { accept: "application/vnd.github+json" }),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
      },
    );
    // Do not print response bodies or request headers: they can contain credentials.
    if (!response.ok)
      throw new Error(`${service} coordination API returned HTTP ${response.status}`);
    return response.json();
  }
}

if (import.meta.main) {
  const env = z
    .object({
      DEPOT_CI_TELEMETRY_TOKEN: z.string().min(1),
      GITHUB_TOKEN: z.string().min(1),
      DEPOT_JOB_URL: z.string().url(),
      GITHUB_REPOSITORY: z.string().min(1),
      CI_HEAD_SHA: z.string().min(1),
    })
    .parse(process.env);
  const status = new CiStatus({
    depotApi: "https://api.depot.dev",
    githubApi: "https://api.github.com",
    depotToken: env.DEPOT_CI_TELEMETRY_TOKEN,
    githubToken: env.GITHUB_TOKEN,
    jobUrl: env.DEPOT_JOB_URL,
    repository: env.GITHUB_REPOSITORY,
    sha: env.CI_HEAD_SHA,
    pollMs: 5_000,
    timeoutMs: 20 * 60_000,
  });
  const [command, ...args] = process.argv.slice(2);
  if (command === "set" && args.length === 1) await status.set(args[0]);
  else if (command === "wait-for" && args.length === 2) await status.waitFor(args[0], args[1]);
  else if (command === "wait-for-jobs" && args.length) {
    const result = await status.waitForJobs(args);
    const output = z.string().min(1).parse(process.env.GITHUB_OUTPUT);
    await appendFile(output, `settled=true\nsucceeded=${result.succeeded}\n`);
  } else
    throw new Error(
      "Usage: status.ts set MILESTONE | wait-for PRODUCER MILESTONE | wait-for-jobs PRODUCER...",
    );
}
