import { setTimeout as delay } from "node:timers/promises";
import { Octokit } from "@octokit/rest";

export type PullRequestPreviewContext = {
  githubToken: string;
  pullRequestBaseSha: string;
  pullRequestBody: string;
  pullRequestHeadSha: string;
  pullRequestHeadRef?: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  workflowRunUrl: string | null;
};

export async function readPullRequestBody(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const pullRequest = await withGithubRetry("pulls.get (body)", () =>
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: params.pullRequestNumber,
    }),
  );

  return pullRequest.data.body || "";
}

export async function writePullRequestBody(params: {
  body: string;
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  // Body-only changes use the pull request's Issue representation.
  await withGithubRetry("issues.update", () =>
    octokit.rest.issues.update({
      body: params.body,
      owner,
      repo,
      issue_number: params.pullRequestNumber,
    }),
  );
}

export function splitRepositoryFullName(repositoryFullName: string) {
  const parts = repositoryFullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Expected repository full name to look like owner/repo. Got: ${repositoryFullName}`,
    );
  }

  return parts as [string, string];
}

export async function resolvePullRequestPreviewContext(params: {
  commandEnvironment: NodeJS.ProcessEnv;
  githubToken: string;
  pullRequestNumber: number;
}): Promise<PullRequestPreviewContext> {
  const repositoryFullName =
    params.commandEnvironment.GITHUB_REPOSITORY?.trim() || "iterate/iterate";
  const octokit = new Octokit({ auth: params.githubToken });
  const [owner, repo] = splitRepositoryFullName(repositoryFullName);
  const pullRequest = await withGithubRetry("pulls.get (context)", () =>
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: params.pullRequestNumber,
    }),
  );

  return {
    githubToken: params.githubToken,
    pullRequestBaseSha: pullRequest.data.base.sha,
    pullRequestBody: pullRequest.data.body || "",
    pullRequestHeadSha: pullRequest.data.head.sha,
    pullRequestHeadRef: pullRequest.data.head.ref,
    pullRequestNumber: params.pullRequestNumber,
    repositoryFullName,
    workflowRunUrl:
      makeDefaultWorkflowRunUrl(params.commandEnvironment) || pullRequest.data.html_url || null,
  };
}

export async function withGithubRetry<T>(
  label: string,
  call: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      const transient = status != null && (status >= 500 || status === 429 || status === 408);
      lastError = error;
      if (!transient || attempt === attempts) throw error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.error(
        `[preview] GitHub ${label} failed with ${status} (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms...`,
      );
      await delay(delayMs, undefined, { signal: opts.signal });
    }
  }
  throw lastError;
}

export function makeDefaultWorkflowRunUrl(env: NodeJS.ProcessEnv) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) {
    return undefined;
  }

  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}
