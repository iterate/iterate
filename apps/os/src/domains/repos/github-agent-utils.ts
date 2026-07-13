// Path scheme for GitHub pull-request agents: one agent stream per PR of a
// GitHub-linked repo, at `/agents/repos/<repo-slug>/pull-requests/<number>`.
// Shaped after the email thread scheme (`/agents/email/t<threadId>`): the repo
// processor routes PR webhooks here, the `github-agent` processor on the
// routed stream projects them, and the project processor's
// child-stream-created lane births the agent on first append.

import { readNumber, readRecord } from "../integrations/utils.ts";

/** Namespace prefix all PR agent streams live under. */
const GITHUB_AGENT_PATH_PREFIX = "/agents/repos/";

/** Path segment separating the repo slug from the PR number. */
const PULL_REQUESTS_SEGMENT = "/pull-requests/";

/**
 * The agent-path slug for one repo path: a `/repos/…` path drops that
 * conventional prefix, and any remaining slashes flatten to dashes —
 * `/repos/config` → "config", `/tools/bar` → "tools-bar". Pretty over
 * injective: distinct repo paths CAN collide (`/a/b` vs `/a-b`), interleaving
 * their PR agents on one stream. Accepted for v1 — collisions need two linked
 * repos with colliding names AND colliding PR numbers, and the
 * coordinate-keyed `github-agent/route-configured` facts keep the folded state
 * on the latest writer rather than wedging. The fact carries the real
 * repoPath.
 */
export function repoSlugForAgentPath(repoPath: string): string {
  const trimmed = repoPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") throw new Error("PR agent paths need a non-root repo path.");
  const withoutReposPrefix = trimmed.startsWith("repos/")
    ? trimmed.slice("repos/".length)
    : trimmed;
  return withoutReposPrefix.replaceAll("/", "-");
}

/** The agent stream path for one pull request of one repo. */
export function githubAgentPath(repoPath: string, prNumber: number): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`PR number must be a positive integer, got ${prNumber}.`);
  }
  return `${GITHUB_AGENT_PATH_PREFIX}${repoSlugForAgentPath(repoPath)}${PULL_REQUESTS_SEGMENT}${prNumber}`;
}

/** Whether an agent path is a GitHub agent stream (birth wiring + prompt pick). */
export function isGithubAgentPath(agentPath: string): boolean {
  if (!agentPath.startsWith(GITHUB_AGENT_PATH_PREFIX)) return false;
  const rest = agentPath.slice(GITHUB_AGENT_PATH_PREFIX.length);
  const separatorIndex = rest.indexOf(PULL_REQUESTS_SEGMENT);
  if (separatorIndex <= 0) return false;
  return /^\d+$/.test(rest.slice(separatorIndex + PULL_REQUESTS_SEGMENT.length));
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
