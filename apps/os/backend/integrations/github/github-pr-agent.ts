import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import {
  buildDefaultGitHubPrAgentPath,
  normalizeAgentPath,
} from "@iterate-com/shared/github-agent-path";
import type { CloudflareEnv } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { getGitHubInstallationToken } from "./github.ts";

// ── Types ───────────────────────────────────────────────────────────

type GitHubRepoCoordinates = { owner: string; name: string; fullName: string };

type GitHubComment = { body: string; user: { login: string } };

type PullRequestContext = {
  pullRequest: {
    number: number;
    title: string;
    body: string;
    htmlUrl: string;
    authorLogin: string;
  };
  issueComments: GitHubComment[];
  reviews: GitHubComment[];
  reviewComments: GitHubComment[];
};

type PullRequestSignal = {
  repo: GitHubRepoCoordinates;
  prNumber: number;
  eventKind:
    | "workflow_run"
    | "pull_request"
    | "pull_request_review"
    | "pull_request_review_comment"
    | "issue_comment";
  action: string;
  actorLogin: string;
  eventBody: string;
  eventUrl: string;
};

type ParsedPrRoutingMarker = {
  hasAgentMarker: boolean;
  agentPath: string | null;
};

// ── Constants ───────────────────────────────────────────────────────

const LOW_TRUST_PATTERNS = [/bugbot/i, /pullfrog/i, /cursor/i];
const LOW_RISK_PATTERN = /\blow[-\s]?risk\b/i;

function parseAgentPathFromBody(body: string | null | undefined): string | null {
  if (!body) return null;

  // Preferred marker block:
  // <!-- iterate-agent-context
  // agent_path: /github/foo/bar/pr-123
  // -->
  const contextBlockRegex = /<!--\s*iterate-agent-context([\s\S]*?)-->/gi;
  for (const match of body.matchAll(contextBlockRegex)) {
    const block = match[1] ?? "";
    const lineMatch = block.match(/^\s*agent_path\s*:\s*(.+)$/im);
    const parsed = normalizeAgentPath(lineMatch?.[1]);
    if (parsed) return parsed;
  }

  return null;
}

function parsePrRoutingMarker(params: {
  appSlug: string;
  pullRequestBody: string | null | undefined;
}): ParsedPrRoutingMarker {
  const { appSlug, pullRequestBody } = params;
  const marker = `<!-- ${appSlug}:agent-pr -->`;
  const hasAgentMarker = pullRequestBody ? pullRequestBody.toLowerCase().includes(marker) : false;
  const agentPath = parseAgentPathFromBody(pullRequestBody);
  return { hasAgentMarker, agentPath };
}

// ── Prompt Building ─────────────────────────────────────────────────

function buildPrompt(params: {
  signal: PullRequestSignal;
  context: PullRequestContext;
  agentPath: string;
}): string {
  const { signal, context, agentPath } = params;
  const isBot = (login: string) => LOW_TRUST_PATTERNS.some((p) => p.test(login));
  const hasLowRisk = [...context.issueComments, ...context.reviews, ...context.reviewComments].some(
    (c) => /cursor/i.test(c.user.login) && LOW_RISK_PATTERN.test(c.body),
  );

  const lines = [
    "[GitHub PR Event]",
    `Repo: ${signal.repo.fullName}`,
    `PR: #${context.pullRequest.number} ${context.pullRequest.htmlUrl}`,
    `PR title: ${context.pullRequest.title}`,
    `PR author: ${context.pullRequest.authorLogin}`,
    `Event: ${signal.eventKind}`,
    `Action: ${signal.action}`,
    `Actor: ${signal.actorLogin}`,
    `Event URL: ${signal.eventUrl}`,
    `Target agent path: ${agentPath}`,
  ];

  if (signal.eventBody) lines.push("", "Event body:", signal.eventBody);
  if (signal.eventKind === "pull_request" && signal.action === "closed") {
    lines.push(
      "",
      "Post-merge follow-up guidance:",
      "- PR is merged. Monitor the deploy-os workflow plus logs/checks to confirm rollout health.",
      "- Exit when you are confident the fix solved the issues and introduced no new ones.",
    );
  }
  lines.push(
    "",
    "Fix validation guidance:",
    "- After making changes, monitor relevant logs/checks/comments to confirm the fix actually worked.",
    "- When review comments request changes, update the PR directly and report back with what changed.",
  );
  if (isBot(signal.actorLogin)) {
    lines.push(
      "",
      "Automated reviewer guidance:",
      "- You are allowed to reject feedback, especially from reviewbots.",
    );
  }
  lines.push(
    "",
    "Reviewbot action guidance:",
    "- For issues flagged by Cursor Bugbot/pullfrog/other reviewbots: if validated and safe, apply fixes directly without asking for confirmation.",
  );
  if (hasLowRisk) {
    lines.push(
      "",
      "Cursor low-risk merge guidance:",
      "- If Cursor Bugbot marked this low risk and independent verification shows merge is safe, you may auto-merge.",
    );
  }
  lines.push(
    "",
    "PR routing marker:",
    "- When creating or updating a PR body, always include this hidden block at the very end so webhook events route back to this agent session:",
    "```",
    `<!-- iterate-agent-context`,
    `agent_path: ${agentPath}`,
    `-->`,
    `<!-- iterate:agent-pr -->`,
    "```",
  );
  return lines.join("\n");
}

// ── API Helpers ─────────────────────────────────────────────────────

async function githubApi<T>(params: {
  token: string;
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<T> {
  const response = await fetch(params.url, {
    method: params.method ?? "GET",
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Iterate-OS",
      ...(params.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`GitHub API ${response.status} for ${params.url}: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

async function forwardPromptToMachine(params: {
  machine: typeof schema.machine.$inferSelect;
  env: CloudflareEnv;
  agentPath: string;
  prompt: string;
}) {
  const metadata = params.machine.metadata as Record<string, unknown> | null;
  const runtime = await createMachineStub({
    type: params.machine.type,
    env: params.env,
    externalId: params.machine.externalId,
    metadata: metadata ?? {},
  });

  let fetcher: (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
  try {
    fetcher = await runtime.getFetcher(3000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("No host port mapped for 8080")) throw err;
    const baseUrl = await runtime.getBaseUrl(3000);
    logger.set({
      machineId: params.machine.id,
      machineType: params.machine.type,
    });
    logger.warn("[GitHub Webhook] Falling back to direct daemon base URL");
    fetcher = (input, init) => {
      const url =
        typeof input === "string" && !/^https?:\/\//.test(input) ? `${baseUrl}${input}` : input;
      return fetch(url, init);
    };
  }

  const path = `/api/agents${params.agentPath}`;

  const response = await fetcher(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "iterate:agent:prompt-added", message: params.prompt }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`Agent forward failed (${response.status}): ${body.slice(0, 500)}`);
  }
}

// ── Data Fetching & Routing ─────────────────────────────────────────

async function listRepoMachineContexts(db: DB, repo: GitHubRepoCoordinates) {
  const projects = await db.query.project.findMany({
    where: (project, { eq: whereEq }) =>
      whereEq(project.configRepoFullName, `${repo.owner}/${repo.name}`),
    with: {
      machines: {
        where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
        limit: 1,
      },
    },
  });

  const results = await Promise.all(
    projects.map(async (project) => {
      const machine = project.machines[0];
      if (!machine) return null;
      const conn = await db.query.projectConnection.findFirst({
        where: (c, { eq: whereEq, and: whereAnd }) =>
          whereAnd(whereEq(c.projectId, project.id), whereEq(c.provider, "github-app")),
      });
      const installationId = (conn?.providerData as { installationId?: number } | undefined)
        ?.installationId;
      if (!installationId) return null;
      return { projectSlug: project.slug, machine, installationId };
    }),
  );

  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

async function fetchPullRequestContext(params: {
  token: string;
  repo: GitHubRepoCoordinates;
  prNumber: number;
}): Promise<PullRequestContext> {
  const prefix = `https://api.github.com/repos/${params.repo.owner}/${params.repo.name}`;

  const pr = await githubApi<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
  }>({ token: params.token, url: `${prefix}/pulls/${params.prNumber}` });

  const [issueComments, reviews, reviewComments] = await Promise.all([
    githubApi<GitHubComment[]>({
      token: params.token,
      url: `${prefix}/issues/${params.prNumber}/comments?per_page=100`,
    }),
    githubApi<GitHubComment[]>({
      token: params.token,
      url: `${prefix}/pulls/${params.prNumber}/reviews?per_page=100`,
    }),
    githubApi<GitHubComment[]>({
      token: params.token,
      url: `${prefix}/pulls/${params.prNumber}/comments?per_page=100`,
    }),
  ]);

  return {
    pullRequest: {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      htmlUrl: pr.html_url,
      authorLogin: pr.user.login,
    },
    issueComments,
    reviews,
    reviewComments,
  };
}

export async function routePullRequestSignalToAgent(params: {
  db: DB;
  env: CloudflareEnv;
  signal: PullRequestSignal;
}) {
  const contexts = await listRepoMachineContexts(params.db, params.signal.repo);

  if (contexts.length === 0) {
    logger.debug("[GitHub Webhook] No active machine for PR signal", {
      repo: params.signal.repo.fullName,
      prNumber: params.signal.prNumber,
    });
    return;
  }

  const fallbackAgentPath = buildDefaultGitHubPrAgentPath(
    params.signal.repo,
    params.signal.prNumber,
  );

  for (const ctx of contexts) {
    try {
      const token = await getGitHubInstallationToken(params.env, ctx.installationId);
      if (!token) throw new Error(`No installation token for installation ${ctx.installationId}`);

      const prContext = await fetchPullRequestContext({
        token,
        repo: params.signal.repo,
        prNumber: params.signal.prNumber,
      });

      const appSlug = params.env.GITHUB_APP_SLUG.toLowerCase();
      const botLogin = `${appSlug}[bot]`;
      const botHandles = [`@${botLogin}`, `@${appSlug}`] as const;
      const mentions = (text: string | null | undefined) =>
        text ? botHandles.some((h) => text.toLowerCase().includes(h)) : false;
      const marker = parsePrRoutingMarker({
        appSlug,
        pullRequestBody: prContext.pullRequest.body,
      });
      const authorLogin = prContext.pullRequest.authorLogin.toLowerCase();
      const authorIsBot = botHandles.some((h) => authorLogin === h.slice(1));
      const trustedMarker = authorIsBot;
      const shouldProcess =
        authorIsBot ||
        (trustedMarker && marker.hasAgentMarker) ||
        (trustedMarker && marker.agentPath !== null) ||
        mentions(prContext.pullRequest.title) ||
        mentions(prContext.pullRequest.body) ||
        prContext.issueComments.some((c) => mentions(c.body)) ||
        prContext.reviews.some((r) => mentions(r.body)) ||
        prContext.reviewComments.some((c) => mentions(c.body));

      const agentPath = trustedMarker ? (marker.agentPath ?? fallbackAgentPath) : fallbackAgentPath;

      if (!shouldProcess) {
        logger.debug("[GitHub Webhook] PR signal ignored — no bot mention", {
          repo: params.signal.repo.fullName,
          prNumber: params.signal.prNumber,
          eventKind: params.signal.eventKind,
          actor: params.signal.actorLogin,
          projectSlug: ctx.projectSlug,
        });
        continue;
      }

      const prompt = buildPrompt({
        signal: params.signal,
        context: prContext,
        agentPath,
      });

      await forwardPromptToMachine({
        machine: ctx.machine,
        env: params.env,
        agentPath,
        prompt,
      });

      logger.set({
        repo: params.signal.repo.fullName,
        prNumber: params.signal.prNumber,
        eventKind: params.signal.eventKind,
        action: params.signal.action,
        projectSlug: ctx.projectSlug,
        targetKind: "path",
      });
      logger.info("[GitHub Webhook] Routed PR signal to agent");
    } catch (err) {
      logger.error("[GitHub Webhook] Failed routing PR signal to project", {
        repo: params.signal.repo.fullName,
        prNumber: params.signal.prNumber,
        projectSlug: ctx.projectSlug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
