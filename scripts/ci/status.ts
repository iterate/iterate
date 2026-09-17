import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

/** GitHub milestones, guarded by Depot job liveness. Run with trpc-cli. */
export default class CiStatus {
  private env = z
    .object({
      DEPOT_CI_TELEMETRY_TOKEN: z.string().min(1),
      GITHUB_TOKEN: z.string().min(1),
      DEPOT_JOB_URL: z.string().url(),
      GITHUB_REPOSITORY: z.string().min(1),
      CI_HEAD_SHA: z.string().min(1),
      GITHUB_OUTPUT: z.string().min(1),
    })
    .parse(process.env);
  private signal = AbortSignal.timeout(20 * 60_000);
  private org: string;
  private workflowId: string;
  private jobId: string;
  private attemptId: string;

  constructor() {
    const url = new URL(this.env.DEPOT_JOB_URL);
    const path = /^\/orgs\/([^/]+)\/workflows\/([^/]+)$/.exec(url.pathname);
    if (!path) throw new Error("DEPOT_JOB_URL must identify the current workflow and job attempt");
    this.org = path[1];
    this.workflowId = path[2];
    this.jobId = z.string().min(1).parse(url.searchParams.get("job"));
    this.attemptId = z.string().min(1).parse(url.searchParams.get("attempt"));
  }

  /** Publish a milestone for this exact workflow execution and job attempt. */
  async set(milestone: string) {
    const workflow = await this.workflow();
    const context = `ci/${this.workflowId}/${workflow.executions[0].executionId}/${this.jobId}/${this.attemptId}/${milestone}`;
    await this.request(
      "github",
      `/repos/${this.env.GITHUB_REPOSITORY}/statuses/${this.env.CI_HEAD_SHA}`,
      {
        context,
        state: "success",
        description: `Reached ${milestone}`,
        target_url: this.env.DEPOT_JOB_URL,
      },
    );
    console.log(`[ci:status] reached ${context}`);
    if (process.env.CI_TRACE_ENABLED === "1")
      console.log(
        `@@ci-trace ${JSON.stringify({ kind: "milestone", name: milestone, time: Date.now() })}`,
      );
  }

  /** Wait for a producer milestone, failing if its job stops without signaling. */
  async waitFor(producer: string, milestone: string) {
    console.log(`[ci:status] waiting for ${producer}/${milestone}`);
    let linked = false;
    while (true) {
      const workflow = await this.workflow();
      const jobs = workflow.jobs.filter((job) => job.jobKey.endsWith(`:${producer}`));
      if (jobs.length !== 1)
        throw new Error(`Expected exactly one producer ${producer}; found ${jobs.length}`);
      const job = jobs[0];
      const attempt = job.attempts[0];
      if (attempt) {
        if (!linked && process.env.CI_TRACE_ENABLED === "1") {
          console.log(
            `@@ci-trace ${JSON.stringify({ kind: "dependency", targetId: attempt.attemptId, milestone })}`,
          );
          linked = true;
        }
        const context = `ci/${this.workflowId}/${workflow.executions[0].executionId}/${job.jobId}/${attempt.attemptId}/${milestone}`;
        // Read the signal AFTER liveness. A final status write followed by job
        // termination must not be mistaken for a producer that forgot to signal.
        for (let page = 1; ; page++) {
          const { statuses } = Statuses.parse(
            await this.request(
              "github",
              `/repos/${this.env.GITHUB_REPOSITORY}/commits/${this.env.CI_HEAD_SHA}/status?per_page=100&page=${page}`,
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
          `Producer ${producer} ${job.status} without ${milestone}: ${this.env.DEPOT_JOB_URL.replace(this.jobId, job.jobId).replace(this.attemptId, attempt?.attemptId || "")}`,
        );
      await delay(5_000, undefined, { signal: this.signal });
    }
  }

  /** Return only after every consumer stopped. A failed consumer is still settled. */
  async waitForJobs(producers: string[]) {
    if (!producers.length || new Set(producers).size !== producers.length)
      throw new Error("Specify a nonempty, unique set of consumer jobs");
    console.log(`[ci:status] waiting for all consumers: ${producers.join(", ")}`);
    let previous = "";
    const linked = new Set<string>();
    while (true) {
      const workflow = await this.workflow();
      const jobs = producers.map((producer) => {
        const matches = workflow.jobs.filter((job) => job.jobKey.endsWith(`:${producer}`));
        if (matches.length !== 1)
          throw new Error(`Expected exactly one consumer ${producer}; found ${matches.length}`);
        if (matches[0].jobId === this.jobId) throw new Error("A job cannot wait for itself");
        return matches[0];
      });
      if (process.env.CI_TRACE_ENABLED === "1") {
        for (const job of jobs) {
          const attempt = job.attempts[0];
          // A queued job has no trace span yet. A skipped/cancelled job may never run.
          if (!attempt && !terminal.has(job.status)) continue;
          const targetId = attempt?.attemptId || job.jobId;
          if (linked.has(targetId)) continue;
          console.log(
            `@@ci-trace ${JSON.stringify({ kind: "dependency", targetId, milestone: "" })}`,
          );
          linked.add(targetId);
        }
      }
      const summary = jobs.map((job) => `${job.jobKey}: ${job.status}`).join("; ");
      if (summary !== previous) console.log(`[ci:status] ${summary}`);
      previous = summary;
      if (jobs.every((job) => terminal.has(job.status))) {
        const succeeded = jobs.every((job) => job.status === "finished");
        await appendFile(this.env.GITHUB_OUTPUT, `settled=true\nsucceeded=${succeeded}\n`);
        return { settled: true, succeeded };
      }
      await delay(5_000, undefined, { signal: this.signal });
    }
  }

  /** Mark this job's GitHub check green while it continues; Depot owns its final outcome. */
  async setPendingCheckGreen(summary: string) {
    const workflow = await this.workflow();
    if (workflow.jobs.find((job) => job.jobId === this.jobId)?.status !== "running")
      throw new Error("This Depot job is no longer running");
    if (workflow.jobs.some((job) => job.jobId !== this.jobId && job.status !== "finished"))
      throw new Error("Cannot publish success before every other job has succeeded");
    const checks = [];
    for (let page = 1; ; page++) {
      const { check_runs } = CheckRuns.parse(
        await this.request(
          "github",
          `/repos/${this.env.GITHUB_REPOSITORY}/commits/${this.env.CI_HEAD_SHA}/check-runs?filter=all&per_page=100&page=${page}`,
          null,
        ),
      );
      checks.push(...check_runs);
      if (check_runs.length < 100) break;
    }
    const matches = checks.filter((check) => {
      if (check.app?.slug !== "depot-code-access" || !check.details_url) return false;
      const url = new URL(check.details_url);
      return (
        url.origin === "https://depot.dev" &&
        url.pathname === `/orgs/${this.org}/workflows/${this.workflowId}` &&
        url.searchParams.get("job") === this.jobId
      );
    });
    if (matches.length !== 1 || matches[0].status !== "in_progress")
      throw new Error("Expected one running GitHub check for this exact Depot job");
    const check = matches[0];
    const response = await fetch(
      `https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/check-runs/${check.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "completed",
          conclusion: "success",
          output: {
            title: "Check marked successful",
            summary,
          },
        }),
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
      },
    );
    if (!response.ok) throw new Error(`Updating own GitHub check returned HTTP ${response.status}`);
    const greenAt = Date.now();
    if (process.env.CI_TRACE_ENABLED === "1")
      console.log(
        `\n@@ci-trace ${JSON.stringify({ kind: "check-green", time: greenAt, checkId: check.id })}`,
      );
    console.log(
      `[ci:status] check ${check.id} set green at ${new Date(greenAt).toISOString()}; job continues`,
    );
    return { checkId: check.id };
  }

  private async workflow() {
    const data = Workflow.parse(
      await this.request("depot", "/depot.ci.v1.CIService/GetWorkflow", {
        workflowId: this.workflowId,
      }),
    );
    if (
      data.workflowId !== this.workflowId ||
      data.repo !== this.env.GITHUB_REPOSITORY ||
      data.headSha !== this.env.CI_HEAD_SHA
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

  private async request(service: "depot" | "github", path: string, body: object | null) {
    const depot = service === "depot";
    const response = await fetch(
      `${depot ? "https://api.depot.dev" : "https://api.github.com"}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${depot ? this.env.DEPOT_CI_TELEMETRY_TOKEN : this.env.GITHUB_TOKEN}`,
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
const terminal = new Set(["finished", "failed", "cancelled", "skipped"]);

const CheckRuns = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      status: z.string(),
      details_url: z.url().nullable(),
      app: z.object({ slug: z.string() }).nullable(),
    }),
  ),
});
