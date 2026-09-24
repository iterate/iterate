import { readFileSync } from "node:fs";

import { Octokit } from "@octokit/rest";

import { PLATFORM_FAILURE_DELAYS_MS, retryPlatformFailures } from "./platform-retry.ts";

export function getOctokit() {
  const auth = process.env.GITHUB_TOKEN;
  if (!auth) {
    throw new Error("GITHUB_TOKEN is required");
  }
  return createOctokit(auth);
}

/** Every CI script's Octokit: one that asks again when GitHub itself fails an idempotent call. */
export function createOctokit(auth: string | undefined) {
  return retryGithubPlatformFailures(new Octokit({ auth }), PLATFORM_FAILURE_DELAYS_MS);
}

/**
 * GitHub answers a small share of API calls with a 5xx, or the connection drops before it
 * answers at all. One such 500 on `GET /pulls/2899` failed a LOC report whose same-sha rerun
 * passed a quarter of an hour later. A call that GitHub failed is asked again after each of
 * `delaysMs` (platform-retry.ts), with a `github.platform-failure-retry` warn per repeat.
 *
 * Only GET, HEAD, PUT, PATCH and DELETE are asked again: each names its whole end state, so a
 * repeat after a write that did land is harmless. A POST creates (a release, a comment), and a
 * repeat after a 5xx that had landed would create a second one, so a POST's failure is thrown at
 * once, except a commit status: GitHub reports the latest status per context, so a second copy
 * changes nothing (a 503 on the CI trace's status failed Main OS e2e's trace job, 2026-09-24).
 * A 4xx is an answer about the request and is never asked again. A caller whose write must go out
 * once (a PR body PATCHed from a read seconds earlier) passes `request: { askOnce: true }`.
 */
export function retryGithubPlatformFailures(octokit: Octokit, delaysMs: readonly number[]) {
  octokit.hook.wrap("request", (request, options) => {
    const route = `${options.method} ${options.url}`;
    const repeatable =
      (idempotentMethods.has(options.method) || repeatableRoutes.has(route)) &&
      options.request?.askOnce !== true;
    return retryPlatformFailures(async () => request(options), {
      event: "github.platform-failure-retry",
      delaysMs: repeatable ? delaysMs : [],
      platformFailure: (error) => {
        const failure = githubPlatformFailure(error);
        return failure && { route, ...failure };
      },
    });
  });
  return octokit;
}

const idempotentMethods = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE"]);
const repeatableRoutes = new Set(["POST /repos/{owner}/{repo}/statuses/{sha}"]);

/**
 * `@octokit/request` throws an `HttpError` for every failure: with a `response` when GitHub
 * answered, without one when `fetch` itself failed (connection reset, DNS), which it reports as
 * status 500. An abort is rethrown as the `AbortError` it is, and is not GitHub's failure.
 * Returns what to log for a GitHub-side failure (its request id is what GitHub support asks
 * for), else undefined.
 */
function githubPlatformFailure(error: unknown) {
  if (!(error instanceof Error) || error.name !== "HttpError") return undefined;
  const { status, response } = error as Error & {
    status: number;
    response?: { headers: Record<string, string | undefined> };
  };
  if (!response) return { status: "network", message: error.message };
  if (status < 500) return undefined;
  return { status, requestId: response.headers["x-github-request-id"], message: error.message };
}

export function getRepo() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required");
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  }
  return { owner, repo };
}

/** The subset of GitHub webhook event payload fields our CI scripts read. */
export type GithubEventPayload = {
  action?: string;
  pull_request?: {
    number: number;
    title?: string;
    html_url?: string;
    body?: string | null;
    draft?: boolean;
    merged?: boolean;
    merged_by?: { login?: string | null } | null;
    merge_commit_sha?: string | null;
    user?: { login?: string | null } | null;
    base?: { ref: string; sha: string };
    head?: { ref?: string; sha: string };
  };
  sender?: { login?: string | null };
};

export function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }
  return JSON.parse(readFileSync(eventPath, "utf8")) as GithubEventPayload;
}

export function getRunUrl() {
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_RUN_ID are required");
  }
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}
