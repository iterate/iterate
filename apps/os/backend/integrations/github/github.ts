import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import * as arctic from "arctic";
import * as jose from "jose";
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
      const flyDefault = env.FLY_DEFAULT_IMAGE;
      if (!flyDefault) return undefined;
      const colonIdx = flyDefault.lastIndexOf(":");
      if (colonIdx === -1) return undefined;
      return `${flyDefault.slice(0, colonIdx)}:sha-${shortSha}`;
    }
    case "docker": {
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
      logger.set({ user: { id: c.var.session.user.id }, stateUserId: userId });
      logger.warn("GitHub callback user mismatch");
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
  const startedAt = Date.now();
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
    const jwtStartedAt = Date.now();
    const jwt = await generateGitHubAppJWT(env);
    diagnostics.jwtMs = Math.round(Date.now() - jwtStartedAt);

    const fetchStartedAt = Date.now();
    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Iterate-OS",
      },
    });
    diagnostics.fetchMs = Math.round(Date.now() - fetchStartedAt);

    const responseHeaders = {
      xGitHubRequestId: response.headers.get("x-github-request-id"),
      xRateLimitLimit: response.headers.get("x-ratelimit-limit"),
      xRateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
      xRateLimitReset: response.headers.get("x-ratelimit-reset"),
    };

    if (!response.ok) {
      const parseStartedAt = Date.now();
      const errorBody = await response.text();
      diagnostics.parseMs = Math.round(Date.now() - parseStartedAt);
      diagnostics.totalMs = Math.round(Date.now() - startedAt);

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

    const parseStartedAt = Date.now();
    const data = (await response.json()) as { token: string; expires_at: string };
    diagnostics.parseMs = Math.round(Date.now() - parseStartedAt);
    diagnostics.totalMs = Math.round(Date.now() - startedAt);

    return {
      token: data.token,
      status: response.status,
      request,
      diagnostics,
      responseHeaders,
      error: null,
    };
  } catch (error) {
    diagnostics.totalMs = Math.round(Date.now() - startedAt);
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

// ── Webhook Types ──────────────────────────────────────────────────

type WebhookEventParams<T = unknown> = { payload: T; db: DB; env: CloudflareEnv };

// ── Webhook Schemas ────────────────────────────────────────────────

const RepositoryPayload = z.object({
  full_name: z.string(),
  owner: z.object({ login: z.string() }).optional(),
  name: z.string().optional(),
});

type RepositoryPayload = z.infer<typeof RepositoryPayload>;

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
      .array(z.object({ number: z.number() }))
      .optional()
      .default([]),
    repository: z.object({ full_name: z.string() }),
  }),
  repository: RepositoryPayload,
});

type WorkflowRunEvent = z.infer<typeof WorkflowRunEvent>;

const CommitCommentEvent = z.object({
  action: z.literal("created"),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    commit_id: z.string(),
    user: z.object({ login: z.string() }),
  }),
  repository: z.object({ full_name: z.string() }),
});

type CommitCommentEvent = z.infer<typeof CommitCommentEvent>;

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

// ── Webhook App ────────────────────────────────────────────────────

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
  if (!deliveryId) {
    logger.warn("[GitHub Webhook] Missing x-github-delivery header");
    return c.json({ error: "Missing delivery ID" }, 400);
  }
  const externalId = deliveryId;

  if (!xGithubEvent) {
    return c.json({ error: "Missing x-github-event" }, 400);
  }
  const eventType = xGithubEvent;

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

  waitUntil(
    processGitHubWebhookEvent({ eventType, payload, deliveryId, db, env }).catch((err) => {
      logger.error("[GitHub Webhook] Failed to process webhook", err);
    }),
  );

  return c.json({ received: true });
});

// ── Signature Verification ─────────────────────────────────────────

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

// ── Webhook Utilities ──────────────────────────────────────────────

// ── Shared Machine Recreation ──────────────────────────────────────

async function recreateMachinesForAllProjects(params: {
  db: DB;
  env: CloudflareEnv;
  shortSha: string;
  namePrefix: string;
  extraMetadata?: Record<string, unknown>;
  logContext: string;
}): Promise<void> {
  const projectsWithActiveMachines = await params.db.query.project.findMany({
    with: {
      organization: true,
      machines: {
        where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
        limit: 1,
      },
    },
  });

  const projectsToUpdate = projectsWithActiveMachines.filter((p) => p.machines.length > 0);

  logger.set({
    total: projectsWithActiveMachines.length,
    withActiveMachines: projectsToUpdate.length,
  });
  logger.info(`[GitHub Webhook] Found projects to update${params.logContext}`);

  let successCount = 0;
  let errorCount = 0;

  for (const project of projectsToUpdate) {
    try {
      const activeMachine = project.machines[0];
      const machineName = `${params.namePrefix}-${params.shortSha}`;
      const snapshotName = snapshotNameForProvider(
        project.sandboxProvider,
        params.shortSha,
        params.env,
      );
      const carriedMetadata = stripMachineStateMetadata(
        (activeMachine.metadata as Record<string, unknown>) ?? {},
      );

      await createMachineForProject({
        db: params.db,
        env: params.env,
        projectId: project.id,
        name: machineName,
        metadata: {
          ...carriedMetadata,
          ...(snapshotName ? { snapshotName } : {}),
          ...params.extraMetadata,
        },
      });

      logger.set({ projectId: project.id, machineName });
      logger.info(`[GitHub Webhook] Created machine${params.logContext}`);
      successCount++;
    } catch (err) {
      logger.error(`[GitHub Webhook] Failed to create machine${params.logContext}`, {
        projectId: project.id,
        error: err instanceof Error ? err.message : String(err),
      });
      errorCount++;
    }
  }

  logger.set({ successCount, errorCount });
  logger.info(`[GitHub Webhook] Completed machine recreation${params.logContext}`);
}

// ── Webhook Event Handlers ─────────────────────────────────────────

async function handleWorkflowRun({ payload, db, env }: WebhookEventParams<WorkflowRunEvent>) {
  const { workflow_run } = payload;

  if (env.APP_STAGE !== "prd") {
    logger.debug("[GitHub Webhook] Ignoring workflow_run outside prd", {
      appStage: env.APP_STAGE,
      action: payload.action,
      branch: workflow_run.head_branch,
      repo: workflow_run.repository.full_name,
    });
    return;
  }

  // Check if this is an iterate/iterate CI completion on main
  if (!IterateCICompletion.safeParse(payload).success) {
    logger.debug("[GitHub Webhook] Ignoring workflow_run event", {
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

  logger.set({ workflowRunId: workflow_run.id, headSha, shortSha });
  logger.info("[GitHub Webhook] Processing CI completion");

  await recreateMachinesForAllProjects({ db, env, shortSha, namePrefix: "ci", logContext: "" });
}

async function processGitHubWebhookEvent(params: {
  eventType: string;
  payload: unknown;
  deliveryId: string;
  db: DB;
  env: CloudflareEnv;
}): Promise<void> {
  if (params.eventType === "workflow_run") {
    const parsed = WorkflowRunEvent.safeParse(params.payload);
    if (!parsed.success) {
      logger.error(
        `[GitHub Webhook] workflow_run ${params.deliveryId} parse error: ${z.prettifyError(parsed.error)}`,
      );
      return;
    }
    await handleWorkflowRun({ payload: parsed.data, db: params.db, env: params.env });
    return;
  }

  if (params.eventType === "commit_comment") {
    const parsed = CommitCommentEvent.safeParse(params.payload);
    if (!parsed.success) {
      logger.error(
        `[GitHub Webhook] commit_comment ${params.deliveryId} parse error: ${z.prettifyError(parsed.error)}`,
      );
      return;
    }
    await handleCommitComment({ payload: parsed.data, db: params.db, env: params.env });
    return;
  }

  logger.debug("[GitHub Webhook] Ignoring non-recreation event", {
    eventType: params.eventType,
    deliveryId: params.deliveryId,
  });
}

async function handleCommitComment({ payload, db, env }: WebhookEventParams<CommitCommentEvent>) {
  const { comment, repository } = payload;

  if (repository.full_name !== "iterate/iterate") {
    logger.debug("[GitHub Webhook] commit_comment not from iterate/iterate", {
      repo: repository.full_name,
    });
    return;
  }

  if (!comment.body.includes("[refresh]")) {
    logger.debug("[GitHub Webhook] commit_comment missing [refresh] tag", {
      commentId: comment.id,
      user: comment.user.login,
    });
    return;
  }

  const appStageTag = `[APP_STAGE=${env.APP_STAGE}]`;
  if (!comment.body.includes(appStageTag)) {
    logger.debug("[GitHub Webhook] commit_comment missing APP_STAGE tag", {
      commentId: comment.id,
      user: comment.user.login,
      expectedTag: appStageTag,
    });
    return;
  }

  const commitSha = comment.commit_id;
  const shortSha = commitSha.slice(0, 7);

  logger.set({ commentId: comment.id, user: comment.user.login, commitSha, shortSha });
  logger.info("[GitHub Webhook] Processing [refresh] comment");

  await recreateMachinesForAllProjects({
    db,
    env,
    shortSha,
    namePrefix: "refresh",
    extraMetadata: {
      triggeredBy: `commit_comment:${comment.id}`,
      triggeredByUser: comment.user.login,
    },
    logContext: " from comment",
  });
}
