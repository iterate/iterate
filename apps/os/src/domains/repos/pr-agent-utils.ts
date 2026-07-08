// Path scheme for pull-request agents: one agent stream per PR of a
// GitHub-linked repo, at `/agents/repos/<repo-slug>/pull-requests/<number>`.
// Shaped after the email thread scheme (`/agents/email/t<threadId>`): the repo
// processor routes PR webhooks here, the `github-pr-agent` processor on the
// routed stream transcribes them, and the project processor's
// child-stream-created lane births the agent on first append.

/** Namespace prefix all PR agent streams live under. */
export const PR_AGENT_PATH_PREFIX = "/agents/repos/";

/** Path segment separating the repo slug from the PR number. */
const PULL_REQUESTS_SEGMENT = "/pull-requests/";

/**
 * The agent-path slug for one repo path: `/` (the project repo) becomes
 * "root", a `/repos/…` path drops that conventional prefix, and any remaining
 * slashes flatten to dashes — `/repos/foo` → "foo", `/tools/bar` →
 * "tools-bar". Human-readable in the agent path, not a reversible codec: the
 * `github-pr/route-configured` fact on the agent stream carries the real
 * repoPath.
 */
export function repoSlugForAgentPath(repoPath: string): string {
  const trimmed = repoPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return "root";
  const withoutReposPrefix = trimmed.startsWith("repos/")
    ? trimmed.slice("repos/".length)
    : trimmed;
  return withoutReposPrefix.replaceAll("/", "-");
}

/** The agent stream path for one pull request of one repo. */
export function prAgentPath(repoPath: string, prNumber: number): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`PR number must be a positive integer, got ${prNumber}.`);
  }
  return `${PR_AGENT_PATH_PREFIX}${repoSlugForAgentPath(repoPath)}${PULL_REQUESTS_SEGMENT}${prNumber}`;
}

/** Whether an agent path is a PR agent stream (birth wiring + prompt pick). */
export function isPrAgentPath(agentPath: string): boolean {
  if (!agentPath.startsWith(PR_AGENT_PATH_PREFIX)) return false;
  const rest = agentPath.slice(PR_AGENT_PATH_PREFIX.length);
  const separatorIndex = rest.indexOf(PULL_REQUESTS_SEGMENT);
  if (separatorIndex <= 0) return false;
  return /^\d+$/.test(rest.slice(separatorIndex + PULL_REQUESTS_SEGMENT.length));
}

/**
 * The PR number a GitHub webhook body is about, or null for non-PR webhooks.
 * Shape-based on purpose (no reliance on the x-github-event header surviving
 * capture): `pull_request` events carry `body.pull_request.number`;
 * `issue_comment` events on PRs carry `body.issue.pull_request` + the number
 * on the issue. Plain issue events (no `issue.pull_request`) stay null.
 */
export function pullRequestNumberFromWebhookBody(body: unknown): number | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const pullRequest = record.pull_request;
  if (pullRequest !== null && typeof pullRequest === "object" && !Array.isArray(pullRequest)) {
    const number = (pullRequest as Record<string, unknown>).number;
    if (typeof number === "number" && Number.isInteger(number) && number > 0) return number;
  }

  const issue = record.issue;
  if (issue !== null && typeof issue === "object" && !Array.isArray(issue)) {
    const issueRecord = issue as Record<string, unknown>;
    if (issueRecord.pull_request != null) {
      const number = issueRecord.number;
      if (typeof number === "number" && Number.isInteger(number) && number > 0) return number;
    }
  }

  return null;
}
