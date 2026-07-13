import type { Octokit } from "octokit";

export type GithubReviewCheckShell = {
  appSlug?: string;
  externalId: string;
  id?: number;
  superseded?: { externalId: string; headSha: string };
  url?: string;
};

type ChecksApi = Pick<Octokit["rest"]["checks"], "create" | "listForRef" | "update">;

type ReviewCheckIdentity = {
  installationId: string;
  projectId: string;
  pullRequestNumber: number;
  reviewKey: string;
};

/** Stable inside one GitHub App installation and short enough for GitHub's
 * external-id field even when owner/repository names are maximal. */
export function githubReviewCheckExternalId(input: ReviewCheckIdentity): string {
  return `iterate-review:${input.projectId}:${input.installationId}:${input.pullRequestNumber}:${input.reviewKey}`;
}

export async function ensureGithubReviewCheck(input: {
  appSlug?: string;
  checks: ChecksApi;
  externalId: string;
  headSha: string;
  now?: () => Date;
  owner: string;
  repo: string;
  superseded?: { externalId: string; headSha: string };
}): Promise<{ id: number; url?: string }> {
  const [existing] = await Promise.all([
    findReviewCheck(input, input.headSha, input.externalId),
    input.superseded === undefined
      ? Promise.resolve()
      : cancelSupersededReviewCheck(input, input.superseded),
  ]);
  if (existing !== undefined) return checkResult(existing);

  const created = await input.checks.create({
    external_id: input.externalId,
    head_sha: input.headSha,
    name: "Iterate Review",
    output: {
      summary: "Reviewing this revision against the configured rules.",
      title: "Iterate is reviewing",
    },
    owner: input.owner,
    repo: input.repo,
    started_at: (input.now ?? (() => new Date()))().toISOString(),
    status: "in_progress",
  });
  return checkResult(created.data);
}

/** Terminal safety net for a model/tool loop that never completed its shell.
 * Normal useful output remains agent-owned; this only closes stale UI. */
export async function expireGithubReviewCheck(input: {
  appSlug?: string;
  checks: ChecksApi;
  externalId: string;
  headSha: string;
  now?: () => Date;
  owner: string;
  repo: string;
}): Promise<boolean> {
  const check = await findReviewCheck(input, input.headSha, input.externalId);
  if (check === undefined || check.status === "completed") return false;
  await input.checks.update({
    check_run_id: check.id,
    completed_at: (input.now ?? (() => new Date()))().toISOString(),
    conclusion: "failure",
    output: {
      summary:
        "The review agent did not complete this check within 30 minutes. The next push or manual review request will retry.",
      title: "Review did not complete",
    },
    owner: input.owner,
    repo: input.repo,
    status: "completed",
  });
  return true;
}

async function cancelSupersededReviewCheck(
  input: Parameters<typeof ensureGithubReviewCheck>[0],
  superseded: NonNullable<Parameters<typeof ensureGithubReviewCheck>[0]["superseded"]>,
): Promise<void> {
  const check = await findReviewCheck(input, superseded.headSha, superseded.externalId);
  if (check === undefined || check.status === "completed") return;
  const completedAt = (input.now ?? (() => new Date()))().toISOString();
  await input.checks.update({
    check_run_id: check.id,
    completed_at: completedAt,
    conclusion: "cancelled",
    output: {
      summary: "A newer pull-request revision superseded this review.",
      title: "Review superseded",
    },
    owner: input.owner,
    repo: input.repo,
    status: "completed",
  });
}

async function findReviewCheck(
  input: Pick<
    Parameters<typeof ensureGithubReviewCheck>[0],
    "appSlug" | "checks" | "owner" | "repo"
  >,
  headSha: string,
  externalId: string,
) {
  for (let page = 1; ; page += 1) {
    const response = await input.checks.listForRef({
      check_name: "Iterate Review",
      filter: "all",
      owner: input.owner,
      page,
      per_page: 100,
      ref: headSha,
      repo: input.repo,
    });
    const match = response.data.check_runs.find(
      (candidate) =>
        candidate.external_id === externalId &&
        input.appSlug !== undefined &&
        candidate.app?.slug === input.appSlug,
    );
    if (match !== undefined) return match;
    if (response.data.check_runs.length < 100) return undefined;
  }
}

function checkResult(check: { html_url: string | null; id: number }): { id: number; url?: string } {
  return {
    id: check.id,
    ...(check.html_url === null ? {} : { url: check.html_url }),
  };
}
