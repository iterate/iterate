import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { Depot, currentAttempt, latestExecution } from "../ci/depot.ts";
import type { PreviewResult } from "./change-plan.ts";
import { previewPlaywrightShards } from "./playwright-capacity-reporter.ts";
import { splitRepositoryFullName, withGithubRetry } from "./github.ts";

/** Read settled evidence, then verify it belongs to the newest complete preview run. */
export async function findPreviewResult(
  commit: string,
  github: { githubToken: string; repositoryFullName: string },
): Promise<PreviewResult | null> {
  const octokit = new Octokit({ auth: github.githubToken });
  const [owner, repo] = splitRepositoryFullName(github.repositoryFullName);
  const statuses = await withGithubRetry("repos.listCommitStatusesForRef (preview-settled)", () =>
    octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, {
      owner,
      repo,
      ref: commit,
      per_page: 100,
    }),
  );
  if (
    !statuses.some(
      (status) => /^preview-settled(?: |$)/.test(status.context) && status.state === "success",
    )
  )
    return null;
  const checks = await withGithubRetry("checks.listForRef (preview result)", () =>
    octokit.paginate(octokit.rest.checks.listForRef, {
      owner,
      repo,
      ref: commit,
      filter: "all",
      per_page: 100,
    }),
  );
  const result = previewResultFromChecks(commit, checks, statuses);
  if (!result) return null;
  // GitHub's check can already be green during cleanup, or briefly retain its
  // previous conclusion when Depot queues a retry. Depot is the liveness source.
  const source = new URL(result.url);
  const [, org, workflowId] = source.pathname.match(/^\/orgs\/([^/]+)\/workflows\/([^/]+)$/)!;
  const depot = new Depot({ org, token: process.env.DEPOT_CI_TELEMETRY_TOKEN || "" });
  const workflow = await depot.workflow(workflowId);
  if (workflow.repo !== github.repositoryFullName || workflow.headSha !== commit) return null;
  const producers = workflow.jobs.filter((job) =>
    /:(plan|prepare|apps|playwright:matrix-[0-5]|finish)$/.test(job.jobKey),
  );
  if (
    producers.length !== 10 ||
    producers.some((job) => !["finished", "failed"].includes(job.status))
  )
    return null;
  const settled = statuses.find(
    (status) => status.target_url === result.url && /^preview-settled(?: |$)/.test(status.context),
  );
  if (!settled) return null;
  const settledAt = Date.parse(settled.created_at);
  // GitHub may still show the old green check while a partial retry has failed
  // its guard. Every producer must still be the work that this signal settled.
  if (
    producers.some((job) => {
      if (result.conclusion === "success" && job.status !== "finished") return true;
      if (job.jobId === source.searchParams.get("job")) return false;
      const attempt = currentAttempt(job);
      return !attempt?.finishedAt || Date.parse(attempt.finishedAt) > settledAt;
    })
  )
    return null;
  const finalizer = workflow.jobs.find((job) => job.jobId === source.searchParams.get("job"));
  if (!finalizer || currentAttempt(finalizer)?.attemptId !== source.searchParams.get("attempt"))
    return null;
  const attempt = currentAttempt(finalizer);
  if (
    !attempt?.startedAt ||
    Date.parse(attempt.startedAt) < Date.parse(latestExecution(workflow).createdAt)
  )
    return null;
  return result;
}

/** Inherit only an explicit settled result belonging to the newest complete run. */
export function previewResultFromChecks(
  commit: string,
  input: unknown[],
  statuses: unknown[],
): PreviewResult | null {
  const workflows = new Map<string, z.infer<typeof Check>[]>();
  for (const check of z.array(Check).parse(input)) {
    if (check.app?.slug !== "depot-code-access" || !check.details_url) continue;
    if (!/^Preview(?: Main)? \/ /.test(check.name)) continue;
    const url = new URL(check.details_url);
    if (
      url.origin !== "https://depot.dev" ||
      !/^\/orgs\/[^/]+\/workflows\/[^/]+$/.test(url.pathname)
    )
      continue;
    const key = url.origin + url.pathname;
    const group = workflows.get(key) || [];
    group.push(check);
    workflows.set(key, group);
  }
  // The first check ID identifies when a workflow was created. A finalizer
  // appearing late in an old workflow must not make it look newer than a rerun.
  const latest = [...workflows.values()].sort(
    (a, b) => Math.min(...b.map((check) => check.id)) - Math.min(...a.map((check) => check.id)),
  )[0];
  if (!latest) return null;
  const jobs = new Map<string, z.infer<typeof Check>>();
  for (const check of latest.sort((a, b) => b.id - a.id)) {
    // Depot sometimes includes the reusable caller's display name as well.
    const name = check.name.split(" / ").at(-1)!;
    if (!jobs.has(name)) jobs.set(name, check);
  }
  const finish = jobs.get("Collect results and clean up");
  if (!finish?.completed_at || !finish.details_url) return null;
  const finishedAt = Date.parse(finish.completed_at);
  const required = [
    "Deploy and readiness",
    "App tests",
    ...previewPlaywrightShards.map((shard) => `Playwright ${shard}/6`),
    "Collect results and clean up",
  ];
  const completed = required.map((name) => jobs.get(name));
  if (
    completed.some(
      (check) =>
        !check ||
        check.status !== "completed" ||
        !check.completed_at ||
        !["success", "failure", "timed_out"].includes(check.conclusion || "") ||
        Date.parse(check.completed_at) > finishedAt,
    )
  )
    return null;
  const settled = z
    .array(SettledStatus)
    .parse(statuses)
    .filter((status) => /^preview-settled(?: |$)/.test(status.context))
    .sort((a, b) => b.id - a.id)[0];
  if (!settled || settled.state !== "success" || !settled.target_url) return null;
  const description = /^tests=(success|failure); deployment=restored(?:; check=(\d+))?$/.exec(
    settled.description || "",
  );
  if (!description) return null;
  // Accept earlier deployments while the parent branch still publishes the old form.
  if (settled.context === "preview-settled" && description[2] !== String(finish.id)) return null;
  const source = new URL(settled.target_url);
  const check = new URL(finish.details_url);
  if (
    settled.context !== "preview-settled" &&
    settled.context !== `preview-settled ${source.searchParams.get("attempt")}`
  )
    return null;
  if (
    source.origin !== check.origin ||
    source.pathname !== check.pathname ||
    source.searchParams.get("job") !== check.searchParams.get("job") ||
    !source.searchParams.get("attempt")
  )
    return null;
  const publishedAt = Date.parse(settled.created_at);
  // A rerun may retain its workflow URL. Neither a new finalizer nor a later
  // consumer attempt can borrow an old signal, even if check IDs are reused.
  if (
    !finish.started_at ||
    Date.parse(finish.started_at) > publishedAt ||
    completed.some((job) => job !== finish && Date.parse(job!.completed_at!) > publishedAt)
  )
    return null;
  const conclusion = z.enum(["success", "failure"]).parse(description[1]);
  if (conclusion === "success" && completed.some((job) => job?.conclusion !== "success"))
    return null;
  return { commit, conclusion, url: settled.target_url };
}

const Check = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.iso.datetime().nullable(),
  completed_at: z.iso.datetime().nullable(),
  details_url: z.url().nullable(),
  app: z.object({ slug: z.string().nullable() }).nullable(),
});

const SettledStatus = z.object({
  id: z.number(),
  context: z.string(),
  state: z.string(),
  description: z.string().nullable(),
  target_url: z.url().nullable(),
  created_at: z.iso.datetime(),
});
