import { currentAttempt, latestExecution, type Workflow } from "../ci/depot.ts";
import { CommitHistory } from "./commit-history.ts";
import { classifyChanges, getActionsNeeded } from "./change-plan.ts";

/** Only a proven product-change barrier makes an ancestor useless to the latest head. */
export function obsoletePreview(history: CommitHistory, ancestor: string) {
  const commits = history.throughMergeBase();
  const boundary = commits.indexOf(ancestor);
  if (boundary < 0) return false; // A force-push or incomplete history is not proof.
  return commits
    .slice(0, boundary)
    .some((commit) => getActionsNeeded(classifyChanges(history.changedFiles(commit))).deploy);
}

/** Full reruns prepare afresh; partial retries must not borrow an erased environment. */
export function partialRetryReason(workflow: Workflow, jobId: string) {
  const execution = latestExecution(workflow);
  const started = Date.parse(execution.createdAt);
  const self = workflow.jobs.find((job) => job.jobId === jobId);
  if (!self) throw new Error("Retry guard cannot find its own job");
  const ownAttempts = self.attempts.filter((attempt) => {
    // Cancelled-before-start attempts did no work and have no start timestamp.
    if (!attempt.startedAt && ["cancelled", "skipped"].includes(attempt.status)) return false;
    if (!attempt.startedAt)
      throw new Error("Depot attempt has no start time; cannot identify retry");
    return Date.parse(attempt.startedAt) >= started;
  });
  if (ownAttempts.length > 1) return `${self.jobKey} already ran in this execution.`;
  for (const job of workflow.jobs) {
    // A full rerun first resets jobs to queued. Old attempts still exist, but
    // cannot act as prerequisites until the job actually runs in this execution.
    if (!["finished", "failed", "cancelled"].includes(job.status)) continue;
    const attempt = currentAttempt(job);
    if (!attempt) continue;
    if (!attempt.startedAt && attempt.status === "cancelled") continue;
    if (!attempt.startedAt) throw new Error("Depot prerequisite has no start time");
    if (Date.parse(attempt.startedAt) < started)
      return `Partial retry retains ${job.jobKey} from before this execution.`;
  }
  return null;
}

/** Read the moving PR head, but never infer obsolescence from a missing Git object. */
export async function previewUsefulness(options: {
  commit: string;
  pullRequest: number;
  repository: string;
  token: string;
  directory: string;
}) {
  const { Octokit } = await import("@octokit/rest");
  const { execFileSync } = await import("node:child_process");
  const { splitRepositoryFullName, withGithubRetry } = await import("./github.ts");
  const [owner, repo] = splitRepositoryFullName(options.repository);
  const github = new Octokit({ auth: options.token });
  const { data: pr } = await withGithubRetry("pulls.get (preview usefulness)", () =>
    github.rest.pulls.get({ owner, repo, pull_number: options.pullRequest }),
  );
  if (pr.state === "closed")
    return { obsolete: true, reason: "PR is closed.", branch: pr.head.ref };
  if (pr.head.sha === options.commit)
    return { obsolete: false, reason: "Current PR head.", branch: pr.head.ref };
  execFileSync("git", ["fetch", "--no-tags", "origin", pr.head.sha], {
    cwd: options.directory,
    stdio: "pipe",
  });
  const history = new CommitHistory(options.directory, pr.head.sha, "origin/main");
  const obsolete = obsoletePreview(history, options.commit);
  return {
    obsolete,
    reason: obsolete
      ? `${pr.head.sha} needs a different deployment.`
      : `${pr.head.sha} may still use this preview.`,
    branch: pr.head.ref,
  };
}
