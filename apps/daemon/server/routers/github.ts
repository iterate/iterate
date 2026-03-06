import { createHash } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod/v4";
import {
  buildDefaultGitHubPrAgentPath,
  buildDefaultGitHubSecurityAgentPath,
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

const SecretScanningAlertEvent = z.object({
  action: z.string(),
  alert: z.object({
    number: z.number(),
    secret_type: z.string().optional(),
    secret_type_display_name: z.string().optional(),
    state: z.string().optional(),
    resolution: z.string().nullable().optional(),
    html_url: z.string().optional(),
    created_at: z.string().optional(),
    push_protection_bypassed: z.boolean().nullable().optional(),
  }),
  repository: RepositoryPayload,
  sender: z.object({ login: z.string() }).optional(),
});

const SecretScanningAlertLocationEvent = z.object({
  action: z.string(),
  alert: z.object({
    number: z.number(),
    secret_type: z.string().optional(),
    secret_type_display_name: z.string().optional(),
    html_url: z.string().optional(),
  }),
  location: z.object({
    type: z.string().optional(),
    details: z
      .object({
        path: z.string().optional(),
        start_line: z.number().optional(),
        end_line: z.number().optional(),
        start_column: z.number().optional(),
        end_column: z.number().optional(),
        blob_sha: z.string().optional(),
        commit_sha: z.string().optional(),
      })
      .optional(),
  }),
  repository: RepositoryPayload,
  sender: z.object({ login: z.string() }).optional(),
});

const SecurityAdvisoryEvent = z.object({
  action: z.string(),
  security_advisory: z.object({
    ghsa_id: z.string(),
    summary: z.string().optional(),
    description: z.string().optional(),
    severity: z.string().optional(),
    cve_id: z.string().nullable().optional(),
    html_url: z.string().optional(),
    vulnerabilities: z
      .array(
        z.object({
          package: z
            .object({ ecosystem: z.string().optional(), name: z.string().optional() })
            .optional(),
          severity: z.string().optional(),
          vulnerable_version_range: z.string().optional(),
          first_patched_version: z
            .object({ identifier: z.string().optional() })
            .nullable()
            .optional(),
        }),
      )
      .optional()
      .default([]),
  }),
  repository: RepositoryPayload.optional(),
  sender: z.object({ login: z.string() }).optional(),
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

type ResolvedSecuritySignal = {
  repo: RepoCoords;
  alertNumber: number;
  alertType: "secret_scanning" | "secret_scanning_location" | "security_advisory";
  eventKind: string;
  action: string;
  actorLogin: string;
  eventBody: string;
  eventUrl: string;
  agentPath: string;
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

    // Try PR signals first, then security signals
    const prSignals = collectSignals(input);
    const securitySignals = collectSecuritySignals(input);

    if (prSignals.length === 0 && securitySignals.length === 0) {
      logger.debug("[daemon/github] Ignored webhook: no routable signals", {
        eventType: input.eventType,
        deliveryId: input.deliveryId,
      });
      return c.json({ success: true, handled: false, reason: "ignored" });
    }

    // Process PR signals (existing logic)
    for (const signal of prSignals) {
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
      const { duplicate } = await upsertWebhookState({
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
        const prompt = await buildPrompt({ signal });
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

    // Process security signals — no PR mapping / auth checks needed;
    // these are trusted events from GitHub about repo security state.
    for (const signal of securitySignals) {
      const eventHash = hashSecuritySignal(signal, input.deliveryId);
      const { duplicate } = await upsertWebhookState({
        agentPath: signal.agentPath,
        eventHash,
      });

      if (duplicate) {
        logger.debug("[daemon/github] Duplicate security signal skipped", {
          deliveryId: input.deliveryId,
          eventKind: signal.eventKind,
          alertNumber: signal.alertNumber,
          agentPath: signal.agentPath,
        });
        continue;
      }

      logger.info("[daemon/github] Routed security signal", {
        deliveryId: input.deliveryId,
        eventKind: signal.eventKind,
        action: signal.action,
        alertNumber: signal.alertNumber,
        repo: signal.repo.fullName,
        agentPath: signal.agentPath,
      });

      const prompt = buildSecurityPrompt(signal);
      await postPromptToAgent(signal.agentPath, prompt);

      logger.info("[daemon/github] Forwarded security signal to agent", {
        deliveryId: input.deliveryId,
        eventKind: signal.eventKind,
        alertNumber: signal.alertNumber,
        agentPath: signal.agentPath,
      });
    }

    const totalCount = prSignals.length + securitySignals.length;
    return c.json({ success: true, handled: true, count: totalCount });
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

// ── Security signal collectors ──────────────────────────────────────

const securitySignalCollectors: Record<
  string,
  (input: ForwardedWebhookInput) => ResolvedSecuritySignal[]
> = {
  secret_scanning_alert: (input) => {
    const parsed = SecretScanningAlertEvent.safeParse(input.payload);
    if (!parsed.success) return [];
    // Handle created, reopened — ignore resolved/revoked (those are resolutions)
    if (parsed.data.action !== "created" && parsed.data.action !== "reopened") return [];
    const repo = resolveRepoCoordinates(parsed.data.repository);
    if (!repo) return [];
    const alert = parsed.data.alert;
    const body = [
      `Secret type: ${alert.secret_type_display_name ?? alert.secret_type ?? "unknown"}`,
      `State: ${alert.state ?? "unknown"}`,
      alert.push_protection_bypassed ? "Push protection was BYPASSED" : null,
      alert.resolution ? `Resolution: ${alert.resolution}` : null,
      alert.created_at ? `Created: ${alert.created_at}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return [
      {
        repo,
        alertNumber: alert.number,
        alertType: "secret_scanning",
        eventKind: "secret_scanning_alert",
        action: parsed.data.action,
        actorLogin: parsed.data.sender?.login ?? "github",
        eventBody: body,
        eventUrl: alert.html_url ?? "",
        agentPath: buildDefaultGitHubSecurityAgentPath(repo, "secret-scanning", alert.number),
      },
    ];
  },

  secret_scanning_alert_location: (input) => {
    const parsed = SecretScanningAlertLocationEvent.safeParse(input.payload);
    if (!parsed.success) return [];
    const repo = resolveRepoCoordinates(parsed.data.repository);
    if (!repo) return [];
    const alert = parsed.data.alert;
    const loc = parsed.data.location;
    const details = loc.details;
    const body = [
      `Secret type: ${alert.secret_type_display_name ?? alert.secret_type ?? "unknown"}`,
      `Location type: ${loc.type ?? "unknown"}`,
      details?.path ? `File: ${details.path}` : null,
      details?.start_line
        ? `Lines: ${details.start_line}-${details.end_line ?? details.start_line}`
        : null,
      details?.commit_sha ? `Commit: ${details.commit_sha}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    // Route to the same agent as the parent alert
    return [
      {
        repo,
        alertNumber: alert.number,
        alertType: "secret_scanning_location",
        eventKind: "secret_scanning_alert_location",
        action: parsed.data.action,
        actorLogin: parsed.data.sender?.login ?? "github",
        eventBody: body,
        eventUrl: alert.html_url ?? "",
        agentPath: buildDefaultGitHubSecurityAgentPath(repo, "secret-scanning", alert.number),
      },
    ];
  },

  security_advisory: (input) => {
    const parsed = SecurityAdvisoryEvent.safeParse(input.payload);
    if (!parsed.success) return [];
    if (parsed.data.action !== "published" && parsed.data.action !== "updated") return [];
    const repo = parsed.data.repository ? resolveRepoCoordinates(parsed.data.repository) : null;
    if (!repo) return [];
    const advisory = parsed.data.security_advisory;
    const vulnLines = advisory.vulnerabilities.map((v) => {
      const pkg = v.package;
      const patched = v.first_patched_version?.identifier;
      return `- ${pkg?.ecosystem ?? "?"}/${pkg?.name ?? "?"} ${v.vulnerable_version_range ?? ""} (severity: ${v.severity ?? "unknown"})${patched ? ` → fix: ${patched}` : ""}`;
    });
    const body = [
      `GHSA: ${advisory.ghsa_id}`,
      advisory.cve_id ? `CVE: ${advisory.cve_id}` : null,
      `Severity: ${advisory.severity ?? "unknown"}`,
      advisory.summary ? `Summary: ${advisory.summary}` : null,
      vulnLines.length > 0 ? `\nAffected packages:\n${vulnLines.join("\n")}` : null,
      advisory.description ? `\nDescription: ${compactText(advisory.description, 500)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    // Use GHSA ID numeric suffix as the alert number for dedup/path.
    // Fallback: deterministic hash of the full GHSA ID (some IDs have no digits).
    const ghsaNum = advisory.ghsa_id.replace(/\D/g, "").slice(-6);
    const parsedNum = Number.parseInt(ghsaNum, 10);
    const alertNumber = Number.isNaN(parsedNum)
      ? parseInt(createHash("sha256").update(advisory.ghsa_id).digest("hex").slice(0, 6), 16) %
          1_000_000
      : parsedNum;

    return [
      {
        repo,
        alertNumber,
        alertType: "security_advisory",
        eventKind: "security_advisory",
        action: parsed.data.action,
        actorLogin: parsed.data.sender?.login ?? "github",
        eventBody: body,
        eventUrl: advisory.html_url ?? "",
        agentPath: buildDefaultGitHubSecurityAgentPath(repo, "advisory", alertNumber),
      },
    ];
  },
};

function collectSecuritySignals(input: ForwardedWebhookInput): ResolvedSecuritySignal[] {
  const collect = securitySignalCollectors[input.eventType];
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
    (signal.eventKind === "workflow_run" ||
      signal.eventKind === "pull_request" ||
      signal.eventKind === "issue_comment" ||
      signal.eventKind === "pull_request_review_comment")
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

function hashSecuritySignal(signal: ResolvedSecuritySignal, deliveryId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        deliveryId,
        alertNumber: signal.alertNumber,
        alertType: signal.alertType,
        eventKind: signal.eventKind,
        action: signal.action,
      }),
    )
    .digest("hex");
}

async function upsertWebhookState(params: {
  agentPath: string;
  eventHash: string;
}): Promise<{ duplicate: boolean }> {
  const nowMs = Date.now();
  const existing = webhookStateByAgentPath.get(params.agentPath);

  const duplicate =
    existing?.lastEventHash === params.eventHash &&
    existing.lastEventAtMs !== null &&
    nowMs - existing.lastEventAtMs < DEBOUNCE_MS;

  if (duplicate) {
    webhookStateByAgentPath.set(params.agentPath, {
      lastEventHash: existing?.lastEventHash ?? null,
      lastEventAtMs: existing?.lastEventAtMs ?? null,
      lastSeenAtMs: nowMs,
    });
    return { duplicate: true };
  }

  webhookStateByAgentPath.set(params.agentPath, {
    lastEventHash: params.eventHash,
    lastEventAtMs: nowMs,
    lastSeenAtMs: nowMs,
  });

  return { duplicate };
}

async function buildPrompt(params: { signal: ResolvedPrSignal }): Promise<string> {
  const { signal } = params;
  const summary = `[github] ${signal.repo.fullName}#${signal.prNumber} ${signal.eventKind}/${signal.action} by ${signal.actorLogin}${signal.eventUrl ? ` ${signal.eventUrl}` : ""}`;
  const body = compactText(signal.eventBody, 600);
  return body ? `${summary}\n\n${body}` : summary;
}

function buildSecurityPrompt(signal: ResolvedSecuritySignal): string {
  const lines = [
    "[GitHub Security Alert]",
    `Repo: ${signal.repo.fullName}`,
    `Alert type: ${signal.eventKind}`,
    `Action: ${signal.action}`,
    `Alert #${signal.alertNumber}`,
    signal.eventUrl ? `URL: ${signal.eventUrl}` : null,
    "",
    signal.eventBody,
    "",
    "## Instructions",
    "",
    "You are a security triage agent. Follow these steps:",
    "",
    "### 1. Triage",
    "- Investigate the alert. Check if it is a false positive.",
    "- Determine if the secret/vulnerability is only used in development/test or if it is in production.",
    "- Check git history to see if the secret was already rotated or the dependency already updated.",
    "",
    "### 2. Remediate (if possible)",
    "- For secret scanning alerts: check if the secret is hardcoded. If so, remove it and open a PR.",
    "- For dependency vulnerabilities: check if there is a patched version. If so, bump the dependency and open a PR.",
    "- For any fix, create a branch and PR with a clear description of what was found and what was fixed.",
    "",
    "### 3. Notify the team",
    "- If this is a real alert (not a false positive), start a new thread in the #security-alerts Slack channel (C09K1CTN4M7).",
    "- Use `@channel` if the alert is urgent (e.g., production secret leaked, critical severity CVE).",
    "- Use `@here` if the alert is not time-sensitive (e.g., low/medium severity, development-only).",
    "- Subscribe to the thread using `iterate tool subscribe-slack-thread` so you can answer follow-up questions.",
    "- Include: what the alert is, your triage assessment, what actions you took, and any remaining items for humans.",
    "",
    "### 4. If unsure",
    "- If you cannot determine whether the alert is real or a false positive, post in #security-alerts asking for human input.",
    "- Provide all relevant context so the team can make a decision quickly.",
  ]
    .filter((l) => l !== null)
    .join("\n");
  return lines;
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

  if (response.ok) return;

  // If the agent's upstream session is dead/unreachable (502/503/504 or session-not-found 404/500),
  // archive the stale agent + route so the next attempt creates a fresh session.
  const isDeadSession = response.status >= 500 || response.status === 404;
  if (isDeadSession) {
    logger.warn(
      `[daemon/github] Agent forward failed (${response.status}) for ${agentPath}; clearing stale route for retry`,
    );
    await clearStaleAgentRoute(agentPath);

    // Retry once — getOrCreateAgent will create a fresh session
    const retryResponse = await fetch(`${AGENT_ROUTER_BASE_URL}${agentPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "iterate:agent:prompt-added", message: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (retryResponse.ok) {
      logger.info(`[daemon/github] Retry succeeded for ${agentPath} after clearing stale route`);
      return;
    }

    const retryBody = await retryResponse.text().catch(() => "<no body>");
    throw new Error(
      `Agent forward retry failed (${retryResponse.status}) for ${agentPath}: ${retryBody.slice(0, 500)}`,
    );
  }

  const body = await response.text().catch(() => "<no body>");
  throw new Error(`Agent forward failed (${response.status}): ${body.slice(0, 500)}`);
}

/**
 * Clear a stale agent route so the next getOrCreateAgent call creates a fresh session.
 * Archives the agent and deactivates its route.
 */
async function clearStaleAgentRoute(agentPath: string): Promise<void> {
  try {
    // Deactivate the route so getOrCreateAgent creates a new one
    db.update(schema.agentRoutes)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(schema.agentRoutes.agentPath, agentPath), eq(schema.agentRoutes.active, true)))
      .run();

    // Archive the agent so it gets re-created
    db.update(schema.agents)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.agents.path, agentPath))
      .run();

    logger.info(`[daemon/github] Cleared stale agent route for ${agentPath}`);
  } catch (err) {
    logger.error("[daemon/github] Failed to clear stale agent route", {
      agentPath,
      error: err instanceof Error ? err.message : String(err),
    });
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

    const prompt = [`[github-batch] ${bucketKey}`, events].filter(Boolean).join("\n");

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
