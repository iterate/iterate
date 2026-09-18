import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Depot, currentAttempt, latestExecution, terminal, type Workflow } from "../ci/depot.ts";
import CiStatus from "../ci/status.ts";
import { CommitHistory } from "./commit-history.ts";
import { partialRetryReason, previewUsefulness } from "./run-policy.ts";

/** Preserve useful ancestors, stop obsolete tests, and recover partial Preview retries. */
export default class PreviewCoordination {
  private env = Environment.parse(process.env);
  private url = new URL(this.env.DEPOT_JOB_URL);
  private org = z.string().min(1).parse(this.url.pathname.split("/")[2]);
  private workflowId = z.string().min(1).parse(this.url.pathname.split("/")[4]);
  private depot = new Depot({ org: this.org, token: this.env.DEPOT_CI_TELEMETRY_TOKEN });
  private signal = AbortSignal.timeout(50 * 60_000);

  /** Runs outside the lifecycle lock, so a newer push can stop obsolete tests immediately. */
  async coordinate(pullRequest: number) {
    const candidates = z
      .object({
        workflows: z
          .array(
            z.object({ workflowId: z.string(), workflowPath: z.string(), headSha: z.string() }),
          )
          .default([]),
      })
      .parse(
        await this.depot.request("ListWorkflows", {
          repo: this.env.GITHUB_REPOSITORY,
          pr: String(pullRequest),
          status: ["running", "queued"],
          pageSize: 200,
        }),
      );
    const ancestors = new Set(
      new CommitHistory(process.cwd(), this.env.CI_HEAD_SHA, "origin/main")
        .throughMergeBase()
        .slice(1),
    );
    let ancestor: Workflow | undefined;
    for (const candidate of candidates.workflows) {
      if (
        candidate.workflowId === this.workflowId ||
        candidate.workflowPath.split("/").at(-1) !== "preview.yml"
      )
        continue;
      const workflow = await this.depot.workflow(candidate.workflowId);
      this.assertPreview(workflow);
      const usefulness = await this.usefulness(workflow, pullRequest);
      console.log(`[preview] ${workflow.workflowId}: ${usefulness.reason}`);
      if (usefulness.obsolete) await this.stopConsumers(workflow);
      else if (ancestors.has(workflow.headSha) && !ancestor) ancestor = workflow;
    }
    if (!ancestor) return;
    // This is informational coordination; the plan still rechecks settled evidence
    // and live deployment identity after acquiring the exclusive lifecycle lock.
    try {
      await new CiStatus().waitFor("finish", "preview-settled", {
        workflowId: ancestor.workflowId,
        commit: ancestor.headSha,
        timeoutSeconds: 2700,
      });
    } catch (error) {
      console.log(
        `[preview] Ancestor did not supply settlement; ci-plan will decide whether a fresh deployment is needed: ${String(error)}`,
      );
    }
  }

  /** First step after installation in every Preview job; full reruns remain ordinary runs. */
  async verify(pullRequest: number) {
    const workflow = await this.depot.workflow(this.workflowId);
    this.assertPreview(workflow);
    if (workflow.headSha !== this.env.CI_HEAD_SHA)
      throw new Error("Preview workflow does not match the checkout SHA");
    const jobId = z.string().min(1).parse(this.url.searchParams.get("job"));
    const self = workflow.jobs.find((job) => job.jobId === jobId);
    if (!self || currentAttempt(self)?.attemptId !== this.url.searchParams.get("attempt"))
      throw new Error("Preview job attempt is no longer current");
    const reason = partialRetryReason(workflow, jobId);
    if (!reason) {
      const execution = latestExecution(workflow);
      await appendFile(this.env.GITHUB_OUTPUT, `execution=${execution.executionId}\n`);
      await appendFile(
        z.string().min(1).parse(process.env.GITHUB_ENV),
        `PREVIEW_EXECUTION_ID=${execution.executionId}\nPREVIEW_EXECUTION_NUMBER=${execution.execution}\n`,
      );
      return;
    }
    const usefulness = await this.usefulness(workflow, pullRequest);
    if (usefulness.obsolete) throw new Error(`Retry is obsolete: ${usefulness.reason}`);
    const execution = latestExecution(workflow);
    // Several retried jobs may request recovery. The recovery workflow serializes
    // by workflow ID and checks execution ID, so only the first can perform it.
    await this.depot.request("DispatchWorkflow", {
      orgId: this.org,
      repo: workflow.repo,
      workflow: "preview-retry.yml",
      ref: usefulness.branch,
      inputs: {
        "workflow-id": workflow.workflowId,
        "execution-id": execution.executionId,
        "head-sha": workflow.headSha,
        "pull-request-number": String(pullRequest),
      },
    });
    throw new Error(
      `${reason} Requested a fresh full Preview run; this partial attempt will not touch its old environment.`,
    );
  }

  /** Serialized recovery runner; it never owns the target preview's lifecycle lock. */
  async recover(workflowId: string, executionId: string, commit: string, pullRequest: number) {
    while (true) {
      const workflow = await this.depot.workflow(workflowId);
      this.assertPreview(workflow);
      if (workflow.headSha !== commit) throw new Error("Recovery target commit changed");
      if (latestExecution(workflow).executionId !== executionId)
        return { recovered: false, reason: "Another recovery already advanced this workflow." };
      await this.stopConsumers(workflow);
      // Never kill a deployment or restoration halfway through a Cloudflare write.
      const mutators = workflow.jobs.filter((job) => /:(prepare|finish)$/.test(job.jobKey));
      if (mutators.length !== 2)
        throw new Error("Recovery requires exactly one prepare and one finalizer");
      if (mutators.some((job) => !terminal.has(job.status))) {
        await delay(5_000, undefined, { signal: this.signal });
        continue;
      }
      const usefulness = await this.usefulness(workflow, pullRequest);
      if (!terminal.has(workflow.workflowStatus)) {
        // Check the generation again immediately before cancellation. Depot has
        // no conditional cancellation API, so a manual concurrent rerun is rejected
        // on the next iteration rather than being adopted as this recovery's run.
        const confirmed = await this.depot.workflow(workflowId);
        if (latestExecution(confirmed).executionId !== executionId) continue;
        if (
          confirmed.jobs.some(
            (job) => /:(prepare|finish)$/.test(job.jobKey) && !terminal.has(job.status),
          )
        )
          continue;
        await this.depot.request("CancelWorkflow", { workflowId });
        await delay(1_000, undefined, { signal: this.signal });
        continue;
      }
      if (usefulness.obsolete) return { recovered: false, reason: usefulness.reason };
      const confirmed = await this.depot.workflow(workflowId);
      if (
        latestExecution(confirmed).executionId !== executionId ||
        !terminal.has(confirmed.workflowStatus)
      )
        continue;
      await this.depot.request("RerunWorkflow", { workflowId });
      console.log(`[preview] Restarted all jobs in ${workflowId}, including fresh preparation.`);
      return { recovered: true };
    }
  }

  /** Allow a prepared ancestor to finish; skip obsolete deployment and restoration work. */
  async needed(pullRequest: number) {
    const workflow = await this.depot.workflow(this.workflowId);
    this.assertPreview(workflow);
    const result = await this.usefulness(workflow, pullRequest);
    await appendFile(this.env.GITHUB_OUTPUT, `needed=${!result.obsolete}\n`);
    console.log(`[preview] ${result.reason}`);
    return !result.obsolete;
  }

  private assertPreview(workflow: Workflow) {
    if (
      workflow.repo !== this.env.GITHUB_REPOSITORY ||
      !["preview.yml", "preview-main.yml"].includes(workflow.workflowPath.split("/").at(-1) || "")
    )
      throw new Error("Coordination target is not this repository's Preview workflow");
  }

  private async usefulness(workflow: Workflow, pullRequest: number) {
    if (!pullRequest) {
      if (workflow.workflowPath.split("/").at(-1) !== "preview-main.yml")
        throw new Error("PR Preview coordination requires the PR number");
      return { obsolete: false, reason: "Main preview baseline.", branch: "main" };
    }
    const result = await previewUsefulness({
      commit: workflow.headSha,
      pullRequest,
      repository: workflow.repo,
      token: this.env.GITHUB_TOKEN,
      directory: process.cwd(),
    });
    if (
      ![`refs/pull/${pullRequest}/merge`, `refs/heads/${result.branch}`, result.branch].includes(
        workflow.ref,
      )
    )
      throw new Error("Preview workflow does not belong to the requested PR");
    return result;
  }

  private async stopConsumers(workflow: Workflow) {
    for (const job of workflow.jobs) {
      if (!/:(apps|playwright:matrix-[0-5])$/.test(job.jobKey) || terminal.has(job.status))
        continue;
      console.log(
        `[preview] Cancel ${job.jobKey} in ${workflow.workflowId}; preserve deployment and cleanup.`,
      );
      await this.depot.request("CancelJob", { workflowId: workflow.workflowId, jobId: job.jobId });
    }
  }
}

const Environment = z.object({
  DEPOT_JOB_URL: z.url(),
  DEPOT_CI_TELEMETRY_TOKEN: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
  CI_HEAD_SHA: z.string().min(1),
  GITHUB_OUTPUT: z.string().min(1),
});
