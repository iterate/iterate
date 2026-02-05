import { timingSafeEqual } from "node:crypto";
import jsonata from "jsonata";
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
import { createMachineForProject } from "../../services/machine-creation.ts";
import { trackWebhookEvent } from "../../lib/posthog.ts";

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

    const redirectPath =
      callbackURL ||
      (project ? `/orgs/${project.organization.slug}/projects/${project.slug}/connectors` : "/");
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
  try {
    const jwt = await generateGitHubAppJWT(env);

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Iterate-OS",
        },
      },
    );

    if (!response.ok) {
      logger.error(
        `Failed to get installation token for ${installationId}: ${response.status} ${await response.text()}`,
      );
      return null;
    }

    const data = (await response.json()) as { token: string; expires_at: string };
    return data.token;
  } catch (error) {
    logger.error(`Error getting installation token for ${installationId}:`, error);
    return null;
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

// JSONata filters for webhook events - evaluated against { payload, env }
// Return true to process the event, false to skip
const WEBHOOK_FILTERS = {
  // workflow_run: only process in prod when CI passes on main
  workflow_run: "env.APP_STAGE = 'prd' and payload.workflow_run.head_branch = 'main'",
  // commit_comment: require APP_STAGE=xxx tag in comment body to target specific environment
  commit_comment: `$contains(payload.comment.body, '[APP_STAGE=' & env.APP_STAGE & ']')`,
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

  // Track ALL webhooks in PostHog (non-blocking, before any filtering)
  const payload = JSON.parse(body);
  const repo = payload.repository as { full_name?: string } | undefined;
  trackWebhookEvent(c.env, {
    distinctId: `repo:${repo?.full_name ?? "unknown"}`,
    event: "github:webhook_received",
    properties: payload,
  });

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
    repository: z.object({
      full_name: z.string(),
    }),
  }),
  repository: z.object({
    full_name: z.string(),
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

/**
 * Handle a workflow_run event. Checks if this is an event we care about
 * and takes appropriate action.
 *
 * NOTE: This function could become an outbox consumer in the future.
 * The event is already persisted in the events table before this runs.
 */
async function handleWorkflowRun({ payload, db, env }: HandleWorkflowRunParams) {
  const { workflow_run } = payload;

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
  const snapshotName = `iterate-sandbox-${headSha}`;

  logger.info("[GitHub Webhook] Processing CI completion", {
    workflowRunId: workflow_run.id,
    headSha,
    snapshotName,
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
      const machineName = `ci-${headSha.slice(0, 7)}`;

      await createMachineForProject({
        db,
        env,
        projectId: project.id,
        organizationId: project.organizationId,
        organizationSlug: project.organization.slug,
        projectSlug: project.slug,
        name: machineName,
        type: activeMachine.type,
        metadata: {
          ...((activeMachine.metadata as Record<string, unknown>) ?? {}),
          snapshotName, // Override to use the CI-built snapshot
        },
      });

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
  const snapshotName = `iterate-sandbox-${commitSha}`;

  logger.info("[GitHub Webhook] Processing [refresh] comment", {
    commentId: comment.id,
    user: comment.user.login,
    commitSha,
    snapshotName,
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
      const machineName = `refresh-${commitSha.slice(0, 7)}`;

      await createMachineForProject({
        db,
        env,
        projectId: project.id,
        organizationId: project.organizationId,
        organizationSlug: project.organization.slug,
        projectSlug: project.slug,
        name: machineName,
        type: activeMachine.type,
        metadata: {
          ...((activeMachine.metadata as Record<string, unknown>) ?? {}),
          snapshotName,
          triggeredBy: `commit_comment:${comment.id}`,
          triggeredByUser: comment.user.login,
        },
      });

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
