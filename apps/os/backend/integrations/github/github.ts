import { timingSafeEqual } from "node:crypto";
import jsonata from "jsonata";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import * as arctic from "arctic";
import * as jose from "jose";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { CloudflareEnv } from "../../../env.ts";
import { waitUntil } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { encrypt } from "../../utils/encryption.ts";
import { stripMachineStateMetadata } from "../../utils/machine-metadata.ts";
import { createMachineForProject } from "../../services/machine-creation.ts";
import { trackWebhookEvent } from "../../lib/posthog.ts";
import type { ProjectSandboxProvider } from "../../utils/sandbox-providers.ts";
import { pokeRunningMachinesToRefresh } from "../../utils/poke-machines.ts";

/**
 * Derive the correct provider-specific snapshot/image name from a short SHA.
 *
 * Naming conventions (must match CI build outputs):
 *   Daytona: iterate-sandbox-sha-{shortSha}
 *   Fly:     registry.fly.io/{app}:sha-{shortSha}  (prefix extracted from FLY_DEFAULT_IMAGE)
 *   Docker:  registry.depot.dev/{id}:sha-{shortSha} (prefix extracted from DOCKER_DEFAULT_IMAGE)
 *
 * Returns undefined when the provider's default image env var is missing
 * (can't derive the registry prefix).
 */
function snapshotNameForProvider(
  provider: ProjectSandboxProvider,
  shortSha: string,
  env: CloudflareEnv,
): string | undefined {
  switch (provider) {
    case "daytona":
      return `iterate-sandbox-sha-${shortSha}`;
    case "fly": {
      // FLY_DEFAULT_IMAGE = "registry.fly.io/<app>:sha-<sha>"
      const flyDefault = env.FLY_DEFAULT_IMAGE;
      if (!flyDefault) return undefined;
      const colonIdx = flyDefault.lastIndexOf(":");
      if (colonIdx === -1) return undefined;
      return `${flyDefault.slice(0, colonIdx)}:sha-${shortSha}`;
    }
    case "docker": {
      // DOCKER_DEFAULT_IMAGE = "registry.depot.dev/<id>:sha-<sha>"
      const dockerDefault = env.DOCKER_DEFAULT_IMAGE;
      if (!dockerDefault) return undefined;
      const colonIdx = dockerDefault.lastIndexOf(":");
      if (colonIdx === -1) return undefined;
      return `${dockerDefault.slice(0, colonIdx)}:sha-${shortSha}`;
    }
    default:
      return undefined;
  }
}

export type GitHubOAuthStateData = {
  projectId: string;
  userId: string;
  redirectUri: string;
  callbackURL?: string;
};

export function createGitHubClient(env: CloudflareEnv) {
  const redirectURI = `${env.VITE_PUBLIC_URL}/api/integrations/github/callback`;
  return new arctic.GitHub(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_CLIENT_SECRET, redirectURI);
}

export const githubApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

githubApp.get(
  "/callback",
  zValidator(
    "query",
    z.object({
      state: z.string().optional(),
      code: z.string(),
      installation_id: z.string().transform((val) => parseInt(val)),
    }),
  ),
  async (c) => {
    if (!c.var.session) return c.json({ error: "Unauthorized" }, 401);

    const { state, code, installation_id } = c.req.valid("query");

    if (!state) {
      logger.warn("GitHub callback received without state - user may have clicked save directly");
      return c.redirect("/");
    }

    const verification = await c.var.db.query.verification.findFirst({
      where: eq(schema.verification.identifier, state),
    });

    await c.var.db.delete(schema.verification).where(eq(schema.verification.identifier, state));

    if (!verification || verification.expiresAt < new Date()) {
      return c.json({ error: "Invalid state or state has expired" }, 400);
    }

    const stateData = z
      .object({
        projectId: z.string(),
        userId: z.string(),
        redirectUri: z.string(),
        callbackURL: z.string().optional(),
      })
      .parse(JSON.parse(verification.value));

    const { projectId, userId, callbackURL } = stateData;

    if (c.var.session.user.id !== userId) {
      logger.warn("GitHub callback user mismatch", {
        sessionUserId: c.var.session.user.id,
        stateUserId: userId,
      });
      return c.json({ error: "User mismatch - please restart the GitHub connection flow" }, 403);
    }

    const github = createGitHubClient(c.env);

    let tokens: arctic.OAuth2Tokens;
    try {
      tokens = await github.validateAuthorizationCode(code);
    } catch (error) {
      logger.error("Failed to validate GitHub authorization code", error);
      return c.json({ error: "Failed to validate authorization code" }, 400);
    }

    const accessToken = tokens.accessToken();

    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Iterate-OS",
      },
    });

    if (!userResponse.ok) {
      logger.error("Failed to fetch GitHub user info", await userResponse.text());
      return c.json({ error: "Failed to get user info" }, 400);
    }

    const userInfo = (await userResponse.json()) as { id: number; login: string };

    const installationReposResponse = await fetch(
      `https://api.github.com/user/installations/${installation_id}/repositories`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Iterate-OS",
        },
      },
    );

    if (!installationReposResponse.ok) {
      logger.error(
        "Failed to fetch installation repositories",
        await installationReposResponse.text(),
      );
      return c.json({ error: "Failed to get installation repositories" }, 400);
    }

    type GitHubRepo = {
      id: number;
      name: string;
      full_name: string;
      owner: { login: string };
      default_branch: string;
    };

    const installationRepos = (await installationReposResponse.json()) as {
      repositories: GitHubRepo[];
    };

    const encryptedAccessToken = await encrypt(accessToken);

    const project = await c.var.db.transaction(async (tx) => {
      const existingConnection = await tx.query.projectConnection.findFirst({
        where: (pc, { eq, and }) => and(eq(pc.projectId, projectId), eq(pc.provider, "github-app")),
      });

      if (existingConnection) {
        await tx
          .update(schema.projectConnection)
          .set({
            externalId: installation_id.toString(),
            providerData: {
              installationId: installation_id,
              githubUserId: userInfo.id,
              githubLogin: userInfo.login,
              encryptedAccessToken,
            },
          })
          .where(eq(schema.projectConnection.id, existingConnection.id));
      } else {
        await tx.insert(schema.projectConnection).values({
          projectId,
          provider: "github-app",
          externalId: installation_id.toString(),
          scope: "project",
          userId,
          providerData: {
            installationId: installation_id,
            githubUserId: userInfo.id,
            githubLogin: userInfo.login,
            encryptedAccessToken,
          },
        });
      }

      if (installationRepos.repositories.length === 1) {
        const repo = installationRepos.repositories[0];
        const existingRepo = await tx.query.projectRepo.findFirst({
          where: eq(schema.projectRepo.projectId, projectId),
        });

        if (existingRepo) {
          await tx
            .update(schema.projectRepo)
            .set({
              provider: "github",
              externalId: repo.id.toString(),
              owner: repo.owner.login,
              name: repo.name,
              defaultBranch: repo.default_branch,
            })
            .where(eq(schema.projectRepo.id, existingRepo.id));
        } else {
          await tx.insert(schema.projectRepo).values({
            projectId,
            provider: "github",
            externalId: repo.id.toString(),
            owner: repo.owner.login,
            name: repo.name,
            defaultBranch: repo.default_branch,
          });
        }
      }

      // Upsert secret for egress proxy to use (project-scoped for sandbox git operations)
      // This allows the magic string `getIterateSecret({secretKey: "github.access_token"})` to resolve
      // We store the installation token (not user token) because git operations need app-level access
      const projectInfo = await tx.query.project.findFirst({
        where: eq(schema.project.id, projectId),
      });

      if (projectInfo) {
        // Get a fresh installation token - this is what git operations need
        const installationToken = await getGitHubInstallationToken(c.env, installation_id);
        if (!installationToken) {
          logger.error("Failed to get GitHub installation token", {
            installationId: installation_id,
          });
          // Fall back to user token (may not work for private repos)
        }

        const tokenToStore = installationToken || accessToken;
        const encryptedToken = await encrypt(tokenToStore);

        // Only store installationId in metadata if we have an installation token
        // If we fell back to user token, don't store installationId (would cause refresh failures)
        const secretMetadata = installationToken ? { githubInstallationId: installation_id } : {};

        const existingSecret = await tx.query.secret.findFirst({
          where: (s, { and: whereAnd, eq: whereEq, isNull: whereIsNull }) =>
            whereAnd(
              whereEq(s.key, "github.access_token"),
              whereEq(s.projectId, projectId),
              whereIsNull(s.userId), // Only match project-scoped secrets, not user-scoped
            ),
        });

        const githubEgressRule = `$contains(url.hostname, 'github.com') or $contains(url.hostname, 'githubcopilot.com')`;

        if (existingSecret) {
          await tx
            .update(schema.secret)
            .set({
              encryptedValue: encryptedToken,
              lastSuccessAt: new Date(),
              metadata: secretMetadata,
              egressProxyRule: githubEgressRule,
            })
            .where(eq(schema.secret.id, existingSecret.id));
        } else {
          await tx.insert(schema.secret).values({
            key: "github.access_token",
            encryptedValue: encryptedToken,
            organizationId: projectInfo.organizationId,
            projectId,
            metadata: secretMetadata,
            egressProxyRule: githubEgressRule,
          });
        }
      }

      return tx.query.project.findFirst({
        where: eq(schema.project.id, projectId),
        with: {
          organization: true,
        },
      });
    });

    // Refresh env on running machines so new GitHub tokens are available immediately.
    waitUntil(
      pokeRunningMachinesToRefresh(c.var.db, projectId, c.env).catch((err) => {
        logger.error("[GitHub OAuth] Failed to poke machines for refresh", err);
      }),
    );

    const redirectPath = callbackURL || (project ? `/proj/${project.slug}/connectors` : "/");
    return c.redirect(redirectPath);
  },
);

async function generateGitHubAppJWT(env: CloudflareEnv): Promise<string> {
  const { createPrivateKey } = await import("node:crypto");

  const keyString = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  const privateKey = createPrivateKey({
    key: keyString,
    format: "pem",
  }).export({
    type: "pkcs8",
    format: "pem",
  }) as string;

  const key = await jose.importPKCS8(privateKey, "RS256");

  const jwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(env.GITHUB_APP_ID)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);

  return jwt;
}

export async function deleteGitHubInstallation(
  env: CloudflareEnv,
  installationId: number,
): Promise<boolean> {
  try {
    const jwt = await generateGitHubAppJWT(env);

    const response = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Iterate-OS",
      },
    });

    if (response.status === 204) {
      return true;
    }

    logger.error(
      `Failed to delete GitHub installation ${installationId}: ${response.status} ${await response.text()}`,
    );
    return false;
  } catch (error) {
    logger.error(`Error deleting GitHub installation ${installationId}:`, error);
    return false;
  }
}

export async function getGitHubInstallationToken(
  env: CloudflareEnv,
  installationId: number,
): Promise<string | null> {
  const result = await getGitHubInstallationTokenWithDiagnostics(env, installationId);
  return result.token;
}

export type GitHubInstallationTokenDiagnostics = {
  jwtMs: number;
  fetchMs: number;
  parseMs: number;
  totalMs: number;
};

export type GitHubInstallationTokenResult = {
  token: string | null;
  status: number | null;
  request: {
    url: string;
    method: "POST";
    installationId: number;
  };
  diagnostics: GitHubInstallationTokenDiagnostics;
  responseHeaders: {
    xGitHubRequestId: string | null;
    xRateLimitLimit: string | null;
    xRateLimitRemaining: string | null;
    xRateLimitReset: string | null;
  };
  error: string | null;
};

export async function getGitHubInstallationTokenWithDiagnostics(
  env: CloudflareEnv,
  installationId: number,
): Promise<GitHubInstallationTokenResult> {
  const startedAt = nowMs();
  const diagnostics: GitHubInstallationTokenDiagnostics = {
    jwtMs: 0,
    fetchMs: 0,
    parseMs: 0,
    totalMs: 0,
  };

  const emptyHeaders = {
    xGitHubRequestId: null,
    xRateLimitLimit: null,
    xRateLimitRemaining: null,
    xRateLimitReset: null,
  };

  const request = {
    url: `https://api.github.com/app/installations/${installationId}/access_tokens`,
    method: "POST" as const,
    installationId,
  };

  try {
    const jwtStartedAt = nowMs();
    const jwt = await generateGitHubAppJWT(env);
    diagnostics.jwtMs = Math.round(nowMs() - jwtStartedAt);

    const fetchStartedAt = nowMs();
    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Iterate-OS",
      },
    });
    diagnostics.fetchMs = Math.round(nowMs() - fetchStartedAt);

    const responseHeaders = {
      xGitHubRequestId: response.headers.get("x-github-request-id"),
      xRateLimitLimit: response.headers.get("x-ratelimit-limit"),
      xRateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
      xRateLimitReset: response.headers.get("x-ratelimit-reset"),
    };

    if (!response.ok) {
      const parseStartedAt = nowMs();
      const errorBody = await response.text();
      diagnostics.parseMs = Math.round(nowMs() - parseStartedAt);
      diagnostics.totalMs = Math.round(nowMs() - startedAt);

      logger.error(
        `Failed to get installation token for ${installationId}: ${response.status} ${errorBody}`,
      );
      return {
        token: null,
        status: response.status,
        request,
        diagnostics,
        responseHeaders,
        error: `GitHub responded ${response.status}`,
      };
    }

    const parseStartedAt = nowMs();
    const data = (await response.json()) as { token: string; expires_at: string };
    diagnostics.parseMs = Math.round(nowMs() - parseStartedAt);
    diagnostics.totalMs = Math.round(nowMs() - startedAt);

    return {
      token: data.token,
      status: response.status,
      request,
      diagnostics,
      responseHeaders,
      error: null,
    };
  } catch (error) {
    diagnostics.totalMs = Math.round(nowMs() - startedAt);
    logger.error(`Error getting installation token for ${installationId}:`, error);
    return {
      token: null,
      status: null,
      request,
      diagnostics,
      responseHeaders: emptyHeaders,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function nowMs(): number {
  if (typeof performance !== "undefined") return performance.now();
  return Date.now();
}

export type GitHubRepository = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  defaultBranch: string;
  isPrivate: boolean;
};

export async function getRepositoryById(
  accessToken: string,
  repoId: string,
): Promise<GitHubRepository | null> {
  try {
    const response = await fetch(`https://api.github.com/repositories/${repoId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Iterate-OS",
      },
    });

    if (!response.ok) {
      logger.error(`Failed to fetch repository ${repoId}: ${response.status}`);
      return null;
    }

    const repo = (await response.json()) as {
      id: number;
      name: string;
      full_name: string;
      owner: { login: string };
      default_branch: string;
      private: boolean;
    };

    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      defaultBranch: repo.default_branch,
      isPrivate: repo.private,
    };
  } catch (error) {
    logger.error(`Error fetching repository ${repoId}:`, error);
    return null;
  }
}

export async function listInstallationRepositories(
  accessToken: string,
  installationId: number,
): Promise<GitHubRepository[]> {
  const response = await fetch(
    `https://api.github.com/user/installations/${installationId}/repositories`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Iterate-OS",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch repositories: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    repositories: Array<{
      id: number;
      name: string;
      full_name: string;
      owner: { login: string };
      default_branch: string;
      private: boolean;
    }>;
  };

  return data.repositories.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner.login,
    defaultBranch: repo.default_branch,
    isPrivate: repo.private,
  }));
}

// JSONata filters for webhook events - evaluated against { payload, env }
// Return true to process the event, false to skip
const WEBHOOK_FILTERS = {
  // workflow_run: process PR-linked runs in all stages, plus main-branch refresh flow in prd
  workflow_run:
    "(payload.workflow_run.pull_requests and $count(payload.workflow_run.pull_requests) > 0) or (env.APP_STAGE = 'prd' and payload.workflow_run.head_branch = 'main')",
  // commit_comment: require APP_STAGE=xxx tag in comment body to target specific environment
  commit_comment: `$contains(payload.comment.body, '[APP_STAGE=' & env.APP_STAGE & ']')`,
  pull_request_review: "true",
  pull_request_review_comment: "true",
  issue_comment: "payload.issue.pull_request != null",
  pull_request: "payload.action = 'closed' and payload.pull_request.merged = true",
};

// #region ========== Webhook Handler ==========

githubApp.post("/webhook", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  const xGithubEvent = c.req.header("x-github-event");
  const deliveryId = c.req.header("x-github-delivery");

  // Verify signature
  const isValid = await verifyGitHubSignature(c.env.GITHUB_WEBHOOK_SECRET, signature ?? null, body);
  if (!isValid) {
    logger.warn("[GitHub Webhook] Invalid signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(body);
  const repo = payload.repository as
    | { full_name?: string; owner?: { login?: string }; name?: string }
    | undefined;
  const repoFullName = repo?.full_name ?? "unknown";
  const repoOwner = repo?.owner?.login;
  const repoName = repo?.name;

  // Track webhook in PostHog with group association (non-blocking).
  // TODO: move enrichment out of webhook path (tasks/machine-metrics-pipeline.md).
  const db = c.var.db;
  const env = c.env;
  waitUntil(
    (async () => {
      let groups: { organization: string; project: string } | undefined;

      // Look up project repo to get group association
      if (repoOwner && repoName) {
        const projectRepoRecord = await db.query.projectRepo.findFirst({
          where: (pr, { eq, and }) => and(eq(pr.owner, repoOwner), eq(pr.name, repoName)),
          with: { project: true },
        });
        if (projectRepoRecord?.project) {
          groups = {
            organization: projectRepoRecord.project.organizationId,
            project: projectRepoRecord.projectId,
          };
        }
      }

      trackWebhookEvent(env, {
        distinctId: `github:${repoFullName}`,
        event: "github:webhook_received",
        properties: { ...payload, _event_type: xGithubEvent },
        groups,
      });
    })().catch((err) => {
      logger.error("[GitHub Webhook] PostHog tracking error", err);
    }),
  );

  // Insert raw event immediately after signature verification for deduplication.
  // Uses ON CONFLICT DO NOTHING with unique index on externalId.
  // This pattern allows this handler to become an outbox consumer later -
  // the event table acts as the inbox, and processing happens in background.
  if (!deliveryId) {
    logger.warn("[GitHub Webhook] Missing x-github-delivery header");
    return c.json({ error: "Missing delivery ID" }, 400);
  }
  const externalId = deliveryId;

  if (!xGithubEvent || !(xGithubEvent in WEBHOOK_FILTERS)) {
    return c.json({ message: `No filter for event type ${xGithubEvent}` }, 200);
  }
  const eventType = xGithubEvent as keyof typeof WEBHOOK_FILTERS;

  const jsonataExpression = WEBHOOK_FILTERS[eventType];

  const filterContext = { payload, env: { APP_STAGE: c.env.APP_STAGE } };
  const matches = await jsonata(jsonataExpression).evaluate(filterContext);
  if (!matches) {
    logger.debug("[GitHub Webhook] Event filtered out", { eventType, filter: jsonataExpression });
    return c.json({ message: `Event filtered out` }, 200);
  }

  const [inserted] = await c.var.db
    .insert(schema.event)
    .values({
      type: `github:${eventType}`,
      payload: { ...payload, _delivery_id: deliveryId },
      externalId,
    })
    .onConflictDoNothing({ target: [schema.event.type, schema.event.externalId] })
    .returning({ id: schema.event.id });

  if (!inserted) {
    // Duplicate delivery - already processed
    logger.debug("[GitHub Webhook] Duplicate delivery, skipping", { deliveryId });
    return c.json({ received: true, duplicate: true });
  }

  // Route to appropriate handler based on event type
  switch (eventType) {
    case "workflow_run": {
      const parseResult = WorkflowRunEvent.safeParse(payload);
      if (parseResult.success) {
        // Process in background, return immediately
        waitUntil(
          handleWorkflowRun({
            payload: parseResult.data,
            db: c.var.db,
            env: c.env,
          }).catch((err) => {
            logger.error("[GitHub Webhook] handleWorkflowRun error", err);
          }),
        );
      } else {
        logger.error(
          `[GitHub Webhook] handleWorkflowRun ${deliveryId} error: ${z.prettifyError(parseResult.error)}`,
        );
      }
      break;
    }
    case "commit_comment": {
      const parseResult = CommitCommentEvent.safeParse(payload);
      if (parseResult.success) {
        waitUntil(
          handleCommitComment({
            payload: parseResult.data,
            db: c.var.db,
            env: c.env,
          }).catch((err) => {
            logger.error("[GitHub Webhook] handleCommitComment error", err);
          }),
        );
      } else {
        logger.error(
          `[GitHub Webhook] handleCommitComment ${deliveryId} error: ${z.prettifyError(parseResult.error)}`,
        );
      }
      break;
    }
    case "pull_request_review": {
      const parseResult = PullRequestReviewEvent.safeParse(payload);
      if (parseResult.success) {
        waitUntil(
          handlePullRequestReview({ payload: parseResult.data, db: c.var.db, env: c.env }).catch(
            (err: unknown) => {
              logger.error("[GitHub Webhook] handlePullRequestReview error", err);
            },
          ),
        );
      } else {
        logger.error(
          `[GitHub Webhook] handlePullRequestReview ${deliveryId} error: ${z.prettifyError(parseResult.error)}`,
        );
      }
      break;
    }
    case "pull_request_review_comment": {
      const parseResult = PullRequestReviewCommentEvent.safeParse(payload);
      if (parseResult.success) {
        waitUntil(
          handlePullRequestReviewComment({
            payload: parseResult.data,
            db: c.var.db,
            env: c.env,
          }).catch((err: unknown) => {
            logger.error("[GitHub Webhook] handlePullRequestReviewComment error", err);
          }),
        );
      } else {
        logger.error(
          `[GitHub Webhook] handlePullRequestReviewComment ${deliveryId} error: ${z.prettifyError(parseResult.error)}`,
        );
      }
      break;
    }
    case "issue_comment": {
      const parseResult = IssueCommentEvent.safeParse(payload);
      if (parseResult.success) {
        waitUntil(
          handleIssueComment({ payload: parseResult.data, db: c.var.db, env: c.env }).catch(
            (err: unknown) => {
              logger.error("[GitHub Webhook] handleIssueComment error", err);
            },
          ),
        );
      } else {
        logger.error(
          `[GitHub Webhook] handleIssueComment ${deliveryId} error: ${z.prettifyError(parseResult.error)}`,
        );
      }
      break;
    }
    case "pull_request": {
      const parseResult = PullRequestEvent.safeParse(payload);
      if (parseResult.success) {
        waitUntil(
          handlePullRequest({ payload: parseResult.data, db: c.var.db, env: c.env }).catch(
            (err: unknown) => {
              logger.error("[GitHub Webhook] handlePullRequest error", err);
            },
          ),
        );
      } else {
        logger.error(
          `[GitHub Webhook] handlePullRequest ${deliveryId} error: ${z.prettifyError(parseResult.error)}`,
        );
      }
      break;
    }
    default: {
      // ensure we've handled all event types
      eventType satisfies never;
    }
  }

  return c.json({ received: true });
});

/**
 * Verify GitHub webhook signature using HMAC SHA-256.
 * GitHub sends the signature in the `x-hub-signature-256` header.
 */
async function verifyGitHubSignature(
  secret: string,
  signature: string | null,
  body: string,
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expectedSignature =
    "sha256=" +
    Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Timing-safe comparison
  if (signature.length !== expectedSignature.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

// Zod schema for GitHub workflow_run event payload
const WorkflowRunEvent = z.object({
  action: z.string(),
  workflow_run: z.object({
    id: z.number(),
    name: z.string(),
    head_branch: z.string(),
    head_sha: z.string(),
    path: z.string(),
    conclusion: z.string().nullable(),
    html_url: z.string().optional(),
    pull_requests: z
      .array(
        z.object({
          number: z.number(),
        }),
      )
      .optional()
      .default([]),
    repository: z.object({
      full_name: z.string(),
    }),
  }),
  repository: z.object({
    full_name: z.string(),
    owner: z.object({ login: z.string() }).optional(),
    name: z.string().optional(),
  }),
});

type WorkflowRunEvent = z.infer<typeof WorkflowRunEvent>;

// Zod schema for GitHub commit_comment event payload
const CommitCommentEvent = z.object({
  action: z.literal("created"),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    commit_id: z.string(), // The SHA of the commit
    user: z.object({
      login: z.string(),
    }),
  }),
  repository: z.object({
    full_name: z.string(),
  }),
});

type CommitCommentEvent = z.infer<typeof CommitCommentEvent>;

const PullRequestRef = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  user: z.object({ login: z.string() }),
});

const RepositoryPayload = z.object({
  full_name: z.string(),
  owner: z.object({ login: z.string() }).optional(),
  name: z.string().optional(),
});

const PullRequestReviewEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  pull_request: PullRequestRef,
  review: z.object({
    id: z.number(),
    body: z.string().nullable().optional(),
    state: z.string().optional(),
    html_url: z.string().optional(),
    user: z.object({ login: z.string() }),
  }),
  sender: z.object({ login: z.string() }).optional(),
});

type PullRequestReviewEvent = z.infer<typeof PullRequestReviewEvent>;

const PullRequestReviewCommentEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  pull_request: PullRequestRef,
  comment: z.object({
    id: z.number(),
    body: z.string(),
    html_url: z.string().optional(),
    user: z.object({ login: z.string() }),
  }),
  sender: z.object({ login: z.string() }).optional(),
});

type PullRequestReviewCommentEvent = z.infer<typeof PullRequestReviewCommentEvent>;

const IssueCommentEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  issue: z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    user: z.object({ login: z.string() }),
    pull_request: z.object({ url: z.string() }).nullable().optional(),
  }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    html_url: z.string().optional(),
    user: z.object({ login: z.string() }),
  }),
  sender: z.object({ login: z.string() }).optional(),
});

type IssueCommentEvent = z.infer<typeof IssueCommentEvent>;

const PullRequestEvent = z.object({
  action: z.string(),
  repository: RepositoryPayload,
  pull_request: PullRequestRef.extend({
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    merged_by: z.object({ login: z.string() }).nullable().optional(),
  }),
  sender: z.object({ login: z.string() }).optional(),
});

type PullRequestEvent = z.infer<typeof PullRequestEvent>;

type RepositoryPayload = z.infer<typeof RepositoryPayload>;

type GitHubRepoCoordinates = {
  owner: string;
  name: string;
  fullName: string;
};

type MachineProjectContext = {
  projectId: string;
  projectSlug: string;
  machine: typeof schema.machine.$inferSelect;
  installationId: number;
};

type GitHubPullRequestDetails = {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  authorLogin: string;
  headSha: string;
};

type GitHubIssueComment = {
  id: number;
  body: string;
  user: { login: string };
};

type GitHubReview = {
  id: number;
  body: string;
  user: { login: string };
};

type GitHubReviewComment = {
  id: number;
  body: string;
  user: { login: string };
};

type GitHubCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  appSlug: string | null;
};

type PullRequestContext = {
  pullRequest: GitHubPullRequestDetails;
  issueComments: GitHubIssueComment[];
  reviews: GitHubReview[];
  reviewComments: GitHubReviewComment[];
  checkRuns: GitHubCheckRun[];
};

type ParsedAgentMarker = {
  sessionId: string | null;
  stage: string | null;
};

type AgentTarget =
  | {
      kind: "path";
      agentPath: string;
    }
  | {
      kind: "opencode-session";
      sessionId: string;
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

type SignalGateDecision = {
  shouldProcess: boolean;
  reason:
    | "author_is_bot"
    | "marker_present"
    | "mention_pr_title_or_body"
    | "mention_issue_comment"
    | "mention_review"
    | "mention_review_comment"
    | "no_signal";
  diagnostics: {
    botHandles: string[];
    prAuthorLogin: string;
    markerSessionId: string | null;
    markerStage: string | null;
    mentionInTitle: boolean;
    mentionInBody: boolean;
    mentionIssueCommentCount: number;
    mentionReviewCount: number;
    mentionReviewCommentCount: number;
    latestIssueCommentPreview: string | null;
  };
};

const AGENT_MARKER_BLOCK_PATTERN = /<!--\s*iterate-agent-context([\s\S]*?)-->/i;
const SESSION_ID_PATTERN = /^ses_[a-zA-Z0-9_-]+$/;
const AGENT_STAGE_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const LOW_TRUST_AUTOMATED_REVIEWER_PATTERNS = [/bugbot/i, /pullfrog/i, /cursor/i];
const CURSOR_REVIEWER_PATTERN = /cursor/i;
const LOW_RISK_SIGNAL_PATTERN = /\blow[-\s]?risk\b/i;

function resolveRepoCoordinates(repository: RepositoryPayload): GitHubRepoCoordinates | null {
  const split = repository.full_name.split("/");
  const fallbackOwner = split[0]?.trim();
  const fallbackName = split[1]?.trim();

  const owner = repository.owner?.login?.trim() || fallbackOwner;
  const name = repository.name?.trim() || fallbackName;

  if (!owner || !name) return null;
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
  };
}

function toPathSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized || "x";
}

function normalizeSessionId(value: string | null | undefined): string | null {
  if (!value) return null;
  const sessionId = value.trim();
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
}

function normalizeAgentStageComponent(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return AGENT_STAGE_COMPONENT_PATTERN.test(normalized) ? normalized : null;
}

function normalizeAgentStage(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value
    .split(":")
    .map((part) => normalizeAgentStageComponent(part))
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return parts.join(":");
}

function getRuntimeAgentStage(env: CloudflareEnv): string | null {
  const envRecord = env as unknown as Record<string, unknown>;
  const explicitStageRaw =
    typeof envRecord.ITERATE_AGENT_STAGE === "string"
      ? envRecord.ITERATE_AGENT_STAGE
      : process.env.ITERATE_AGENT_STAGE;
  const explicitStage = normalizeAgentStage(explicitStageRaw);
  if (explicitStage) return explicitStage;

  const appStageRaw =
    typeof envRecord.APP_STAGE === "string"
      ? envRecord.APP_STAGE
      : typeof envRecord.VITE_APP_STAGE === "string"
        ? envRecord.VITE_APP_STAGE
        : (process.env.APP_STAGE ?? process.env.VITE_APP_STAGE);
  const appStage = normalizeAgentStageComponent(appStageRaw);
  if (!appStage) return null;

  const projectName = normalizeAgentStageComponent(
    typeof envRecord.PROJECT_NAME === "string" ? envRecord.PROJECT_NAME : process.env.PROJECT_NAME,
  );
  const iterateUser = normalizeAgentStageComponent(
    typeof envRecord.ITERATE_USER === "string" ? envRecord.ITERATE_USER : process.env.ITERATE_USER,
  );
  const scope = [projectName, iterateUser]
    .filter((part): part is string => Boolean(part))
    .join("_");

  return scope ? `${appStage}:${scope}` : appStage;
}

function isMarkerStageCompatible(markerStage: string | null, runtimeStage: string | null): boolean {
  if (!markerStage) return true;
  if (!runtimeStage) return false;
  if (markerStage === runtimeStage) return true;

  const markerParts = markerStage.split(":");
  const runtimeParts = runtimeStage.split(":");
  if (markerParts.length > 1 && runtimeParts.length > 1) return false;
  return markerParts[0] === runtimeParts[0];
}

function parseAgentMarker(text: string | null | undefined): ParsedAgentMarker | null {
  if (!text) return null;

  const blockMatch = text.match(AGENT_MARKER_BLOCK_PATTERN);
  if (!blockMatch?.[1]) return null;

  const marker: ParsedAgentMarker = {
    sessionId: null,
    stage: null,
  };

  for (const rawLine of blockMatch[1].split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-z_]+)\s*:\s*(.+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (!value) continue;

    if (key === "session_id") {
      const sessionId = normalizeSessionId(value);
      if (sessionId) marker.sessionId = sessionId;
      continue;
    }

    if (key === "stage") {
      const stage = normalizeAgentStage(value);
      if (stage) marker.stage = stage;
    }
  }

  if (!marker.sessionId) return null;
  return marker;
}

function findAgentMarker(context: PullRequestContext): ParsedAgentMarker | null {
  const sources = [
    context.pullRequest.body,
    ...context.issueComments.map((comment) => comment.body),
    ...context.reviews.map((review) => review.body),
    ...context.reviewComments.map((comment) => comment.body),
  ];

  for (const sourceText of sources) {
    const marker = parseAgentMarker(sourceText);
    if (marker) return marker;
  }

  return null;
}

function containsBotMention(
  text: string | null | undefined,
  botHandles: readonly string[],
): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return botHandles.some((handle) => lower.includes(handle));
}

function previewText(text: string | null | undefined, maxLength = 160): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizePromptText(text: string | null | undefined): string {
  if (!text) return "<empty>";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || "<empty>";
}

function isLowTrustAutomatedReviewer(login: string | null | undefined): boolean {
  if (!login) return false;
  return LOW_TRUST_AUTOMATED_REVIEWER_PATTERNS.some((pattern) => pattern.test(login));
}

function isCursorReviewer(login: string | null | undefined): boolean {
  if (!login) return false;
  return CURSOR_REVIEWER_PATTERN.test(login);
}

function hasLowRiskSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  return LOW_RISK_SIGNAL_PATTERN.test(text);
}

function hasCursorLowRiskSignalInContext(context: PullRequestContext): boolean {
  if (
    context.issueComments.some(
      (comment) => isCursorReviewer(comment.user.login) && hasLowRiskSignal(comment.body),
    )
  ) {
    return true;
  }

  if (
    context.reviews.some(
      (review) => isCursorReviewer(review.user.login) && hasLowRiskSignal(review.body),
    )
  ) {
    return true;
  }

  return context.reviewComments.some(
    (comment) => isCursorReviewer(comment.user.login) && hasLowRiskSignal(comment.body),
  );
}

function formatCommentActor(login: string): string {
  if (!isLowTrustAutomatedReviewer(login)) return `@${login}`;
  return `@${login} (automated reviewer)`;
}

function buildFirstLoopInContextSection(context: PullRequestContext): string {
  const issueCommentLines =
    context.issueComments.length === 0
      ? ["- none"]
      : context.issueComments.map(
          (comment) =>
            `- [issue_comment #${comment.id}] ${formatCommentActor(comment.user.login)}: ${normalizePromptText(comment.body)}`,
        );

  const reviewLines =
    context.reviews.length === 0
      ? ["- none"]
      : context.reviews.map(
          (review) =>
            `- [review #${review.id}] ${formatCommentActor(review.user.login)}: ${normalizePromptText(review.body)}`,
        );

  const reviewCommentLines =
    context.reviewComments.length === 0
      ? ["- none"]
      : context.reviewComments.map(
          (comment) =>
            `- [review_comment #${comment.id}] ${formatCommentActor(comment.user.login)}: ${normalizePromptText(comment.body)}`,
        );

  const checkRunLines =
    context.checkRuns.length === 0
      ? ["- none"]
      : [...context.checkRuns]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((checkRun) => {
            const status = checkRun.conclusion
              ? `${checkRun.status}/${checkRun.conclusion}`
              : checkRun.status;
            const app = checkRun.appSlug ? ` app=${checkRun.appSlug}` : "";
            const details = checkRun.detailsUrl ? ` ${checkRun.detailsUrl}` : "";
            return `- [${status}] ${checkRun.name}${app}${details}`;
          });

  return [
    "",
    "Initial PR context (first loop-in):",
    "Existing issue comments:",
    ...issueCommentLines,
    "Existing pull request reviews:",
    ...reviewLines,
    "Existing review comments:",
    ...reviewCommentLines,
    "Latest check runs on PR head:",
    ...checkRunLines,
  ].join("\n");
}

function buildDeterministicAgentPath(repo: GitHubRepoCoordinates, prNumber: number): string {
  return `/github/${toPathSegment(repo.owner)}/${toPathSegment(repo.name)}/pr-${prNumber}`;
}

function buildMarkerBlock(params: { sessionId: string; stage: string | null }): string {
  const lines = ["<!-- iterate-agent-context", `session_id: ${params.sessionId}`];
  if (params.stage) lines.push(`stage: ${params.stage}`);
  lines.push("-->");
  return lines.join("\n");
}

function buildBootstrapComment(params: {
  markerBlock: string;
  eventKind: PullRequestSignal["eventKind"];
}): string {
  return [
    "Iterate linked this PR to an agent session for automated follow-up on checks/reviews/comments.",
    "",
    params.markerBlock,
    "",
    `<!-- iterate-agent-bootstrap event=${params.eventKind} -->`,
  ].join("\n");
}

function selectAgentTarget(
  marker: ParsedAgentMarker | null,
  fallbackAgentPath: string,
): AgentTarget {
  if (marker?.sessionId) {
    return { kind: "opencode-session", sessionId: marker.sessionId };
  }

  return { kind: "path", agentPath: fallbackAgentPath };
}

function buildPullRequestPrompt(params: {
  signal: PullRequestSignal;
  context: PullRequestContext;
  target: AgentTarget;
  usedFallback: boolean;
}): string {
  const lowTrustAutomatedReviewer = isLowTrustAutomatedReviewer(params.signal.actorLogin);
  const cursorLowRiskSignal = hasCursorLowRiskSignalInContext(params.context);

  const targetLine =
    params.target.kind === "path"
      ? `Target agent path: ${params.target.agentPath}`
      : `Target session id: ${params.target.sessionId}`;

  const bodySection = params.signal.eventBody
    ? ["", "Event body:", params.signal.eventBody].join("\n")
    : "";

  const firstLoopInContextSection = params.usedFallback
    ? buildFirstLoopInContextSection(params.context)
    : "";

  const postMergeFollowUpGuidance =
    params.signal.eventKind === "pull_request" && params.signal.action === "closed"
      ? [
          "",
          "Post-merge follow-up guidance:",
          "- PR is merged. Monitor the deploy-os workflow plus logs/checks to confirm rollout health.",
          "- Exit when you are confident the fix solved the issues and introduced no new ones.",
        ].join("\n")
      : "";

  const fixValidationGuidance = [
    "",
    "Fix validation guidance:",
    "- After making changes, monitor relevant logs/checks/comments to confirm the fix actually worked.",
    "- When review comments request changes, update the PR directly and report back with what changed.",
  ].join("\n");

  const automatedReviewerGuidance = lowTrustAutomatedReviewer
    ? [
        "",
        "Automated reviewer guidance:",
        "- You are allowed to reject feedback, especially from reviewbots.",
      ].join("\n")
    : "";

  const reviewbotIssueActionGuidance = [
    "",
    "Reviewbot action guidance:",
    "- For issues flagged by Cursor Bugbot/pullfrog/other reviewbots: if validated and safe, apply fixes directly without asking for confirmation.",
  ].join("\n");

  const cursorLowRiskMergeGuidance = cursorLowRiskSignal
    ? [
        "",
        "Cursor low-risk merge guidance:",
        "- If Cursor Bugbot marked this low risk and independent verification shows merge is safe, you may auto-merge.",
      ].join("\n")
    : "";

  return [
    "[GitHub PR Event]",
    `Repo: ${params.signal.repo.fullName}`,
    `PR: #${params.context.pullRequest.number} ${params.context.pullRequest.htmlUrl}`,
    `PR title: ${params.context.pullRequest.title}`,
    `PR author: ${params.context.pullRequest.authorLogin}`,
    `Event: ${params.signal.eventKind}`,
    `Action: ${params.signal.action}`,
    `Actor: ${params.signal.actorLogin}`,
    `Event URL: ${params.signal.eventUrl}`,
    targetLine,
    `Fallback target used: ${params.usedFallback ? "yes" : "no"}`,
    bodySection,
    firstLoopInContextSection,
    postMergeFollowUpGuidance,
    fixValidationGuidance,
    automatedReviewerGuidance,
    reviewbotIssueActionGuidance,
    cursorLowRiskMergeGuidance,
  ].join("\n");
}

async function buildMachineForwardFetcher(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<((input: string | Request | URL, init?: RequestInit) => Promise<Response>) | null> {
  const metadata = machine.metadata as Record<string, unknown> | null;

  try {
    const runtime = await createMachineStub({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: metadata ?? {},
    });
    return await runtime.getFetcher(3000);
  } catch (err) {
    logger.warn("[GitHub Webhook] Failed to build machine forward fetcher", {
      machineId: machine.id,
      machineType: machine.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function forwardPromptToMachine(params: {
  machine: typeof schema.machine.$inferSelect;
  env: CloudflareEnv;
  target: AgentTarget;
  prompt: string;
}): Promise<{ sessionId: string | null }> {
  const fetcher = await buildMachineForwardFetcher(params.machine, params.env);
  if (!fetcher) throw new Error("Could not build machine forward fetcher");

  const path =
    params.target.kind === "path"
      ? `/api/agents${params.target.agentPath}`
      : `/api/opencode/sessions/${encodeURIComponent(params.target.sessionId)}`;

  const response = await fetcher(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "iterate:agent:prompt-added", message: params.prompt }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`Agent forward failed (${response.status}): ${body.slice(0, 500)}`);
  }

  let sessionId =
    params.target.kind === "opencode-session" ? normalizeSessionId(params.target.sessionId) : null;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json().catch(() => null)) as { sessionId?: unknown } | null;
    if (payload && typeof payload === "object" && typeof payload.sessionId === "string") {
      sessionId = normalizeSessionId(payload.sessionId) ?? sessionId;
    }
  }

  return { sessionId };
}

async function githubApiRequestJson<T>(params: {
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

async function listRepoMachineContexts(params: {
  db: DB;
  owner: string;
  name: string;
}): Promise<MachineProjectContext[]> {
  const repos = await params.db.query.projectRepo.findMany({
    where: (pr, { eq: whereEq, and: whereAnd }) =>
      whereAnd(whereEq(pr.owner, params.owner), whereEq(pr.name, params.name)),
    with: {
      project: {
        with: {
          machines: {
            where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
            limit: 1,
          },
        },
      },
    },
  });

  const contexts = await Promise.all(
    repos.map(async (repo): Promise<MachineProjectContext | null> => {
      const machine = repo.project?.machines?.[0] ?? null;
      if (!machine) return null;

      const githubConnection = await params.db.query.projectConnection.findFirst({
        where: (connection, { eq: whereEq, and: whereAnd }) =>
          whereAnd(
            whereEq(connection.projectId, repo.projectId),
            whereEq(connection.provider, "github-app"),
          ),
      });

      const providerData = githubConnection?.providerData as
        | { installationId?: number }
        | undefined;
      const installationId = providerData?.installationId;
      if (!installationId) return null;

      return {
        projectId: repo.projectId,
        projectSlug: repo.project.slug,
        machine,
        installationId,
      };
    }),
  );

  return contexts.filter((context): context is MachineProjectContext => Boolean(context));
}

async function fetchPullRequestContext(params: {
  token: string;
  repo: GitHubRepoCoordinates;
  prNumber: number;
}): Promise<PullRequestContext> {
  const repoPrefix = `https://api.github.com/repos/${params.repo.owner}/${params.repo.name}`;

  const pullRequest = await githubApiRequestJson<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
    head: { sha: string };
  }>({ token: params.token, url: `${repoPrefix}/pulls/${params.prNumber}` });

  const [issueComments, reviews, reviewComments, checkRuns] = await Promise.all([
    githubApiRequestJson<GitHubIssueComment[]>({
      token: params.token,
      url: `${repoPrefix}/issues/${params.prNumber}/comments?per_page=100`,
    }),
    githubApiRequestJson<GitHubReview[]>({
      token: params.token,
      url: `${repoPrefix}/pulls/${params.prNumber}/reviews?per_page=100`,
    }),
    githubApiRequestJson<GitHubReviewComment[]>({
      token: params.token,
      url: `${repoPrefix}/pulls/${params.prNumber}/comments?per_page=100`,
    }),
    githubApiRequestJson<{
      check_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        details_url: string | null;
        app?: { slug?: string | null } | null;
      }>;
    }>({
      token: params.token,
      url: `${repoPrefix}/commits/${pullRequest.head.sha}/check-runs?per_page=100`,
    })
      .then((result) =>
        result.check_runs.map(
          (checkRun): GitHubCheckRun => ({
            id: checkRun.id,
            name: checkRun.name,
            status: checkRun.status,
            conclusion: checkRun.conclusion,
            detailsUrl: checkRun.details_url,
            appSlug: checkRun.app?.slug ?? null,
          }),
        ),
      )
      .catch((err) => {
        logger.warn("[GitHub Webhook] Failed to fetch check runs for PR context", {
          repo: params.repo.fullName,
          prNumber: params.prNumber,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }),
  ]);

  return {
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? "",
      htmlUrl: pullRequest.html_url,
      authorLogin: pullRequest.user.login,
      headSha: pullRequest.head.sha,
    },
    issueComments,
    reviews,
    reviewComments,
    checkRuns,
  };
}

async function ensureBootstrapComment(params: {
  token: string;
  repo: GitHubRepoCoordinates;
  prNumber: number;
  markerBlock: string;
  eventKind: PullRequestSignal["eventKind"];
  existingIssueComments: GitHubIssueComment[];
}): Promise<void> {
  const markerSessionId = parseAgentMarker(params.markerBlock)?.sessionId;
  if (!markerSessionId) return;

  const existing = params.existingIssueComments.some((comment) => {
    const marker = parseAgentMarker(comment.body);
    return marker?.sessionId === markerSessionId;
  });
  if (existing) return;

  const url = `https://api.github.com/repos/${params.repo.owner}/${params.repo.name}/issues/${params.prNumber}/comments`;
  await githubApiRequestJson<{ id: number }>({
    token: params.token,
    url,
    method: "POST",
    body: {
      body: buildBootstrapComment({ markerBlock: params.markerBlock, eventKind: params.eventKind }),
    },
  });
}

function decideSignalGate(params: {
  context: PullRequestContext;
  marker: ParsedAgentMarker | null;
  botHandles: readonly string[];
}): SignalGateDecision {
  const { context, marker, botHandles } = params;
  const mentionInTitle = containsBotMention(context.pullRequest.title, botHandles);
  const mentionInBody = containsBotMention(context.pullRequest.body, botHandles);
  const mentionIssueCommentCount = context.issueComments.filter((comment) =>
    containsBotMention(comment.body, botHandles),
  ).length;
  const mentionReviewCount = context.reviews.filter((review) =>
    containsBotMention(review.body, botHandles),
  ).length;
  const mentionReviewCommentCount = context.reviewComments.filter((comment) =>
    containsBotMention(comment.body, botHandles),
  ).length;

  const diagnostics = {
    botHandles: [...botHandles],
    prAuthorLogin: context.pullRequest.authorLogin,
    markerSessionId: marker?.sessionId ?? null,
    markerStage: marker?.stage ?? null,
    mentionInTitle,
    mentionInBody,
    mentionIssueCommentCount,
    mentionReviewCount,
    mentionReviewCommentCount,
    latestIssueCommentPreview: previewText(context.issueComments.at(-1)?.body),
  };

  const authorIsBot = botHandles.some((handle) => {
    const login = handle.slice(1);
    return context.pullRequest.authorLogin.toLowerCase() === login;
  });
  if (authorIsBot) {
    return { shouldProcess: true, reason: "author_is_bot", diagnostics };
  }
  if (marker) {
    return { shouldProcess: true, reason: "marker_present", diagnostics };
  }
  if (mentionInTitle || mentionInBody) {
    return { shouldProcess: true, reason: "mention_pr_title_or_body", diagnostics };
  }
  if (mentionIssueCommentCount > 0) {
    return { shouldProcess: true, reason: "mention_issue_comment", diagnostics };
  }
  if (mentionReviewCount > 0) {
    return { shouldProcess: true, reason: "mention_review", diagnostics };
  }
  if (mentionReviewCommentCount > 0) {
    return { shouldProcess: true, reason: "mention_review_comment", diagnostics };
  }
  return { shouldProcess: false, reason: "no_signal", diagnostics };
}

async function routePullRequestSignalToAgent(params: {
  db: DB;
  env: CloudflareEnv;
  signal: PullRequestSignal;
}) {
  const allContexts = await listRepoMachineContexts({
    db: params.db,
    owner: params.signal.repo.owner,
    name: params.signal.repo.name,
  });

  if (allContexts.length === 0) {
    logger.debug("[GitHub Webhook] No active machine context for PR signal", {
      repo: params.signal.repo.fullName,
      prNumber: params.signal.prNumber,
      eventKind: params.signal.eventKind,
    });
    return;
  }

  const bootstrapContext = allContexts[0];
  const bootstrapToken = await getGitHubInstallationToken(
    params.env,
    bootstrapContext.installationId,
  );
  if (!bootstrapToken) {
    throw new Error(
      `Could not get GitHub installation token for installation ${bootstrapContext.installationId}`,
    );
  }

  const prContext = await fetchPullRequestContext({
    token: bootstrapToken,
    repo: params.signal.repo,
    prNumber: params.signal.prNumber,
  });

  const marker = findAgentMarker(prContext);
  const runtimeStage = getRuntimeAgentStage(params.env);
  if (!isMarkerStageCompatible(marker?.stage ?? null, runtimeStage)) {
    logger.debug("[GitHub Webhook] PR signal ignored due agent stage mismatch", {
      repo: params.signal.repo.fullName,
      prNumber: params.signal.prNumber,
      eventKind: params.signal.eventKind,
      markerStage: marker?.stage,
      runtimeStage,
    });
    return;
  }

  const contexts = allContexts;

  if (contexts.length !== 1) {
    throw new Error(
      `Ambiguous Iterate project mapping for ${params.signal.repo.fullName}#${params.signal.prNumber}. Matched projects: ${contexts.map((context) => context.projectSlug).join(", ") || "none"}`,
    );
  }

  const context = contexts[0];
  const token =
    context.installationId === bootstrapContext.installationId
      ? bootstrapToken
      : await getGitHubInstallationToken(params.env, context.installationId);
  if (!token) {
    throw new Error(
      `Could not get GitHub installation token for installation ${context.installationId}`,
    );
  }

  const botLogin = `${params.env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
  const botHandles = [`@${botLogin}`, `@${params.env.GITHUB_APP_SLUG.toLowerCase()}`] as const;

  const gateDecision = decideSignalGate({ context: prContext, marker, botHandles });
  if (!gateDecision.shouldProcess) {
    logger.debug("[GitHub Webhook] PR signal ignored by gate", {
      repo: params.signal.repo.fullName,
      prNumber: params.signal.prNumber,
      eventKind: params.signal.eventKind,
      action: params.signal.action,
      githubAppSlug: params.env.GITHUB_APP_SLUG,
      signalActor: params.signal.actorLogin,
      signalEventBodyPreview: previewText(params.signal.eventBody),
      gateReason: gateDecision.reason,
      ...gateDecision.diagnostics,
    });
    return;
  }

  const fallbackAgentPath = buildDeterministicAgentPath(params.signal.repo, params.signal.prNumber);
  const target = selectAgentTarget(marker, fallbackAgentPath);

  const prompt = buildPullRequestPrompt({
    signal: params.signal,
    context: prContext,
    target,
    usedFallback: !marker,
  });

  const forwardResult = await forwardPromptToMachine({
    machine: context.machine,
    env: params.env,
    target,
    prompt,
  });

  if (!marker && forwardResult.sessionId) {
    const markerBlock = buildMarkerBlock({
      sessionId: forwardResult.sessionId,
      stage: runtimeStage,
    });
    await ensureBootstrapComment({
      token,
      repo: params.signal.repo,
      prNumber: params.signal.prNumber,
      markerBlock,
      eventKind: params.signal.eventKind,
      existingIssueComments: prContext.issueComments,
    });
  }

  logger.info("[GitHub Webhook] Routed PR signal to agent", {
    repo: params.signal.repo.fullName,
    prNumber: params.signal.prNumber,
    eventKind: params.signal.eventKind,
    action: params.signal.action,
    projectSlug: context.projectSlug,
    targetKind: target.kind,
    target: target.kind === "path" ? target.agentPath : target.sessionId,
    markerStage: marker?.stage,
    runtimeStage,
    usedFallback: !marker,
  });
}

/**
 * Handle a workflow_run event. Checks if this is an event we care about
 * and takes appropriate action.
 *
 * NOTE: This function could become an outbox consumer in the future.
 * The event is already persisted in the events table before this runs.
 */
async function handleWorkflowRun({ payload, db, env }: HandleWorkflowRunParams) {
  const { workflow_run } = payload;

  const workflowRepo = resolveRepoCoordinates(payload.repository);
  if (workflowRepo && workflow_run.pull_requests.length > 0) {
    for (const pullRequest of workflow_run.pull_requests) {
      await routePullRequestSignalToAgent({
        db,
        env,
        signal: {
          repo: workflowRepo,
          prNumber: pullRequest.number,
          eventKind: "workflow_run",
          action: payload.action,
          actorLogin: "github-actions[bot]",
          eventBody: `Workflow: ${workflow_run.name}\nConclusion: ${workflow_run.conclusion ?? "unknown"}\nHead branch: ${workflow_run.head_branch}`,
          eventUrl: workflow_run.html_url ?? "",
        },
      });
    }
  }

  // Check if this is an iterate/iterate CI completion on main
  if (!IterateCICompletion.safeParse(payload).success) {
    logger.debug("[GitHub Webhook] workflow_run not matching any handlers", {
      action: payload.action,
      conclusion: workflow_run.conclusion,
      branch: workflow_run.head_branch,
      path: workflow_run.path,
      repo: workflow_run.repository.full_name,
    });
    return;
  }

  const headSha = workflow_run.head_sha;
  const shortSha = headSha.slice(0, 7);

  logger.info("[GitHub Webhook] Processing CI completion", {
    workflowRunId: workflow_run.id,
    headSha,
    shortSha,
  });

  // Get all projects with active machines
  const projectsWithActiveMachines = await db.query.project.findMany({
    with: {
      organization: true,
      machines: {
        where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
        limit: 1,
      },
    },
  });

  const projectsToUpdate = projectsWithActiveMachines.filter((p) => p.machines.length > 0);

  logger.info("[GitHub Webhook] Found projects to update", {
    total: projectsWithActiveMachines.length,
    withActiveMachines: projectsToUpdate.length,
  });

  // Create new machines for each project
  let successCount = 0;
  let errorCount = 0;

  for (const project of projectsToUpdate) {
    try {
      const activeMachine = project.machines[0];
      const machineName = `ci-${shortSha}`;
      const snapshotName = snapshotNameForProvider(project.sandboxProvider, shortSha, env);
      const carriedMetadata = stripMachineStateMetadata(
        (activeMachine.metadata as Record<string, unknown>) ?? {},
      );

      const result = await createMachineForProject({
        db,
        env,
        projectId: project.id,
        organizationId: project.organizationId,
        organizationSlug: project.organization.slug,
        projectSlug: project.slug,
        name: machineName,
        metadata: {
          ...carriedMetadata,
          ...(snapshotName ? { snapshotName } : {}),
        },
      });
      if (result.provisionPromise) {
        waitUntil(result.provisionPromise);
      }

      logger.info("[GitHub Webhook] Created machine", {
        projectId: project.id,
        machineName,
      });
      successCount++;
    } catch (err) {
      logger.error("[GitHub Webhook] Failed to create machine", {
        projectId: project.id,
        error: err instanceof Error ? err.message : String(err),
      });
      errorCount++;
    }
  }

  logger.info("[GitHub Webhook] Completed machine recreation", {
    successCount,
    errorCount,
  });
}

async function handlePullRequestReview({ payload, db, env }: HandlePullRequestReviewParams) {
  if (payload.action === "dismissed") return;

  const repo = resolveRepoCoordinates(payload.repository);
  if (!repo) return;

  await routePullRequestSignalToAgent({
    db,
    env,
    signal: {
      repo,
      prNumber: payload.pull_request.number,
      eventKind: "pull_request_review",
      action: payload.action,
      actorLogin: payload.review.user.login,
      eventBody: payload.review.body?.trim() ?? "",
      eventUrl: payload.review.html_url ?? payload.pull_request.html_url,
    },
  });
}

async function handlePullRequestReviewComment({
  payload,
  db,
  env,
}: HandlePullRequestReviewCommentParams) {
  if (payload.action === "deleted") return;

  const repo = resolveRepoCoordinates(payload.repository);
  if (!repo) return;

  await routePullRequestSignalToAgent({
    db,
    env,
    signal: {
      repo,
      prNumber: payload.pull_request.number,
      eventKind: "pull_request_review_comment",
      action: payload.action,
      actorLogin: payload.comment.user.login,
      eventBody: payload.comment.body,
      eventUrl: payload.comment.html_url ?? payload.pull_request.html_url,
    },
  });
}

async function handleIssueComment({ payload, db, env }: HandleIssueCommentParams) {
  if (!payload.issue.pull_request) return;
  if (payload.action === "deleted") return;

  const repo = resolveRepoCoordinates(payload.repository);
  if (!repo) return;

  await routePullRequestSignalToAgent({
    db,
    env,
    signal: {
      repo,
      prNumber: payload.issue.number,
      eventKind: "issue_comment",
      action: payload.action,
      actorLogin: payload.comment.user.login,
      eventBody: payload.comment.body,
      eventUrl: payload.comment.html_url ?? payload.issue.html_url,
    },
  });
}

async function handlePullRequest({ payload, db, env }: HandlePullRequestParams) {
  if (payload.action !== "closed") return;
  if (!payload.pull_request.merged) return;

  const repo = resolveRepoCoordinates(payload.repository);
  if (!repo) return;

  const mergedBy = payload.pull_request.merged_by?.login ?? payload.sender?.login ?? "unknown";

  await routePullRequestSignalToAgent({
    db,
    env,
    signal: {
      repo,
      prNumber: payload.pull_request.number,
      eventKind: "pull_request",
      action: payload.action,
      actorLogin: mergedBy,
      eventBody: `PR merged by: ${mergedBy}\nMerge commit: ${payload.pull_request.merge_commit_sha ?? "unknown"}`,
      eventUrl: payload.pull_request.html_url,
    },
  });
}

// Schema to identify CI completion events we want to act on
const IterateCICompletion = z.object({
  action: z.literal("completed"),
  workflow_run: z.object({
    head_branch: z.literal("main"),
    path: z.string().endsWith("ci.yml"),
    conclusion: z.literal("success"),
    repository: z.object({
      full_name: z.literal("iterate/iterate"),
    }),
  }),
});

type HandleWorkflowRunParams = {
  payload: WorkflowRunEvent;
  db: DB;
  env: CloudflareEnv;
};

type HandlePullRequestParams = {
  payload: PullRequestEvent;
  db: DB;
  env: CloudflareEnv;
};

type HandlePullRequestReviewParams = {
  payload: PullRequestReviewEvent;
  db: DB;
  env: CloudflareEnv;
};

type HandlePullRequestReviewCommentParams = {
  payload: PullRequestReviewCommentEvent;
  db: DB;
  env: CloudflareEnv;
};

type HandleIssueCommentParams = {
  payload: IssueCommentEvent;
  db: DB;
  env: CloudflareEnv;
};

type HandleCommitCommentParams = {
  payload: CommitCommentEvent;
  db: DB;
  env: CloudflareEnv;
};

/**
 * Handle a commit_comment event. Looks for [refresh] tag to trigger machine recreation.
 * This allows manual testing of the webhook flow by commenting on any commit.
 */
async function handleCommitComment({ payload, db, env }: HandleCommitCommentParams) {
  const { comment, repository } = payload;

  // Only process comments on iterate/iterate repo
  if (repository.full_name !== "iterate/iterate") {
    logger.debug("[GitHub Webhook] commit_comment not from iterate/iterate", {
      repo: repository.full_name,
    });
    return;
  }

  // Look for [refresh] tag in comment body
  if (!comment.body.includes("[refresh]")) {
    logger.debug("[GitHub Webhook] commit_comment missing [refresh] tag", {
      commentId: comment.id,
      user: comment.user.login,
    });
    return;
  }

  const commitSha = comment.commit_id;
  const shortSha = commitSha.slice(0, 7);

  logger.info("[GitHub Webhook] Processing [refresh] comment", {
    commentId: comment.id,
    user: comment.user.login,
    commitSha,
    shortSha,
  });

  // Get all projects with active machines
  const projectsWithActiveMachines = await db.query.project.findMany({
    with: {
      organization: true,
      machines: {
        where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
        limit: 1,
      },
    },
  });

  const projectsToUpdate = projectsWithActiveMachines.filter((p) => p.machines.length > 0);

  logger.info("[GitHub Webhook] Found projects to update from comment", {
    total: projectsWithActiveMachines.length,
    withActiveMachines: projectsToUpdate.length,
  });

  let successCount = 0;
  let errorCount = 0;

  for (const project of projectsToUpdate) {
    try {
      const activeMachine = project.machines[0];
      const machineName = `refresh-${shortSha}`;
      const snapshotName = snapshotNameForProvider(project.sandboxProvider, shortSha, env);
      const carriedMetadata = stripMachineStateMetadata(
        (activeMachine.metadata as Record<string, unknown>) ?? {},
      );

      const result = await createMachineForProject({
        db,
        env,
        projectId: project.id,
        organizationId: project.organizationId,
        organizationSlug: project.organization.slug,
        projectSlug: project.slug,
        name: machineName,
        metadata: {
          ...carriedMetadata,
          ...(snapshotName ? { snapshotName } : {}),
          triggeredBy: `commit_comment:${comment.id}`,
          triggeredByUser: comment.user.login,
        },
      });
      if (result.provisionPromise) {
        waitUntil(result.provisionPromise);
      }

      logger.info("[GitHub Webhook] Created machine from comment", {
        projectId: project.id,
        machineName,
      });
      successCount++;
    } catch (err) {
      logger.error("[GitHub Webhook] Failed to create machine from comment", {
        projectId: project.id,
        error: err instanceof Error ? err.message : String(err),
      });
      errorCount++;
    }
  }

  logger.info("[GitHub Webhook] Completed machine recreation from comment", {
    successCount,
    errorCount,
  });
}

// #endregion ========== Webhook Handler ==========
