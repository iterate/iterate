import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { PreviewResult } from "./change-plan.ts";
import { previewPlaywrightShards } from "./playwright-capacity-reporter.ts";
import { splitRepositoryFullName, withGithubRetry } from "./github.ts";

/** Read complete preview checks, keeping different workflows and reruns apart. */
export async function findPreviewResult(
  commit: string,
  github: { githubToken: string; repositoryFullName: string },
): Promise<PreviewResult | null> {
  const octokit = new Octokit({ auth: github.githubToken });
  const [owner, repo] = splitRepositoryFullName(github.repositoryFullName);
  const checks = await withGithubRetry("checks.listForRef (preview result)", () =>
    octokit.paginate(octokit.rest.checks.listForRef, {
      owner,
      repo,
      ref: commit,
      filter: "all",
      per_page: 100,
    }),
  );
  return previewResultFromChecks(commit, checks);
}

/** Missing, running, cancelled or partly rerun checks cannot certify a revision. */
export function previewResultFromChecks(commit: string, input: unknown[]): PreviewResult | null {
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
    const name = check.name.replace(/^Preview(?: Main)? \/ /, "");
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
  return {
    commit,
    conclusion: completed.every((check) => check?.conclusion === "success") ? "success" : "failure",
    url: finish.details_url,
  };
}

const Check = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  completed_at: z.iso.datetime().nullable(),
  details_url: z.url().nullable(),
  app: z.object({ slug: z.string().nullable() }).nullable(),
});
