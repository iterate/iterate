import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  assembleTrace,
  Workflow,
  renderTrace,
  traceCommitStatus,
  stepCommands,
} from "./tracing.ts";

/** Completed-run CI traces. Invoke with `pnpm exec trpc-cli scripts/ci/tracing/cli.ts`. */
export default class CiTrace {
  /** Start the independent collector before this workflow's final step exits. */
  async dispatch(ref: string) {
    const source = new URL(z.string().url().parse(process.env.DEPOT_JOB_URL));
    const workflowId = z
      .string()
      .regex(/^[a-z0-9]+$/)
      .parse(source.pathname.split("/").at(-1));
    await this.dispatchCollector(ref, workflowId);
    console.log(`Dispatched trace collector for ${workflowId}`);
  }

  /** Collect a completed workflow, publish an immutable report and link it from a commit status. */
  async publish(workflowId: string) {
    const workflow = await this.waitForWorkflow(workflowId);
    const execution = [...workflow.executions].sort((a, b) => b.execution - a.execution)[0];
    if (!execution) throw new Error("Workflow has no execution");
    const name = `ci-trace-${workflow.workflowId}-${execution.executionId}`;
    const collectorId = new URL(z.url().parse(process.env.DEPOT_JOB_URL)).pathname
      .split("/")
      .at(-1);
    const collector = z
      .object({ runId: z.string() })
      .parse(await this.depot("GetWorkflow", { workflowId: collectorId }));
    const { artifacts } = z
      .object({
        artifacts: z.array(z.object({ artifactId: z.string(), name: z.string() })).default([]),
      })
      .parse(
        await this.depot("ListArtifacts", {
          runId: collector.runId,
          workflowId: collectorId,
          pageSize: 100,
        }),
      );
    const artifact = artifacts.find((item) => item.name === name);
    if (!artifact) throw new Error(`Collector did not upload ${name}`);
    const url = `https://iterate.iterate.app/depot/artifacts/${artifact.artifactId}`;
    // A successful upload alone is not the user's acceptance check: verify the host.
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.ok && (await response.text()).includes('id="data"')) break;
      if (attempt === 4)
        throw new Error(`Published report is not viewable: HTTP ${response.status}`);
      await delay(3_000);
    }
    const octokit = this.github();
    const statuses = await octokit.paginate(octokit.repos.listCommitStatusesForRef, {
      ...repo,
      ref: workflow.headSha,
      per_page: 100,
    });
    const status = traceCommitStatus(
      statuses.find((item) => item.context === "CI trace"),
      { headSha: workflow.headSha, createdAt: execution.createdAt, url },
    );
    if (status) await octokit.repos.createCommitStatus({ ...repo, ...status });
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n[Open CI trace](${url})\n`);
    console.log(url);
    return { url };
  }

  /** Repair missed callbacks (including cancelled workflows) from the last 24 hours. */
  async reconcile(ref: string) {
    const { workflows } = z
      .object({
        workflows: z
          .array(
            z.object({
              workflowId: z.string(),
              workflowPath: z.string(),
              createdAt: z.string(),
              status: z.string(),
            }),
          )
          .default([]),
      })
      .parse(await this.depot("ListWorkflows", { repo: repository, pageSize: 200 }));
    const failures: Error[] = [];
    for (const workflow of workflows.filter(
      (item) =>
        ["preview.yml", "preview-main.yml"].includes(item.workflowPath) &&
        terminal.has(item.status) &&
        Date.parse(item.createdAt) > Date.now() - 86_400_000,
    )) {
      try {
        const source = await this.waitForWorkflow(workflow.workflowId);
        const execution = [...source.executions].sort((a, b) => b.execution - a.execution)[0];
        if (!execution) throw new Error("Workflow has no execution");
        const octokit = this.github();
        const statuses = await octokit.paginate(octokit.repos.listCommitStatusesForRef, {
          ...repo,
          ref: source.headSha,
          per_page: 100,
        });
        if (
          traceCommitStatus(
            statuses.find((item) => item.context === "CI trace"),
            {
              headSha: source.headSha,
              createdAt: execution.createdAt,
              url: "",
            },
          )
        )
          await this.dispatchCollector(ref, workflow.workflowId);
      } catch (error) {
        failures.push(
          new Error(`Trace publication failed for ${workflow.workflowId}`, { cause: error }),
        );
      }
    }
    if (failures.length) throw new AggregateError(failures, "CI trace reconciliation failed");
  }

  /** Build local HTML/OTLP files without publishing or changing a commit status. */
  async render(workflowId: string, directory: string) {
    const workflow = await this.waitForWorkflow(workflowId);
    const report = await this.collect(workflow);
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/trace.json`, JSON.stringify(report, null, 2));
    await writeFile(`${directory}/trace.html`, await renderTrace(report));
    const execution = [...workflow.executions].sort((a, b) => b.execution - a.execution)[0];
    if (!execution) throw new Error("Workflow has no execution");
    const name = `ci-trace-${workflow.workflowId}-${execution.executionId}`;
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `artifact-name=${name}\n`);
    return { directory, name };
  }

  private async collect(workflow: z.infer<typeof Workflow>) {
    const source = await fetch(
      `https://raw.githubusercontent.com/${repository}/${workflow.sha}/.depot/workflows/preview-run.yml`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!source.ok) throw new Error(`Could not read the source workflow: HTTP ${source.status}`);
    const commands = stepCommands(await source.text());
    const attempts = workflow.jobs
      .flatMap((job) => job.attempts)
      .filter((attempt) => attempt.startedAt);
    const entries = await Promise.all(
      attempts.map(async (attempt) => {
        const lines: z.infer<typeof LogPage>["lines"] = [];
        let pageToken = "";
        do {
          const page = LogPage.parse(
            await this.depot("GetJobAttemptLogs", {
              attemptId: attempt.attemptId,
              pageSize: 1000,
              pageToken,
            }),
          );
          // Raw logs may contain secrets. Keep only our deliberately small records.
          lines.push(...page.lines.filter((line) => line.body.startsWith("@@ci-trace ")));
          pageToken = page.nextPageToken;
        } while (pageToken);
        const job = workflow.jobs.find((job) =>
          job.attempts.some((item) => item.attemptId === attempt.attemptId),
        );
        if (!job) throw new Error("Collected attempt has no job");
        const jobKey = job.jobKey.replace(/^.*:preview:/, "").split(":")[0];
        return [
          attempt.attemptId,
          lines.map((line) => ({
            ...line,
            command: commands.get(`${jobKey}/${line.stepId}`) || "",
          })),
        ] as const;
      }),
    );
    return assembleTrace(workflow, new Map(entries));
  }

  private async waitForWorkflow(workflowId: string) {
    const deadline = Date.now() + 5 * 60_000;
    while (true) {
      const data = await this.depot("GetWorkflow", { workflowId });
      const state = z.object({ workflowStatus: z.string() }).parse(data);
      if (terminal.has(state.workflowStatus)) {
        const workflow = Workflow.parse(data);
        if (
          workflow.repo !== repository ||
          !["preview.yml", "preview-main.yml"].includes(workflow.workflowPath)
        )
          throw new Error("Only Iterate preview/main workflows can publish CI traces");
        return workflow;
      }
      if (Date.now() >= deadline)
        throw new Error(`Workflow ${workflowId} did not settle within five minutes`);
      await delay(5_000);
    }
  }

  private async dispatchCollector(ref: string, workflowId: string) {
    await this.depot("DispatchWorkflow", {
      orgId: org,
      repo: repository,
      workflow: "ci-trace.yml",
      ref,
      inputs: { "source-workflow": workflowId },
    });
  }

  private github() {
    return new Octokit({ auth: z.string().min(1).parse(process.env.GITHUB_TOKEN) });
  }

  private async depot(method: string, body: object) {
    const token = z.string().min(1).parse(process.env.DEPOT_CI_TELEMETRY_TOKEN);
    const response = await fetch(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-depot-org": org,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Depot ${method} returned HTTP ${response.status}`);
    return response.json();
  }
}

const repository = "iterate/iterate";
const repo = { owner: "iterate", repo: "iterate" };
const org = "0p91s0lz49";
const terminal = new Set(["finished", "failed", "cancelled", "skipped"]);
const LogPage = z.object({
  lines: z
    .array(
      z.object({
        body: z.string().default(""),
        stepKey: z.string(),
        stepId: z.string().default(""),
        stepName: z.string().default(""),
      }),
    )
    .default([]),
  nextPageToken: z.string().default(""),
});
