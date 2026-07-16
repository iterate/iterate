// Path scheme for GitHub pull-request agents: one agent stream per PR of a
// GitHub link, at `/agents/repos/g~<link-fingerprint>/pull-requests/<number>`.
// Shaped after the email thread scheme (`/agents/email/t<threadId>`): the repo
// processor explicitly appends the Agent, Capability Host, and GitHub facet
// birth certificates before routing the first webhook here. The stream path
// itself selects none of those processors.

import { readNumber, readRecord } from "../integrations/utils.ts";

/** Namespace prefix all PR agent streams live under. */
const GITHUB_AGENT_PATH_PREFIX = "/agents/repos/";

/** Path segment separating the repo slug from the PR number. */
const PULL_REQUESTS_SEGMENT = "/pull-requests/";

/** The bounded agent stream path for one pull request of one GitHub link.
 * Hashing the complete identity prevents a relink from inheriting another
 * repository's permanent LLM conversation while keeping the enclosing
 * Durable Object name safely below Cloudflare's 256-byte hard limit. */
export async function githubAgentPath(
  route: { installationId: string; owner: string; repo: string; repoPath: string },
  prNumber: number,
): Promise<string> {
  if (route.repoPath.replace(/^\/+/, "").replace(/\/+$/, "") === "") {
    throw new Error("PR agent paths need a non-root repo path.");
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`PR number must be a positive integer, got ${prNumber}.`);
  }
  const identity = JSON.stringify([route.repoPath, route.installationId, route.owner, route.repo]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  const fingerprint = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${GITHUB_AGENT_PATH_PREFIX}g~${fingerprint}${PULL_REQUESTS_SEGMENT}${prNumber}`;
}

/** Whether a path uses the bounded GitHub pull-request agent naming scheme. */
export function isGithubAgentPath(agentPath: string): boolean {
  if (!agentPath.startsWith(GITHUB_AGENT_PATH_PREFIX)) return false;
  const rest = agentPath.slice(GITHUB_AGENT_PATH_PREFIX.length);
  return /^g~[a-f0-9]{64}\/pull-requests\/[1-9]\d*$/.test(rest);
}

/**
 * The PR numbers a GitHub webhook body is about, or [] for non-PR webhooks.
 * Shape-based on purpose — ROUTING must not trust headers:
 *
 * - `pull_request*` events carry `body.pull_request.number`;
 * - `issue_comment` events on PRs carry `body.issue.pull_request` + the issue
 *   number (plain issues deliberately do not route);
 * - check/workflow events carry a bounded `pull_requests[]` association.
 *
 * The last shape is what lets CI results become facts on the same PR stream
 * without an API lookup in the repo processor. One check can be associated
 * with more than one PR, so routing is plural all the way through.
 */
export function pullRequestNumbersFromWebhookBody(body: unknown): number[] {
  const record = readRecord(body);
  if (record === null) return [];
  const pullRequestNumber = readNumber(readRecord(record.pull_request)?.number);
  const issue = readRecord(record.issue);
  const issueNumber = issue?.pull_request != null ? readNumber(issue.number) : undefined;
  const associatedPullRequests = [record.check_run, record.check_suite, record.workflow_run]
    .map(readRecord)
    .flatMap((container) =>
      Array.isArray(container?.pull_requests) ? container.pull_requests : [],
    )
    .map((pullRequest) => readNumber(readRecord(pullRequest)?.number));

  return [...new Set([pullRequestNumber, issueNumber, ...associatedPullRequests])].filter(
    (number): number is number => number !== undefined && Number.isInteger(number) && number > 0,
  );
}
