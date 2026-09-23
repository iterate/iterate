import { Octokit } from "@octokit/rest";
import { z } from "zod";
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
    !statuses.some((status) => status.context === "preview-settled" && status.state === "success")
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
  return previewResultFromChecks(commit, checks, statuses);
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
    // Depot prefixes reusable jobs with every caller's display name. Match
    // the leaf job, keeping names such as "Playwright 3/6" intact.
    const name = check.name.replace(/^.* \/ /, "");
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
    .filter((status) => status.context === "preview-settled")
    .sort((a, b) => b.id - a.id)[0];
  if (!settled || settled.state !== "success" || !settled.target_url) return null;
  const description = /^tests=(success|failure); deployment=restored; check=(\d+)$/.exec(
    settled.description || "",
  );
  if (!description || description[2] !== String(finish.id)) return null;
  const source = new URL(settled.target_url);
  const check = new URL(finish.details_url);
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
