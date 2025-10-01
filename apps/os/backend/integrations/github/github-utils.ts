import { createPrivateKey, createHmac } from "crypto";
import { SignJWT } from "jose";
import { eq, and } from "drizzle-orm";
import { waitUntil } from "cloudflare:workers";
import { env } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import * as schemas from "../../db/schema.ts";
import type { CloudflareEnv } from "../../../env.ts";
import { runConfigInSandbox } from "../../sandbox/run-config.ts";
import { signUrl } from "../../utils/url-signing.ts";
import { logger as console } from "../../tag-logger.ts";
import { invalidateOrganizationQueries } from "../../utils/websocket-utils.ts";

export const generateGithubJWT = async () => {
  const alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  const key = createPrivateKey({
    key: env.GITHUB_APP_PRIVATE_KEY,
    format: "pem",
  });

  return await new SignJWT({})
    .setProtectedHeader({ alg, typ: "JWT" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(env.GITHUB_APP_CLIENT_ID)
    .sign(key);
};

export const getGithubInstallationForEstate = async (db: DB, estateId: string) => {
  const [githubInstallation] = await db
    .select({
      accountId: schemas.account.accountId,
      accessToken: schemas.account.accessToken,
      refreshToken: schemas.account.refreshToken,
      accessTokenExpiresAt: schemas.account.accessTokenExpiresAt,
    })
    .from(schemas.estateAccountsPermissions)
    .innerJoin(schemas.account, eq(schemas.estateAccountsPermissions.accountId, schemas.account.id))
    .where(
      and(
        eq(schemas.estateAccountsPermissions.estateId, estateId),
        eq(schemas.account.providerId, "github-app"),
      ),
    )
    .limit(1);

  return githubInstallation;
};

export const getGithubRepoForEstate = async (db: DB, estateId: string) => {
  const [estate] = await db
    .select({
      connectedRepoId: schemas.estate.connectedRepoId,
      connectedRepoRef: schemas.estate.connectedRepoRef,
      connectedRepoPath: schemas.estate.connectedRepoPath,
    })
    .from(schemas.estate)
    .where(eq(schemas.estate.id, estateId));

  if (!estate || !estate.connectedRepoId) {
    return null;
  }

  return estate;
};

export const getEstateByRepoId = async (db: DB, repoId: number) => {
  const [estate] = await db
    .select({
      id: schemas.estate.id,
      name: schemas.estate.name,
      connectedRepoRef: schemas.estate.connectedRepoRef,
      connectedRepoPath: schemas.estate.connectedRepoPath,
    })
    .from(schemas.estate)
    .where(eq(schemas.estate.connectedRepoId, repoId));

  return estate;
};

export const validateGithubWebhookSignature = (
  payload: string,
  signature: string | null,
  secret: string,
): boolean => {
  if (!signature) return false;

  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  const expectedSignature = `sha256=${hmac.digest("hex")}`;

  // Timing-safe comparison
  return signature === expectedSignature;
};

export const getGithubInstallationToken = async (installationId: string) => {
  const jwt = await generateGithubJWT();

  const tokenRes = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "Iterate OS",
      },
    },
  );

  if (!tokenRes.ok) {
    throw new Error(`Failed to fetch installation token: ${tokenRes.statusText}`);
  }

  const { token } = (await tokenRes.json()) as { token: string };
  return token;
};

// Helper function to trigger a GitHub estate build
export async function triggerGithubBuild(params: {
  db: DB;
  env: CloudflareEnv;
  estateId: string;
  commitHash: string;
  commitMessage: string;
  repoUrl: string;
  installationToken: string;
  workingDirectory?: string;
  branch?: string;
  webhookId?: string;
  workflowRunId?: string;
  isManual?: boolean;
}) {
  const {
    db,
    env,
    estateId,
    commitHash,
    commitMessage,
    repoUrl,
    installationToken,
    workingDirectory,
    branch,
    webhookId,
    workflowRunId,
    isManual = false,
  } = params;

  // Create a new build record
  const [build] = await db
    .insert(schemas.builds)
    .values({
      status: "in_progress",
      commitHash,
      commitMessage: isManual ? `[Manual] ${commitMessage}` : commitMessage,
      webhookIterateId: webhookId || `${isManual ? "manual" : "auto"}-${Date.now()}`,
      estateId,
      iterateWorkflowRunId: workflowRunId,
    })
    .returning();

  // Get the organization ID for WebSocket invalidation (needed for error cases)
  const estateWithOrg = await db.query.estate.findFirst({
    where: eq(schemas.estate.id, estateId),
    with: {
      organization: true,
    },
  });

  // Generate a signed callback URL
  let baseUrl = env.VITE_PUBLIC_URL.replace("iterate.com", "iterateproxy.com");
  // If it's localhost, use the ngrok dev URL instead
  if (baseUrl.includes("localhost")) {
    baseUrl = `https://${env.ITERATE_USER}.dev.iterate.com`;
  }
  const callbackUrl = await signUrl(
    `${baseUrl}/api/build/callback`,
    env.EXPIRING_URLS_SIGNING_KEY,
    60 * 60, // 1 hour expiry
  );

  // Run the build in the background with error handling
  const buildPromise = (async () => {
    try {
      const result = await runConfigInSandbox(env, {
        githubRepoUrl: repoUrl,
        githubToken: installationToken,
        commitHash,
        branch,
        workingDirectory: workingDirectory || "/",
        callbackUrl,
        buildId: build.id,
        estateId,
      });

      // If the sandbox failed to start, update the build status
      if ("error" in result) {
        await db
          .update(schemas.builds)
          .set({
            status: "failed",
            completedAt: new Date(),
            output: {
              stdout: "",
              stderr: result.details ? `${result.error}: ${result.details}` : result.error,
              exitCode: 1,
            },
          })
          .where(eq(schemas.builds.id, build.id));

        // Invalidate organization queries to show the failed build
        if (estateWithOrg?.organization) {
          await invalidateOrganizationQueries(env, estateWithOrg.organization.id, {
            type: "INVALIDATE",
            invalidateInfo: {
              type: "TRPC_QUERY",
              paths: ["estate.getBuilds"],
            },
          });
        }
      }

      return result;
    } catch (error) {
      console.error("Build execution failed:", error);
      await db
        .update(schemas.builds)
        .set({
          status: "failed",
          completedAt: new Date(),
          output: {
            stdout: "",
            stderr: error instanceof Error ? error.message : "Unknown error occurred",
            exitCode: 1,
          },
        })
        .where(eq(schemas.builds.id, build.id));

      // Invalidate organization queries to show the failed build
      if (estateWithOrg?.organization) {
        await invalidateOrganizationQueries(env, estateWithOrg.organization.id, {
          type: "INVALIDATE",
          invalidateInfo: {
            type: "TRPC_QUERY",
            paths: ["estate.getBuilds"],
          },
        });
      }

      throw error;
    }
  })();

  // Use waitUntil to run in background (won't throw if not in request context)
  try {
    waitUntil(buildPromise);
  } catch {
    // If waitUntil is not available (e.g., in tests), just await the promise
    await buildPromise;
  }

  return build;
}
