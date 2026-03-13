import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import { eq } from "drizzle-orm";
import * as arctic from "arctic";
import * as jose from "jose";
import { Octokit } from "octokit";
import type { CloudflareEnv } from "../../../env.ts";
import { waitUntil } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { encrypt } from "../../utils/encryption.ts";
import { createDaemonClient } from "../../utils/daemon-orpc-client.ts";
import { stripMachineStateMetadata } from "../../utils/machine-metadata.ts";
import { createMachineForProject } from "../../services/machine-creation.ts";
import { buildMachineFetcher } from "../../services/machine-readiness-probe.ts";
import { trackWebhookEvent } from "../../lib/posthog.ts";
import type { ProjectSandboxProvider } from "../../utils/sandbox-providers.ts";
import { pokeRunningMachinesToRefresh } from "../../utils/poke-machines.ts";
import { outboxClient } from "../../outbox/client.ts";

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

type GitHubInstallationConflict = {
  installationId: number;
};

export function createGitHubClient(env: CloudflareEnv) {
  const redirectURI = `${env.VITE_PUBLIC_URL}/api/integrations/github/callback`;
  return new arctic.GitHub(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_CLIENT_SECRET, redirectURI);
}

export const githubApp = new Hono<{
  Bindings: CloudflareEnv;
  Variables: Variables;
}>();

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

    const userInfo = (await userResponse.json()) as {
      id: number;
      login: string;
    };

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
    const installationConflictState: { value: GitHubInstallationConflict | null } = { value: null };

    const project = await c.var.db.transaction(async (tx) => {
      const existingInstallationConnection = await tx.query.projectConnection.findFirst({
        where: (pc, { eq, and }) =>
          and(eq(pc.provider, "github-app"), eq(pc.externalId, installation_id.toString())),
      });

      if (
        existingInstallationConnection &&
        existingInstallationConnection.projectId !== projectId
      ) {
        installationConflictState.value = { installationId: installation_id };
        return tx.query.project.findFirst({
          where: eq(schema.project.id, projectId),
          with: {
            organization: true,
          },
        });
      }

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
        await tx
          .update(schema.project)
          .set({
            configRepoId: repo.id.toString(),
            configRepoFullName: repo.full_name,
            configRepoDefaultBranch: repo.default_branch,
          })
          .where(eq(schema.project.id, projectId));
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

    const installationConflict = installationConflictState.value;
    if (installationConflict) {
      const conflictToken = arctic.generateState();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await c.var.db.insert(schema.verification).values({
        identifier: conflictToken,
        value: JSON.stringify({
          kind: "github-installation-conflict",
          userId,
          projectId,
          installationId: installationConflict.installationId,
          githubUserId: userInfo.id,
          githubLogin: userInfo.login,
          encryptedAccessToken,
        }),
        expiresAt,
      });

      const params = new URLSearchParams({
        conflictToken,
      });
      return c.redirect(`/connection-conflict?${params.toString()}`);
    }

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
    const data = (await response.json()) as {
      token: string;
      expires_at: string;
    };
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

export type GitHubInstallationRepositoryPage = {
  repositories: GitHubRepository[];
  totalCount: number;
  page: number;
  perPage: number;
  hasNextPage: boolean;
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
  options?: { page?: number; perPage?: number },
): Promise<GitHubInstallationRepositoryPage> {
  const page = options?.page ?? 1;
  const perPage = options?.perPage ?? 10;
  const octokit = new Octokit({ auth: accessToken });
  const { data } = await octokit.request("GET /user/installations/{installation_id}/repositories", {
    installation_id: installationId,
    page,
    per_page: perPage,
    headers: {
      "x-github-api-version": "2022-11-28",
      "user-agent": "Iterate-OS",
    },
  });

  return {
    repositories: data.repositories.map(
      (repo: {
        id: number;
        name: string;
        full_name: string;
        owner: { login: string };
        default_branch: string;
        private: boolean;
      }) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        defaultBranch: repo.default_branch,
        isPrivate: repo.private,
      }),
    ),
    totalCount: data.total_count,
    page,
    perPage,
    hasNextPage: page * perPage < data.total_count,
  };
}

// ── Webhook Types ──────────────────────────────────────────────────

type WebhookEventParams<T = unknown> = {
  payload: T;
  db: DB;
  env: CloudflareEnv;
};

// ── Webhook Schemas ────────────────────────────────────────────────

const RepositoryPayload = z.object({
  full_name: z.string(),
  owner: z.object({ login: z.string() }).optional(),
  name: z.string().optional(),
});

type RepositoryPayload = z.infer<typeof RepositoryPayload>;

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

type GitHubRepoCoordinates = {
  owner: string;
  name: string;
  fullName: string;
};

const PushEvent = z.object({
  ref: z.string(),
  repository: RepositoryPayload,
});

type PushEvent = z.infer<typeof PushEvent>;

// ── Webhook App ────────────────────────────────────────────────────

githubApp.post("/webhook", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  const xGithubEvent = c.req.header("x-github-event");
  const deliveryId = c.req.header("x-github-delivery");

  logger.set({ githubWebhook: { deliveryId, event: xGithubEvent } });

  // Verify signature
  const isValid = await verifyGitHubSignature(c.env.GITHUB_WEBHOOK_SECRET, signature ?? null, body);
  logger.set({ githubWebhook: { isValid } });
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
  logger.set({ githubWebhook: { repoFullName, repoOwner, repoName } });

  // Track webhook in PostHog with group association (non-blocking).
  // TODO: move enrichment out of webhook path (tasks/machine-metrics-pipeline.md).
  const db = c.var.db;
  const env = c.env;
  waitUntil(
    (async () => {
      let groups: { organization: string; project: string } | undefined;

      // Look up project repo to get group association
      if (repoOwner && repoName) {
        const projectRecord = await db.query.project.findFirst({
          where: (project, { eq }) => eq(project.configRepoFullName, `${repoOwner}/${repoName}`),
          columns: { id: true, organizationId: true },
        });
        if (projectRecord) {
          groups = {
            organization: projectRecord.organizationId,
            project: projectRecord.id,
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

  const result = await outboxClient.send(db, {
    name: "github:webhook-received",
    payload: {
      deliveryId,
      event: eventType,
      action: typeof payload.action === "string" ? payload.action : null,
      payload,
    },
    deduplicationKey: `github:${eventType}:${externalId}`,
  });
  if (result.duplicate) {
    logger.debug("[GitHub Webhook] Duplicate delivery, skipping", {
      deliveryId,
    });
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

function parseGitRefBranch(ref: string): string | null {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) return null;
  return ref.slice(prefix.length);
}

function resolveRepoCoordinates(repository: {
  full_name?: string;
  owner?: { login?: string };
  name?: string;
}): GitHubRepoCoordinates | null {
  const fullName = repository.full_name;
  if (!fullName) return null;
  const split = fullName.split("/");
  const fallbackOwner = split[0]?.trim();
  const fallbackName = split[1]?.trim();

  const owner = repository.owner?.login?.trim() || fallbackOwner;
  const name = repository.name?.trim() || fallbackName;
  if (!owner || !name) return null;

  return { owner, name, fullName: `${owner}/${name}` };
}

async function listRepoMachineContexts(db: DB, repo: GitHubRepoCoordinates) {
  const projects = await db.query.project.findMany({
    where: (project, { eq: whereEq }) => whereEq(project.configRepoFullName, repo.fullName),
    columns: { id: true },
    with: {
      machines: {
        where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
        limit: 1,
      },
    },
  });

  return projects
    .map((project) => ({ projectId: project.id, machine: project.machines[0] }))
    .filter((row): row is { projectId: string; machine: typeof schema.machine.$inferSelect } =>
      Boolean(row.machine),
    );
}

async function listMachineContextsByInstallationId(db: DB, installationId: string) {
  const connections = await db.query.projectConnection.findMany({
    where: (pc, { and: whereAnd, eq: whereEq }) =>
      whereAnd(whereEq(pc.provider, "github-app"), whereEq(pc.externalId, installationId)),
    columns: { projectId: true },
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

  return connections
    .map((connection) => ({
      projectId: connection.projectId,
      machine: connection.project?.machines[0],
    }))
    .filter((row): row is { projectId: string; machine: typeof schema.machine.$inferSelect } =>
      Boolean(row.machine),
    );
}

async function forwardGithubWebhookToMachine(params: {
  machine: typeof schema.machine.$inferSelect;
  env: CloudflareEnv;
  eventType: string;
  deliveryId: string;
  payload: unknown;
}): Promise<void> {
  const fetcher = await buildMachineFetcher(params.machine, params.env, "GitHub Webhook");
  if (!fetcher) throw new Error("Could not build forward fetcher");

  const response = await fetcher("/api/integrations/github/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventType: params.eventType,
      deliveryId: params.deliveryId,
      payload: params.payload,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`Machine forward failed (${response.status}): ${body.slice(0, 500)}`);
  }
}

async function forwardWebhookToRepoMachine(params: {
  db: DB;
  env: CloudflareEnv;
  eventType: string;
  payload: unknown;
  deliveryId: string;
}): Promise<void> {
  if (!params.payload || typeof params.payload !== "object") return;
  const rawRepository = (params.payload as Record<string, unknown>).repository;
  if (!rawRepository || typeof rawRepository !== "object") return;

  const repo = resolveRepoCoordinates(rawRepository as Record<string, unknown>);
  if (!repo) return;

  let contexts = await listRepoMachineContexts(params.db, repo);
  let source: "repo" | "installation" = "repo";

  if (contexts.length === 0) {
    const installation = (params.payload as Record<string, unknown>).installation;
    const installationId =
      installation && typeof installation === "object"
        ? (installation as { id?: number | string }).id
        : undefined;

    if (installationId !== undefined && installationId !== null) {
      contexts = await listMachineContextsByInstallationId(params.db, String(installationId));
      source = "installation";
    }
  }

  const webhookContext = { contexts: contexts.length, source };

  if (contexts.length === 0) {
    logger.debug(`[GitHub Webhook] No active machine targets`, { githubWebhook: webhookContext });
    return;
  }

  const target = contexts[0];
  const targetContext = {
    ...webhookContext,
    targetProjectId: target.projectId,
    targetMachineId: target.machine.id,
  };
  try {
    await forwardGithubWebhookToMachine({
      machine: target.machine,
      env: params.env,
      eventType: params.eventType,
      deliveryId: params.deliveryId,
      payload: params.payload,
    });
    logger.debug("[GitHub Webhook] Forwarded webhook to machine", { githubWebhook: targetContext });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[GitHub Webhook] Failed to forward to machine: ${message} target=${JSON.stringify(targetContext)}`,
    );
  }
}

async function reloadConfigRepoOnMachine(params: {
  machine: typeof schema.machine.$inferSelect;
  env: CloudflareEnv;
}): Promise<void> {
  const metadata = params.machine.metadata as Record<string, unknown>;
  const runtime = await createMachineStub({
    type: params.machine.type,
    env: params.env,
    externalId: params.machine.externalId,
    metadata,
  });

  let fetcher: SandboxFetcher | undefined;
  try {
    fetcher = await runtime.getFetcher(3000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("No host port mapped for 8080")) {
      throw err;
    }
    logger.set({ machineId: params.machine.id, machineType: params.machine.type });
    logger.warn("[GitHub Webhook] Falling back to direct daemon base URL for config reload");
  }

  const baseUrl = await runtime.getBaseUrl(3000);
  const daemonClient = createDaemonClient({ baseUrl, fetcher });
  await daemonClient.daemon.configRepo.reload();
}

async function handlePushEvent({ payload, db, env }: WebhookEventParams<PushEvent>) {
  const branch = parseGitRefBranch(payload.ref);
  if (!branch) {
    logger.debug("[GitHub Webhook] Ignoring push event for non-branch ref", {
      ref: payload.ref,
    });
    return;
  }

  const projects = await db.query.project.findMany({
    where: (project, { and: whereAnd, eq: whereEq }) =>
      whereAnd(
        whereEq(project.configRepoFullName, payload.repository.full_name),
        whereEq(project.configRepoDefaultBranch, branch),
      ),
    columns: { id: true },
    with: {
      machines: {
        where: (machine, { eq: whereEq }) => whereEq(machine.state, "active"),
      },
    },
  });

  const targets = projects.flatMap((project) =>
    project.machines.map((machine) => ({ projectId: project.id, machine })),
  );

  if (targets.length === 0) {
    logger.debug("[GitHub Webhook] No active machines matched config repo push", {
      repo: payload.repository.full_name,
      branch,
    });
    return;
  }

  const reloadResults = await Promise.allSettled(
    targets.map((target) => reloadConfigRepoOnMachine({ machine: target.machine, env })),
  );

  let successCount = 0;
  let errorCount = 0;

  for (const [index, result] of reloadResults.entries()) {
    const target = targets[index];
    if (result.status === "fulfilled") {
      successCount++;
      continue;
    }

    errorCount++;
    logger.error("[GitHub Webhook] Failed config repo reload on machine", {
      projectId: target.projectId,
      machineId: target.machine.id,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  }

  logger.set({
    repo: payload.repository.full_name,
    branch,
    targetCount: targets.length,
    successCount,
    errorCount,
  });
  logger.info("[GitHub Webhook] Config repo push reload complete");
}

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

const lifecycleEventHandlers: Record<
  string,
  {
    schema: z.ZodTypeAny;
    handle: (payload: unknown, db: DB, env: CloudflareEnv) => Promise<void>;
  }
> = {
  push: {
    schema: PushEvent,
    handle: (payload, db, env) => handlePushEvent({ payload: payload as PushEvent, db, env }),
  },
  commit_comment: {
    schema: CommitCommentEvent,
    handle: (payload, db, env) =>
      handleCommitComment({ payload: payload as CommitCommentEvent, db, env }),
  },
};

async function processGitHubWebhookEvent(params: {
  eventType: string;
  payload: unknown;
  deliveryId: string;
  db: DB;
  env: CloudflareEnv;
}): Promise<void> {
  try {
    await forwardWebhookToRepoMachine(params);
  } catch (err) {
    logger.error("[GitHub Webhook] Forwarding failed; continuing lifecycle handlers", {
      eventType: params.eventType,
      deliveryId: params.deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const lifecycleHandler = lifecycleEventHandlers[params.eventType];
  if (!lifecycleHandler) {
    logger.debug("[GitHub Webhook] Ignoring non-recreation event", {
      eventType: params.eventType,
      deliveryId: params.deliveryId,
    });
    return;
  }

  const parsed = lifecycleHandler.schema.safeParse(params.payload);
  if (!parsed.success) {
    logger.error(
      `[GitHub Webhook] ${params.eventType} ${params.deliveryId} parse error: ${z.prettifyError(parsed.error)}`,
    );
    return;
  }

  await lifecycleHandler.handle(parsed.data, params.db, params.env);
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

  logger.set({
    commentId: comment.id,
    user: comment.user.login,
    commitSha,
    shortSha,
  });
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
