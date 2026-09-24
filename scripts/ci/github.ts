import { readFileSync } from "node:fs";

import { Octokit } from "@octokit/rest";

export function getOctokit() {
  const auth = process.env.GITHUB_TOKEN;
  if (!auth) {
    throw new Error("GITHUB_TOKEN is required");
  }
  return new Octokit({ auth });
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
