import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import * as arctic from "arctic";
import * as jose from "jose";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { encrypt } from "../../utils/encryption.ts";

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
      const projectInfo = await tx.query.project.findFirst({
        where: eq(schema.project.id, projectId),
      });

      if (projectInfo) {
        const existingSecret = await tx.query.secret.findFirst({
          where: (s, { and: whereAnd, eq: whereEq, isNull: whereIsNull }) =>
            whereAnd(
              whereEq(s.key, "github.access_token"),
              whereEq(s.projectId, projectId),
              whereIsNull(s.userId), // Only match project-scoped secrets, not user-scoped
            ),
        });

        if (existingSecret) {
          await tx
            .update(schema.secret)
            .set({
              encryptedValue: encryptedAccessToken,
              lastSuccessAt: new Date(),
            })
            .where(eq(schema.secret.id, existingSecret.id));
        } else {
          await tx.insert(schema.secret).values({
            key: "github.access_token",
            encryptedValue: encryptedAccessToken,
            organizationId: projectInfo.organizationId,
            projectId,
            egressProxyRule: `$contains(url.hostname, 'github.com')`,
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
      (project ? `/orgs/${project.organization.slug}/projects/${project.slug}/repo` : "/");
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
