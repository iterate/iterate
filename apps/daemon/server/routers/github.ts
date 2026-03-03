import { createHash } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod/v4";
import {
  buildDefaultGitHubPrAgentPath,
  normalizeAgentPath,
  toPathSegment,
} from "@iterate-com/shared/github-agent-path";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";

const logger = console;

const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;
const AGENT_ROUTER_BASE_URL = `${DAEMON_BASE_URL}/api/agents`;

const DEBOUNCE_MS = 30_000;
const PR_MAPPING_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const BUFFER_TTL_MS = 2 * 60 * 60 * 1000;
const INSTRUCTIONS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NON_GITHUB_PATH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const AppSlug =
  (process.env.ITERATE_GITHUB_APP_SLUG || "iterate")
    .toLowerCase()
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 64) || "iterate";

const escapedAppSlug = AppSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slugMarkerRegex = new RegExp(
  `<!--\\s*${escapedAppSlug}:agent-pr(?:\\s+[\\s\\S]*?)?\\s*-->`,
  "i",
);
const slugMentionRegex = new RegExp(`(^|\\s)@${escapedAppSlug}(?=\\s|$|[.,:;!?])`, "i");
const iterateAgentContextRegex = /<!--\s*iterate-agent-context([\s\S]*?)-->/gi;

const ForwardedWebhookInput = z.object({
  eventType: z.string(),
  deliveryId: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

type ForwardedWebhookInput = z.infer<typeof ForwardedWebhookInput>;

const PullRequestRef = z.object({ number: z.number(), html_url: z.string().optional() });

const RepositoryPayload = z.object({
  full_name: z.string().optional(),
  owner: z.object({ login: z.string() }).optional(),
  name: z.string().optional(),
});

const PullRequestEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  pull_request: PullRequestRef.extend({
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    merged: z.boolean().optional(),
    draft: z.boolean().optional(),
  }),
  sender: z.object({ login: z.string() }).optional(),
});

const IssueCommentEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  issue: z.object({
    number: z.number(),
    html_url: z.string().optional(),
    body: z.string().nullable().optional(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    body: z.string(),
    html_url: z.string().optional(),
    user: z.object({ login: z.string() }),
  }),
});

const PullRequestReviewEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  pull_request: PullRequestRef.extend({
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    draft: z.boolean().optional(),
  }),
  review: z.object({
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    user: z.object({ login: z.string() }),
  }),
});

const PullRequestReviewCommentEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  pull_request: PullRequestRef.extend({
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    draft: z.boolean().optional(),
  }),
  comment: z.object({
    body: z.string(),
    html_url: z.string().optional(),
    user: z.object({ login: z.string() }),
  }),
});

const WorkflowRunEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  workflow_run: z.object({
    name: z.string(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string().optional(),
    head_branch: z.string().optional(),
    pull_requests: z
      .array(z.object({ number: z.number() }))
      .optional()
      .default([]),
  }),
});

type RepoCoords = { owner: string; name: string; fullName: string };

type ResolvedPrSignal = {
  repo: RepoCoords;
  prNumber: number;
  eventKind: string;
  action: string;
  actorLogin: string;
  eventBody: string;
  eventUrl: string;
  bucketKey: string;
  immediate: boolean;
  markerBody: string | null;
};

type PrMapping = { agentPath: string };

type BufferedSignal = {
  bucketKey: string;
  eventKind: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
};

class BufferedFlushPartialError extends Error {
  readonly flushedRows: ReadonlySet<BufferedSignal>;

  constructor(
    message: string,
    flushedRows: ReadonlySet<BufferedSignal>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BufferedFlushPartialError";
    this.flushedRows = flushedRows;
  }
}

type AgentPathResolution = {
  agentPath: string;
  source: "session" | "marker" | "mapping" | "default" | "session-unresolved" | "unsafe-fallback";
};

const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const bufferedSignalsByAgentPath = new Map<string, BufferedSignal[]>();
const webhookStateByAgentPath = new Map<
  string,
  {
    instructionsSentAtMs: number | null;
    lastEventHash: string | null;
    lastEventAtMs: number | null;
    lastSeenAtMs: number;
  }
>();

export const githubRouter = new Hono();

githubRouter.post("/webhook", async (c) => {
  const parsedInput = ForwardedWebhookInput.safeParse(await c.req.json());
  if (!parsedInput.success) {
    return c.json({ error: "Invalid request body", issues: parsedInput.error.issues }, 400);
  }

  const input = parsedInput.data;
  try {
    logger.debug("[daemon/github] Received webhook", {
      eventType: input.eventType,
      deliveryId: input.deliveryId,
    });

    await pruneExpiredState();

    const signals = collectSignals(input);
    if (signals.length === 0) {
      logger.debug("[daemon/github] Ignored webhook: no routable signals", {
        eventType: input.eventType,
        deliveryId: input.deliveryId,
      });
      return c.json({ success: true, handled: false, reason: "ignored" });
    }

    for (const signal of signals) {
      const existingMapping = await getExistingPrMapping(signal.repo, signal.prNumber);
      const authSource = getAuthorizationSource(signal, Boolean(existingMapping));
      if (!authSource) {
        logger.debug("[daemon/github] Ignored signal: missing authorization", {
          deliveryId: input.deliveryId,
          eventKind: signal.eventKind,
          prNumber: signal.prNumber,
          repo: signal.repo.fullName,
          authSource: "none",
        });
        continue;
      }

      const resolution = await resolveAgentPath({
        repo: signal.repo,
        prNumber: signal.prNumber,
        markerBody: signal.markerBody,
        existingMapping,
      });
      const agentPath = resolution.agentPath;

      const eventHash = hashSignal(signal, input.deliveryId);
      const { includeInstructions, duplicate } = await upsertWebhookState({
        agentPath,
        eventHash,
      });

      if (duplicate) {
        logger.debug("[daemon/github] Duplicate signal skipped", {
          deliveryId: input.deliveryId,
          eventKind: signal.eventKind,
          prNumber: signal.prNumber,
          agentPath,
        });
        continue;
      }

      logger.debug("[daemon/github] Routed signal", {
        deliveryId: input.deliveryId,
        eventKind: signal.eventKind,
        prNumber: signal.prNumber,
        repo: signal.repo.fullName,
        agentPath,
        pathSource: resolution.source,
        authSource,
        immediate: signal.immediate,
      });

      if (signal.immediate) {
        const prompt = await buildPrompt({ signal, agentPath, includeInstructions });
        await postPromptToAgent(agentPath, prompt);
        logger.debug("[daemon/github] Forwarded immediate signal to agent", {
          deliveryId: input.deliveryId,
          eventKind: signal.eventKind,
          prNumber: signal.prNumber,
          agentPath,
        });
        continue;
      }

      await enqueueBufferedSignal({
        agentPath,
        bucketKey: signal.bucketKey,
        eventKind: signal.eventKind,
        payload: {
          eventKind: signal.eventKind,
          action: signal.action,
          body: signal.eventBody,
          actor: signal.actorLogin,
          eventUrl: signal.eventUrl,
        },
      });
      scheduleFlush(agentPath);
      logger.debug("[daemon/github] Buffered signal for debounce", {
        deliveryId: input.deliveryId,
        eventKind: signal.eventKind,
        prNumber: signal.prNumber,
        agentPath,
      });
    }

    return c.json({ success: true, handled: true, count: signals.length });
  } catch (error) {
    logger.error("[daemon/github] Failed to handle webhook", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

function scheduleFlush(agentPath: string): void {
  if (flushTimers.has(agentPath)) return;
  const timer = setTimeout(() => {
    flushTimers.delete(agentPath);
    void flushBufferedSignalsForAgent(agentPath).catch((error) => {
      logger.error("[daemon/github] Failed flushing buffered signals", error);
    });
  }, DEBOUNCE_MS);
  flushTimers.set(agentPath, timer);
}

function resolveRepoCoordinates(repository: z.infer<typeof RepositoryPayload>): RepoCoords | null {
  const split = repository.full_name?.split("/") ?? [];
  const owner = repository.owner?.login?.trim() || split[0]?.trim();
  const name = repository.name?.trim() || split[1]?.trim();
  if (!owner || !name) return null;
  return { owner, name, fullName: `${owner}/${name}` };
}

function buildImmediateSignal(params: {
  repo: RepoCoords;
  prNumber: number;
  eventKind: string;
  action: string;
  actorLogin: string;
  eventBody: string;
  eventUrl: string;
  markerBody: string | null;
}): ResolvedPrSignal {
  return {
    repo: params.repo,
    prNumber: params.prNumber,
    eventKind: params.eventKind,
    action: params.action,
    actorLogin: params.actorLogin,
    eventBody: params.eventBody,
    eventUrl: params.eventUrl,
    bucketKey: `pr-${params.prNumber}`,
    immediate: true,
    markerBody: params.markerBody,
  };
}

const signalCollectors: Record<string, (input: ForwardedWebhookInput) => ResolvedPrSignal[]> = {
  issue_comment: (input) => {
    const parsed = IssueCommentEvent.safeParse(input.payload);
    if (!parsed.success || parsed.data.action !== "created" || !parsed.data.issue.pull_request)
      return [];
    const repo = resolveRepoCoordinates(parsed.data.repository);
    if (!repo) return [];
    return [
      buildImmediateSignal({
        repo,
        prNumber: parsed.data.issue.number,
        eventKind: "issue_comment",
        action: parsed.data.action,
        actorLogin: parsed.data.comment.user.login,
        eventBody: parsed.data.comment.body,
        eventUrl: parsed.data.comment.html_url ?? parsed.data.issue.html_url ?? "",
        markerBody: parsed.data.issue.body ?? null,
      }),
    ];
  },
  pull_request_review_comment: (input) => {
    const parsed = PullRequestReviewCommentEvent.safeParse(input.payload);
    if (!parsed.success || parsed.data.action !== "created") return [];
    const repo = resolveRepoCoordinates(parsed.data.repository);
    if (!repo) return [];
    return [
      buildImmediateSignal({
        repo,
        prNumber: parsed.data.pull_request.number,
        eventKind: "pull_request_review_comment",
        action: parsed.data.action,
        actorLogin: parsed.data.comment.user.login,
        eventBody: parsed.data.comment.body,
        eventUrl: parsed.data.comment.html_url ?? parsed.data.pull_request.html_url ?? "",
        markerBody: parsed.data.pull_request.body ?? null,
      }),
    ];
  },
  pull_request_review: (input) => {
    const parsed = PullRequestReviewEvent.safeParse(input.payload);
    if (!parsed.success || parsed.data.action !== "submitted") return [];
    const repo = resolveRepoCoordinates(parsed.data.repository);
    if (!repo) return [];
    return [
      buildImmediateSignal({
        repo,
        prNumber: parsed.data.pull_request.number,
        eventKind: "pull_request_review",
        action: parsed.data.action,
        actorLogin: parsed.data.review.user.login,
        eventBody: parsed.data.review.body?.trim() ?? "",
        eventUrl: parsed.data.review.html_url ?? parsed.data.pull_request.html_url ?? "",
        markerBody: parsed.data.pull_request.body ?? null,
      }),
    ];
  },
  pull_request: (input) => {
    const parsed = PullRequestEvent.safeParse(input.payload);
    if (!parsed.success || parsed.data.action !== "closed" || !parsed.data.pull_request.merged)
      return [];
    const repo = resolveRepoCoordinates(parsed.data.repository);
    if (!repo) return [];
    return [
      buildImmediateSignal({
        repo,
        prNumber: parsed.data.pull_request.number,
        eventKind: "pull_request",
        action: parsed.data.action,
        actorLogin: parsed.data.sender?.login ?? "unknown",
        eventBody: "PR merged",
        eventUrl: parsed.data.pull_request.html_url ?? "",
        markerBody: parsed.data.pull_request.body ?? null,
      }),
    ];
  },
  workflow_run: (input) => {
    const parsed = WorkflowRunEvent.safeParse(input.payload);
    if (!parsed.success || parsed.data.action !== "completed") return [];
    const repo = resolveRepoCoordinates(parsed.data.repository);
    if (!repo) return [];
    const prs = parsed.data.workflow_run.pull_requests;
    if (!prs.length) return [];
    return prs.map((pr) => ({
      repo,
      prNumber: pr.number,
      eventKind: "workflow_run",
      action: parsed.data.action,
      actorLogin: "github-actions[bot]",
      eventBody: `Workflow: ${parsed.data.workflow_run.name}\nConclusion: ${parsed.data.workflow_run.conclusion ?? "unknown"}\nHead branch: ${parsed.data.workflow_run.head_branch ?? "unknown"}`,
      eventUrl: parsed.data.workflow_run.html_url ?? "",
      bucketKey: `pr-${pr.number}`,
      immediate: false,
      markerBody: null,
    }));
  },
};

function collectSignals(input: ForwardedWebhookInput): ResolvedPrSignal[] {
  const collect = signalCollectors[input.eventType];
  return collect ? collect(input) : [];
}

function parseAgentPathFromBody(body: string | null | undefined): string | null {
  return normalizeAgentPath(parseContextValue(body, "agent_path"));
}

function parseSessionIdFromBody(body: string | null | undefined): string | null {
  const value = parseContextValue(body, "session_id")?.trim();
  if (!value || !/^ses_[a-zA-Z0-9_-]+$/.test(value)) return null;
  return value;
}

function parseContextValue(body: string | null | undefined, key: "agent_path" | "session_id") {
  if (!body) return null;
  const keyRegex = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "im");
  for (const match of body.matchAll(iterateAgentContextRegex)) {
    const block = match[1] ?? "";
    const lineMatch = block.match(keyRegex);
    if (lineMatch?.[1]) return lineMatch[1];
  }
  return null;
}

function hasAppSlugMarker(body: string | null | undefined): boolean {
  if (!body) return false;
  return slugMarkerRegex.test(body);
}

function hasAppSlugMention(body: string | null | undefined): boolean {
  if (!body) return false;
  return slugMentionRegex.test(body);
}

function getAuthorizationSource(
  signal: ResolvedPrSignal,
  hasStoredMapping: boolean,
): "marker" | "mention" | "mapping" | null {
  if (hasAppSlugMarker(signal.markerBody)) return "marker";
  if (hasAppSlugMention(signal.eventBody)) return "mention";
  if (
    hasStoredMapping &&
    (signal.eventKind === "workflow_run" || signal.eventKind === "pull_request")
  ) {
    return "mapping";
  }
  return null;
}

async function getExistingPrMapping(repo: RepoCoords, prNumber: number): Promise<PrMapping | null> {
  const [existing] = await db
    .select({ agentPath: schema.githubPrAgentPaths.agentPath })
    .from(schema.githubPrAgentPaths)
    .where(
      and(
        eq(schema.githubPrAgentPaths.owner, repo.owner),
        eq(schema.githubPrAgentPaths.repo, repo.name),
        eq(schema.githubPrAgentPaths.prNumber, prNumber),
      ),
    )
    .limit(1);

  return existing ?? null;
}

async function resolveAgentPathFromSessionId(sessionId: string): Promise<string | null> {
  const destination = `/opencode/sessions/${sessionId}`;
  const [route] = await db
    .select()
    .from(schema.agentRoutes)
    .where(eq(schema.agentRoutes.destination, destination))
    .orderBy(desc(schema.agentRoutes.updatedAt))
    .limit(1);

  return route?.agentPath ?? null;
}

async function getSessionIdForAgentPath(agentPath: string): Promise<string | null> {
  const [route] = await db
    .select()
    .from(schema.agentRoutes)
    .where(and(eq(schema.agentRoutes.agentPath, agentPath), eq(schema.agentRoutes.active, true)))
    .limit(1);

  const destination = route?.destination;
  if (!destination) return null;
  const match = destination.match(/^\/opencode\/sessions\/(.+)$/);
  return match?.[1] ?? null;
}

function isValidGitHubPrPathForSignal(params: {
  path: string;
  repo: RepoCoords;
  prNumber: number;
}): boolean {
  if (!params.path.startsWith("/github/")) return true;

  const match = params.path.match(/^\/github\/([^/]+)\/([^/]+)\/pr-(\d+)$/);
  if (!match) return false;

  const [, ownerSegment, repoSegment, prSegment] = match;
  return (
    ownerSegment === toPathSegment(params.repo.owner) &&
    repoSegment === toPathSegment(params.repo.name) &&
    Number.parseInt(prSegment, 10) === params.prNumber
  );
}

async function resolveAgentPath(params: {
  repo: RepoCoords;
  prNumber: number;
  markerBody: string | null;
  existingMapping: PrMapping | null;
}): Promise<AgentPathResolution> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PR_MAPPING_TTL_MS);
  const defaultPath = buildDefaultGitHubPrAgentPath(params.repo, params.prNumber);
  const markerSessionId = parseSessionIdFromBody(params.markerBody);
  const sessionPath = markerSessionId ? await resolveAgentPathFromSessionId(markerSessionId) : null;
  const parsedMarkerPath = parseAgentPathFromBody(params.markerBody);
  const markerPath =
    parsedMarkerPath &&
    isValidGitHubPrPathForSignal({
      path: parsedMarkerPath,
      repo: params.repo,
      prNumber: params.prNumber,
    })
      ? parsedMarkerPath
      : null;

  let nextPath = sessionPath ?? markerPath ?? params.existingMapping?.agentPath ?? defaultPath;
  let source: AgentPathResolution["source"] = sessionPath
    ? "session"
    : markerPath
      ? "marker"
      : params.existingMapping?.agentPath
        ? "mapping"
        : "default";

  // If marker session_id is present but unresolved, keep routing continuity by
  // preferring explicit marker path, then persisted mapping, then default.
  if (markerSessionId && !sessionPath) {
    logger.warn(
      `[daemon/github] Marker session_id unresolved; using fallback routing sessionId=${markerSessionId} repo=${params.repo.fullName} pr=${params.prNumber}`,
    );
    if (markerPath) {
      nextPath = markerPath;
      source = "marker";
    } else if (params.existingMapping?.agentPath) {
      nextPath = params.existingMapping.agentPath;
      source = "mapping";
    } else {
      nextPath = defaultPath;
      source = "session-unresolved";
    }
  }

  if (!(await isSafeResolvedPath(nextPath, now))) {
    logger.warn(
      `[daemon/github] Resolved path unsafe; fallback to deterministic path=${nextPath} repo=${params.repo.fullName} pr=${params.prNumber}`,
    );
    nextPath = defaultPath;
    source = "unsafe-fallback";
  }

  const persistedMapping = {
    agentPath: nextPath,
    source,
    updatedAt: now,
    expiresAt,
  };

  await db
    .insert(schema.githubPrAgentPaths)
    .values({
      owner: params.repo.owner,
      repo: params.repo.name,
      prNumber: params.prNumber,
      ...persistedMapping,
    })
    .onConflictDoUpdate({
      target: [
        schema.githubPrAgentPaths.owner,
        schema.githubPrAgentPaths.repo,
        schema.githubPrAgentPaths.prNumber,
      ],
      set: persistedMapping,
    });

  return { agentPath: nextPath, source };
}

async function isSafeResolvedPath(path: string, now: Date): Promise<boolean> {
  if (path.startsWith("/github/")) return true;

  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.path, path))
    .limit(1);

  if (!agent || agent.archivedAt) return false;
  if (!agent.updatedAt) return false;
  return now.getTime() - agent.updatedAt.getTime() <= NON_GITHUB_PATH_MAX_AGE_MS;
}

function hashSignal(signal: ResolvedPrSignal, deliveryId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        deliveryId,
        pr: signal.prNumber,
        eventKind: signal.eventKind,
        action: signal.action,
        actor: signal.actorLogin,
        body: signal.eventBody,
      }),
    )
    .digest("hex");
}

async function upsertWebhookState(params: {
  agentPath: string;
  eventHash: string;
}): Promise<{ includeInstructions: boolean; duplicate: boolean }> {
  const nowMs = Date.now();
  const existing = webhookStateByAgentPath.get(params.agentPath);

  const duplicate =
    existing?.lastEventHash === params.eventHash &&
    existing.lastEventAtMs !== null &&
    nowMs - existing.lastEventAtMs < DEBOUNCE_MS;

  if (duplicate) {
    webhookStateByAgentPath.set(params.agentPath, {
      instructionsSentAtMs: existing?.instructionsSentAtMs ?? null,
      lastEventHash: existing?.lastEventHash ?? null,
      lastEventAtMs: existing?.lastEventAtMs ?? null,
      lastSeenAtMs: nowMs,
    });
    return { includeInstructions: false, duplicate: true };
  }

  const includeInstructions =
    !existing?.instructionsSentAtMs || nowMs - existing.instructionsSentAtMs > INSTRUCTIONS_TTL_MS;

  webhookStateByAgentPath.set(params.agentPath, {
    instructionsSentAtMs: includeInstructions ? nowMs : (existing?.instructionsSentAtMs ?? null),
    lastEventHash: params.eventHash,
    lastEventAtMs: nowMs,
    lastSeenAtMs: nowMs,
  });

  return { includeInstructions, duplicate };
}

async function buildPrompt(params: {
  signal: ResolvedPrSignal;
  agentPath: string;
  includeInstructions: boolean;
}): Promise<string> {
  const { signal, agentPath, includeInstructions } = params;
  const summary = `[github] ${signal.repo.fullName}#${signal.prNumber} ${signal.eventKind}/${signal.action} by ${signal.actorLogin}${signal.eventUrl ? ` ${signal.eventUrl}` : ""}`;
  const body = compactText(signal.eventBody, 600);
  if (!includeInstructions) {
    return body ? `${summary}\n\n${body}` : summary;
  }

  const sessionId = await getSessionIdForAgentPath(agentPath);
  const routingHint = [
    `routing: marker=<!-- ${AppSlug}:agent-pr -->`,
    `session_id=${sessionId ?? "<current-session-id>"}`,
    `agent_path=${agentPath}`,
    `mention=@${AppSlug}`,
  ].join(" | ");

  return [summary, body, routingHint].filter(Boolean).join("\n\n");
}

function compactText(value: string | null | undefined, maxLength: number): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 3) return normalized.slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 3)}...`;
}

async function postPromptToAgent(agentPath: string, prompt: string): Promise<void> {
  const response = await fetch(`${AGENT_ROUTER_BASE_URL}${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: [{ type: "iterate:agent:prompt-added", message: prompt }] }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`Agent forward failed (${response.status}): ${body.slice(0, 500)}`);
  }
}

async function enqueueBufferedSignal(params: {
  agentPath: string;
  bucketKey: string;
  eventKind: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const buffered = bufferedSignalsByAgentPath.get(params.agentPath) ?? [];
  buffered.push({
    bucketKey: params.bucketKey,
    eventKind: params.eventKind,
    payload: params.payload,
    createdAtMs: Date.now(),
  });
  bufferedSignalsByAgentPath.set(params.agentPath, buffered);
}

async function flushBufferedSignalsForAgent(agentPath: string): Promise<void> {
  const rows = bufferedSignalsByAgentPath.get(agentPath) ?? [];
  if (!rows.length) return;

  const rowsToFlush = [...rows];
  try {
    const flushedRows = await flushBufferedRows(agentPath, rowsToFlush);
    removeFlushedRows(agentPath, flushedRows);
  } catch (error) {
    if (error instanceof BufferedFlushPartialError) {
      removeFlushedRows(agentPath, error.flushedRows);
    }
    scheduleFlush(agentPath);
    throw error;
  }
}

function removeFlushedRows(agentPath: string, flushedRows: ReadonlySet<BufferedSignal>): void {
  if (flushedRows.size === 0) return;
  const currentRows = bufferedSignalsByAgentPath.get(agentPath) ?? [];
  const kept = currentRows.filter((row) => !flushedRows.has(row));
  if (kept.length === 0) {
    bufferedSignalsByAgentPath.delete(agentPath);
    return;
  }
  bufferedSignalsByAgentPath.set(agentPath, kept);
}

async function flushBufferedRows(
  agentPath: string,
  rows: BufferedSignal[],
): Promise<ReadonlySet<BufferedSignal>> {
  const byBucket = new Map<string, BufferedSignal[]>();
  const flushedRows = new Set<BufferedSignal>();
  for (const row of rows) {
    byBucket.set(row.bucketKey, [...(byBucket.get(row.bucketKey) ?? []), row]);
  }

  for (const [bucketKey, bucketRows] of byBucket) {
    const includeInstructions = await markSeenAndCheckInstructions(agentPath);
    const events = bucketRows
      .map((row) => {
        const payload = row.payload as {
          eventKind?: string;
          action?: string;
          actor?: string;
          body?: string;
          eventUrl?: string;
        };
        return `- ${payload.eventKind ?? "event"}/${payload.action ?? "unknown"} by ${payload.actor ?? "unknown"}${payload.eventUrl ? ` (${payload.eventUrl})` : ""}`;
      })
      .join("\n");

    const prompt = [
      `[GitHub PR Event Batch] ${bucketKey}`,
      `${bucketRows.length} events in last ${Math.round(DEBOUNCE_MS / 1000)}s.`,
      events,
      includeInstructions
        ? "\nGuidance: handle the latest CI signal first, then only revisit older failures if still relevant."
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await postPromptToAgent(agentPath, prompt);
    } catch (error) {
      throw new BufferedFlushPartialError("Buffered flush partially succeeded", flushedRows, {
        cause: error,
      });
    }
    for (const row of bucketRows) flushedRows.add(row);
    logger.debug("[daemon/github] Flushed buffered webhook batch", {
      agentPath,
      bucketKey,
      eventCount: bucketRows.length,
    });
  }

  return flushedRows;
}

async function markSeenAndCheckInstructions(agentPath: string): Promise<boolean> {
  const nowMs = Date.now();
  const existing = webhookStateByAgentPath.get(agentPath);
  const includeInstructions =
    !existing?.instructionsSentAtMs || nowMs - existing.instructionsSentAtMs > INSTRUCTIONS_TTL_MS;

  webhookStateByAgentPath.set(agentPath, {
    instructionsSentAtMs: includeInstructions ? nowMs : (existing?.instructionsSentAtMs ?? null),
    lastEventHash: existing?.lastEventHash ?? null,
    lastEventAtMs: existing?.lastEventAtMs ?? null,
    lastSeenAtMs: nowMs,
  });

  return includeInstructions;
}

async function pruneExpiredState(): Promise<void> {
  const now = Date.now();
  await db
    .delete(schema.githubPrAgentPaths)
    .where(lt(schema.githubPrAgentPaths.updatedAt, new Date(now - PR_MAPPING_TTL_MS)));

  for (const [agentPath, state] of webhookStateByAgentPath) {
    if (now - state.lastSeenAtMs > STATE_TTL_MS) {
      webhookStateByAgentPath.delete(agentPath);
    }
  }

  for (const [agentPath, rows] of bufferedSignalsByAgentPath) {
    const kept = rows.filter((row) => now - row.createdAtMs <= BUFFER_TTL_MS);
    if (kept.length > 0) {
      bufferedSignalsByAgentPath.set(agentPath, kept);
    } else {
      bufferedSignalsByAgentPath.delete(agentPath);
    }
  }
}
