import { readFileSync } from "node:fs";

import { Octokit } from "@octokit/rest";

import {
  CI_HTTP,
  retryPlatformFailures,
  type FailureKind,
} from "@iterate-com/shared/platform-retry";

export function getOctokit() {
  const auth = process.env.GITHUB_TOKEN;
  if (!auth) {
    throw new Error("GITHUB_TOKEN is required");
  }
  return createOctokit(auth);
}

/** Every CI script's Octokit: one that asks again when GitHub itself fails an idempotent call. */
export function createOctokit(auth: string | undefined) {
  return retryGithubPlatformFailures(new Octokit({ auth }));
}

/**
 * GitHub answers a small share of API calls with a 5xx, or the connection drops before it
 * answers at all. One such 500 on `GET /pulls/2899` failed a LOC report whose same-sha rerun
 * passed a quarter of an hour later. A call that GitHub failed is asked again after each of
 * CI_HTTP's waits (`retryPlatformFailures`), with a `github.platform-failure-retry` warn per repeat.
 *
 * Only GET, HEAD, PUT, PATCH and DELETE are asked again: each names its whole end state, so a
 * repeat after a write that did land is harmless. A POST creates (a release, a comment), and a
 * repeat after a 5xx that had landed would create a second one, so a POST's failure is thrown at
 * once, except a commit status: GitHub reports the latest status per context, so a second copy
 * changes nothing (a 503 on the CI trace's status failed Main OS e2e's trace job, 2026-09-24).
 * A 4xx is an answer about the request and is never asked again. A caller whose write must go out
 * once (a PR body PATCHed from a read seconds earlier) passes `request: { askOnce: true }`.
 */
export function retryGithubPlatformFailures(octokit: Octokit) {
  octokit.hook.wrap("request", (request, options) => {
    const route = `${options.method} ${options.url}`;
    const repeatable =
      (idempotentMethods.has(options.method) || repeatableRoutes.has(route)) &&
      options.request?.askOnce !== true;
    return retryPlatformFailures(async () => request(options), {
      area: "github",
      schedule: CI_HTTP,
      idempotent: repeatable,
      kind: githubFailureKind,
      describe: (error) => ({ route, ...githubFailureFields(error) }),
    });
  });
  return octokit;
}

const idempotentMethods = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE"]);
const repeatableRoutes = new Set(["POST /repos/{owner}/{repo}/statuses/{sha}"]);

/**
 * `@octokit/request` throws an `HttpError` for every failure: with a `response` when GitHub
 * answered, without one when `fetch` itself failed (connection reset, DNS), which it reports as
 * status 500. A 5xx or a failed connection is GitHub's failure; an abort is rethrown as the
 * `AbortError` it is, and is not GitHub's failure.
 */
function githubFailureKind(error: unknown): FailureKind {
  if (!(error instanceof Error) || error.name !== "HttpError") return "failed";
  const { status, response } = githubHttpError(error);
  return !response || status >= 500 ? "disconnected" : "refused";
}

/** What to log for GitHub's failure: its request id is what GitHub support asks for. */
function githubFailureFields(error: unknown) {
  if (!(error instanceof Error)) return {};
  const { status, response } = githubHttpError(error);
  if (!response) return { status: "network", message: error.message };
  return { status, requestId: response.headers["x-github-request-id"], message: error.message };
}

/** `@octokit/request`'s `HttpError`, as the two readers above use it: asserted, since both only
 *  compare `status` and read `response` when it is there, and `describe` runs only on the errors
 *  `githubFailureKind` found to be GitHub's. */
const githubHttpError = (error: Error) =>
  error as Error & { status: number; response?: { headers: Record<string, string | undefined> } };

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
