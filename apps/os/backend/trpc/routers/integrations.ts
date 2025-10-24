import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { generateRandomString } from "better-auth/crypto";
import { TRPCError } from "@trpc/server";
import { WebClient } from "@slack/web-api";
import { Octokit } from "octokit";
import { estateProtectedProcedure, protectedProcedure, router } from "../trpc.ts";
import { account, organizationUserMembership, estateAccountsPermissions } from "../../db/schema.ts";
import * as schemas from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import {
  generateGithubJWT,
  getGithubInstallationForEstate,
  getGithubRepoForEstate,
  getGithubInstallationToken,
} from "../../integrations/github/github-utils.ts";
import { MCPParam } from "../../agent/tool-schemas.ts";
import { getMCPVerificationKey } from "../../agent/mcp/mcp-oauth-provider.ts";
import {
  getGithubUserAccessTokenForEstate,
  getSlackAccessTokenForEstate,
} from "../../auth/token-utils.ts";
import { getAgentStubByName, toAgentClassName } from "../../agent/agents/stub-getters.ts";
import { startSlackAgentInChannel } from "../../agent/start-slack-agent-in-channel.ts";
import { AdvisoryLocker } from "../../durable-objects/advisory-locker.ts";

// Define the integration providers we support
const INTEGRATION_PROVIDERS = {
  "github-app": {
    name: "GitHub App",
    description: "Install the GitHub app to your estate",
    icon: "github",
  },
  "slack-bot": {
    name: "Slack",
    description: "Connect Slack to your estate",
    icon: "slack",
  },
  google: {
    name: "Google",
    description: "Connect to your Google account",
    icon: "google",
  },
} as const;

// Helper function to get current user's estate ID
export const getCurrentUserEstateId = async (db: any, userId: string): Promise<string | null> => {
  const userWithEstate = await db.query.organizationUserMembership.findFirst({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: {
        with: {
          estates: {
            limit: 1,
          },
        },
      },
    },
  });

  return userWithEstate?.organization?.estates?.[0]?.id || null;
};

export const integrationsRouter = router({
  // Get all integrations with their connection status
  list: estateProtectedProcedure.query(async ({ ctx, input }) => {
    const estateId = input.estateId;

    // Fetch estate-wide account connections
    const estateAccounts = await ctx.db.query.estateAccountsPermissions.findMany({
      where: eq(estateAccountsPermissions.estateId, estateId),
      with: {
        account: true,
      },
    });

    // Fetch personal account connections (directly linked to user)
    const personalAccounts = await ctx.db
      .select()
      .from(account)
      .where(eq(account.userId, ctx.user.id));

    const knownOAuthProviders = ["github-app", "slack-bot", "google", "slack"];

    // Group accounts by provider and track connection type
    const accountsByProvider: Record<
      string,
      { account: typeof account.$inferSelect; isEstateWide: boolean }[]
    > = {};

    // Add estate-wide accounts
    estateAccounts.forEach(({ account: acc_item }) => {
      // Skip if account is null (orphaned permission record)
      if (!acc_item) return;
      if (!accountsByProvider[acc_item.providerId]) {
        accountsByProvider[acc_item.providerId] = [];
      }
      accountsByProvider[acc_item.providerId]!.push({
        account: acc_item,
        isEstateWide: true,
      });
    });

    // Add personal accounts (only if not already in estate-wide)
    personalAccounts.forEach((acc_item) => {
      if (!acc_item) return;
      if (!accountsByProvider[acc_item.providerId]) {
        accountsByProvider[acc_item.providerId] = [];
      }

      // Check if this account is already in estate-wide connections
      const isAlreadyEstateWide = estateAccounts.some(
        ({ account: estateAcc }) => estateAcc?.id === acc_item.id,
      );

      if (!isAlreadyEstateWide) {
        accountsByProvider[acc_item.providerId]!.push({
          account: acc_item,
          isEstateWide: false,
        });
      }
    });

    // Map to integration format
    const integrations = Object.entries(INTEGRATION_PROVIDERS).map(([providerId, provider]) => {
      const connections = accountsByProvider[providerId] || [];
      const latestConnection = connections[0]?.account; // Get the most recent connection
      const hasEstateWide = connections.some((conn) => conn.isEstateWide);
      const hasPersonal = connections.some((conn) => !conn.isEstateWide);

      return {
        id: providerId,
        name: provider.name,
        description: provider.description,
        icon: provider.icon,
        connections: connections.length,
        isConnected: connections.length > 0,
        isEstateWide: hasEstateWide,
        isPersonal: hasPersonal,
        scope: latestConnection?.scope || null,
        connectedAt: latestConnection?.createdAt || null,
        accessTokenExpiresAt: latestConnection?.accessTokenExpiresAt || null,
      };
    });

    // Get MCP connections
    // 1. Get param-based MCP connections from mcpConnectionParam
    const mcpParams = await ctx.db.query.mcpConnectionParam.findMany({
      where: eq(schemas.mcpConnectionParam.estateId, estateId),
    });

    // Group by connectionKey
    const mcpParamsByKey = mcpParams.reduce(
      (acc, param) => {
        if (!acc[param.connectionKey]) {
          acc[param.connectionKey] = {
            connectionKey: param.connectionKey,
            params: [],
            createdAt: param.createdAt,
          };
        }
        acc[param.connectionKey].params.push({
          key: param.paramKey,
          type: param.paramType,
        });
        // Keep the earliest createdAt
        if (param.createdAt < acc[param.connectionKey].createdAt) {
          acc[param.connectionKey].createdAt = param.createdAt;
        }
        return acc;
      },
      {} as Record<
        string,
        { connectionKey: string; params: Array<{ key: string; type: string }>; createdAt: Date }
      >,
    );

    // 2. Get OAuth-based MCP connections (accounts with providerId not in known list)
    // OAuth connections are always personal since they're user-specific authentication
    const mcpOAuthConnections = [
      ...estateAccounts
        .filter(({ account: acc }) => acc && !knownOAuthProviders.includes(acc.providerId))
        .map(({ account: acc }) => ({
          type: "mcp-oauth" as const,
          id: acc!.id,
          name: acc!.providerId,
          providerId: acc!.providerId,
          mode: "personal" as const,
          scope: acc!.scope,
          connectedAt: acc!.createdAt,
        })),
      ...personalAccounts
        .filter((acc) => !knownOAuthProviders.includes(acc.providerId))
        .filter((acc) => !estateAccounts.some(({ account: estateAcc }) => estateAcc?.id === acc.id))
        .map((acc) => ({
          type: "mcp-oauth" as const,
          id: acc.id,
          name: acc.providerId,
          providerId: acc.providerId,
          mode: "personal" as const,
          scope: acc.scope,
          connectedAt: acc.createdAt,
        })),
    ];

    // Format param-based MCP connections
    const mcpParamConnections = Object.values(mcpParamsByKey).map((conn) => {
      const [serverUrl, mode, userId] = conn.connectionKey.split("::");
      let displayName = serverUrl;
      try {
        displayName = new URL(serverUrl).hostname;
      } catch {
        // If URL parsing fails, use serverUrl as is
      }

      return {
        type: "mcp-params" as const,
        id: conn.connectionKey,
        name: displayName,
        serverUrl,
        mode,
        userId: userId || null,
        paramCount: conn.params.length,
        connectedAt: conn.createdAt,
      };
    });

    return {
      oauthIntegrations: integrations,
      mcpConnections: [...mcpOAuthConnections, ...mcpParamConnections],
    };
  }),

  // Get details for a specific integration
  get: estateProtectedProcedure
    .input(
      z.object({
        providerId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const estateId = input.estateId;

      // Fetch estate-wide account connections for this provider
      const estateAccounts = await ctx.db.query.estateAccountsPermissions.findMany({
        where: eq(estateAccountsPermissions.estateId, estateId),
        with: {
          account: true,
        },
      });

      const provider =
        INTEGRATION_PROVIDERS[input.providerId as keyof typeof INTEGRATION_PROVIDERS];
      if (!provider) {
        throw new Error(`Unknown provider: ${input.providerId}`);
      }

      const accounts = estateAccounts
        .filter(({ account: acc }) => acc && acc.providerId === input.providerId)
        .map(({ account: acc }) => acc!);

      return {
        id: input.providerId,
        name: provider.name,
        description: provider.description,
        icon: provider.icon,
        connections: accounts.length,
        accounts: accounts.map((acc) => ({
          id: acc.id,
          accountId: acc.accountId,
          scope: acc.scope,
          createdAt: acc.createdAt,
          accessTokenExpiresAt: acc.accessTokenExpiresAt,
        })),
        isConnected: accounts.length > 0,
      };
    }),
  // Make it work
  // TODO: Make this good later
  startGithubAppInstallFlow: estateProtectedProcedure
    .input(
      z.object({
        callbackURL: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const state = generateRandomString(32);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      const { estateId, callbackURL } = input;

      const redirectUri = `${ctx.env.VITE_PUBLIC_URL}/api/integrations/github/callback`;
      const data = JSON.stringify({
        userId: ctx.user.id,
        estateId,
        redirectUri,
        callbackURL,
      });

      await ctx.db.insert(schemas.verification).values({
        identifier: state,
        value: data,
        expiresAt,
      });

      const installationUrl = `https://github.com/apps/${ctx.env.GITHUB_APP_SLUG}/installations/new?state=${state}&redirect_uri=${redirectUri}`;

      return {
        installationUrl,
      };
    }),
  listAvailableGithubRepos: estateProtectedProcedure.query(async ({ ctx, input }) => {
    const { estateId } = input;
    const githubInstallation = await getGithubInstallationForEstate(ctx.db, estateId);

    if (!githubInstallation) {
      // Return empty array instead of throwing - this is a normal state when GitHub isn't connected
      return [];
    }

    const token = await getGithubInstallationToken(githubInstallation.accountId);

    // If there is no token, that means the installation has been deleted
    if (!token) {
      return [];
    }

    // GitHub API schema for paginated repository response
    const GitHubReposResponse = z.object({
      total_count: z.number(),
      repositories: z.array(
        z.object({
          id: z.number(),
          full_name: z.string(),
          private: z.boolean(),
        }),
      ),
    });

    const allRepos: z.infer<typeof GitHubReposResponse>["repositories"] = [];
    let page = 1;
    const perPage = 100; // Maximum allowed by GitHub
    let hasMore = true;

    // Fetch all pages of repositories
    while (hasMore) {
      const availableRepos = await fetch(
        `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "Iterate OS",
            Accept: "application/vnd.github+json",
          },
        },
      );

      if (!availableRepos.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch available repositories",
        });
      }

      const reposData = GitHubReposResponse.parse(await availableRepos.json());
      allRepos.push(...reposData.repositories);

      // Check if there are more pages
      // GitHub returns total_count, so we can check if we've fetched all
      hasMore = allRepos.length < reposData.total_count;
      page++;

      // Safety check to prevent infinite loops (max 10 pages = 1000 repos)
      if (page > 10) {
        logger.warn(`Stopping repository fetch at page ${page - 1} to prevent excessive API calls`);
        break;
      }
    }

    return allRepos;
  }),
  getGithubRepoForEstate: estateProtectedProcedure.query(async ({ ctx, input }) => {
    const { estateId } = input;
    const githubRepo = await getGithubRepoForEstate(ctx.db, estateId);
    if (!githubRepo) return null;

    // Get the GitHub installation to fetch the repository details
    const githubInstallation = await getGithubInstallationForEstate(ctx.db, estateId);
    let repoName: string | null = null;
    let repoFullName: string | null = null;

    let token: string | null = null;
    if (githubInstallation) token = await getGithubInstallationToken(githubInstallation.accountId);
    // If no installation token is found, use the fallback token
    if (!token) token = ctx.env.GITHUB_ESTATES_TOKEN;

    // Fetch repository details from GitHub API
    const repoResponse = await fetch(
      `https://api.github.com/repositories/${githubRepo.connectedRepoId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "Iterate OS",
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (repoResponse.ok) {
      const repoData = (await repoResponse.json()) as { name: string; full_name: string };
      repoName = repoData.name;
      repoFullName = repoData.full_name;
    } else {
      logger.error(
        `Failed to fetch repository details: ${repoResponse.status} ${repoResponse.statusText}`,
      );
    }

    return {
      repoId: githubRepo.connectedRepoId,
      repoName,
      repoFullName,
      branch: githubRepo.connectedRepoRef || "main",
      path: githubRepo.connectedRepoPath || "/",
    };
  }),

  setGithubRepoForEstate: estateProtectedProcedure
    .input(
      z.object({
        repoId: z.number(),
        branch: z.string().optional().default("main"),
        path: z.string().optional().default("/"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, repoId, branch, path } = input;

      const githubInstallation = await getGithubInstallationForEstate(ctx.db, estateId);
      if (!githubInstallation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "GitHub installation not found, make sure you have Github integrated before connecting a repository",
        });
      }

      const installationToken = await getGithubInstallationToken(githubInstallation.accountId);
      if (!installationToken) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Failed to get installation token, please re-authenticate Github integration",
        });
      }

      const oc = new Octokit({ auth: installationToken });

      const repo = await oc.request("GET /repositories/:id", { id: repoId });
      if (repo.status !== 200) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Failed to fetch repository details",
        });
      }
      const repoData = z
        .object({
          name: z.string(),
          owner: z.object({
            login: z.string(),
          }),
        })
        .parse(repo.data);

      await ctx.db
        .update(schemas.estate)
        .set({
          connectedRepoId: repoId,
          connectedRepoRef: branch,
          connectedRepoPath: path,
        })
        .where(eq(schemas.estate.id, estateId));

      const branchData = await oc.rest.repos.getBranch({
        owner: repoData.owner.login,
        repo: repoData.name,
        branch,
      });

      if (branchData.status !== 200) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Failed to fetch branch details for branch ${branch}`,
        });
      }

      const commitHash = branchData.data.commit.sha;
      const commitMessage = branchData.data.commit.commit.message;

      if (commitHash && commitMessage) {
        // Import and use the helper function to trigger a build
        const { triggerEstateRebuild } = await import("./estate.ts");
        await triggerEstateRebuild({
          db: ctx.db,
          env: ctx.env,
          estateId,
          commitHash,
          commitMessage,
          isManual: false, // This is an automatic build
        });
      }

      return {
        success: true,
      };
    }),
  disconnectGithubRepo: estateProtectedProcedure
    .input(
      z.object({
        deleteInstallation: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, deleteInstallation } = input;

      await ctx.db
        .update(schemas.estate)
        .set({
          connectedRepoId: null,
          connectedRepoRef: null,
          connectedRepoPath: null,
        })
        .where(eq(schemas.estate.id, estateId));

      if (deleteInstallation) {
        const githubInstallation = await getGithubInstallationForEstate(ctx.db, estateId);

        if (githubInstallation) {
          await ctx.db
            .delete(schemas.account)
            .where(
              and(
                eq(schemas.account.accountId, githubInstallation.accountId),
                eq(schemas.account.providerId, "github-app"),
              ),
            );
        }
      }
      return {
        success: true,
      };
    }),

  // Disconnect an integration from the estate or personal account
  disconnect: estateProtectedProcedure
    .input(
      z.object({
        providerId: z.string(),
        disconnectType: z.enum(["estate", "personal", "both"]).default("both"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, providerId, disconnectType } = input;
      let estateDisconnected = 0;
      let personalDisconnected = 0;

      // Handle estate-wide disconnection
      if (disconnectType === "estate" || disconnectType === "both") {
        // Find all accounts for this provider connected to this estate
        const estateAccounts = await ctx.db.query.estateAccountsPermissions.findMany({
          where: eq(estateAccountsPermissions.estateId, estateId),
          with: {
            account: true,
          },
        });

        const estateAccountsToDisconnect = estateAccounts.filter(
          ({ account: acc }) => acc && acc.providerId === providerId,
        );

        if (estateAccountsToDisconnect.length > 0) {
          // Delete estate permissions for these accounts
          const accountIds = estateAccountsToDisconnect.map(({ account: acc }) => acc!.id);
          await ctx.db
            .delete(estateAccountsPermissions)
            .where(
              and(
                eq(estateAccountsPermissions.estateId, estateId),
                inArray(estateAccountsPermissions.accountId, accountIds),
              ),
            );
          estateDisconnected = accountIds.length;

          // For GitHub integrations, also clear the connected repo information and revoke the installation
          if (providerId === "github-app") {
            // Clear the connected repo information
            await ctx.db
              .update(schemas.estate)
              .set({
                connectedRepoId: null,
                connectedRepoRef: null,
                connectedRepoPath: null,
              })
              .where(eq(schemas.estate.id, estateId));

            // Always revoke the GitHub app installation
            for (const { account: acc } of estateAccountsToDisconnect) {
              if (acc && acc.providerId === "github-app" && acc.accountId) {
                try {
                  // Generate JWT for authentication
                  const jwt = await generateGithubJWT();

                  // Call GitHub API to delete the installation
                  const deleteResponse = await fetch(
                    `https://api.github.com/app/installations/${acc.accountId}`,
                    {
                      method: "DELETE",
                      headers: {
                        Accept: "application/vnd.github+json",
                        Authorization: `Bearer ${jwt}`,
                        "X-GitHub-Api-Version": "2022-11-28",
                        "User-Agent": "Iterate OS",
                      },
                    },
                  );

                  if (!deleteResponse.ok && deleteResponse.status !== 404) {
                    // Log error but don't fail the disconnection
                    logger.error(
                      `Failed to revoke GitHub installation ${acc.accountId}: ${deleteResponse.status} ${deleteResponse.statusText}`,
                    );
                  } else if (deleteResponse.ok) {
                    logger.log(`Successfully revoked GitHub installation ${acc.accountId}`);
                  }
                } catch (error) {
                  // Log error but don't fail the disconnection
                  logger.error(`Error revoking GitHub installation ${acc.accountId}:`, error);
                }
              }
            }
          }

          // Clean up orphaned accounts
          for (const accountId of accountIds) {
            const otherEstatePermissions = await ctx.db.query.estateAccountsPermissions.findFirst({
              where: eq(estateAccountsPermissions.accountId, accountId),
            });

            // If this account is not used by any other estate and belongs to the current user, delete it
            const acc = estateAccountsToDisconnect.find(
              (ea) => ea.account?.id === accountId,
            )?.account;
            if (!otherEstatePermissions && acc?.userId === ctx.user.id) {
              await ctx.db.delete(account).where(eq(account.id, accountId));
            }
          }
        }
      }

      // Handle personal disconnection
      if (disconnectType === "personal" || disconnectType === "both") {
        // Find personal accounts for this provider (directly linked to user, not necessarily to estate)
        const personalAccounts = await ctx.db
          .select()
          .from(account)
          .where(and(eq(account.userId, ctx.user.id), eq(account.providerId, providerId)));

        if (personalAccounts.length > 0) {
          // For personal accounts, we need to check if they're used by any estate
          for (const personalAccount of personalAccounts) {
            // Check if this account is used by any estate
            const estatePermissions = await ctx.db.query.estateAccountsPermissions.findFirst({
              where: eq(estateAccountsPermissions.accountId, personalAccount.id),
            });

            // Only delete if not used by any estate (or if we're also disconnecting from estate)
            if (!estatePermissions || disconnectType === "both") {
              // First remove any estate permissions if they exist
              if (estatePermissions) {
                await ctx.db
                  .delete(estateAccountsPermissions)
                  .where(eq(estateAccountsPermissions.accountId, personalAccount.id));
              }

              // Note: We don't revoke GitHub installations for personal disconnections
              // GitHub installations belong to GitHub accounts/orgs, not to individual users in our system

              // Delete the account record from our database
              await ctx.db.delete(account).where(eq(account.id, personalAccount.id));
              personalDisconnected++;
            }
          }
        }
      }

      if (estateDisconnected === 0 && personalDisconnected === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No ${providerId} integration found to disconnect`,
        });
      }

      return {
        success: true,
        estateDisconnected,
        personalDisconnected,
        totalDisconnected: estateDisconnected + personalDisconnected,
      };
    }),

  disconnectMCP: estateProtectedProcedure
    .input(
      z.object({
        connectionId: z.string(),
        connectionType: z.enum(["mcp-oauth", "mcp-params"]),
        mode: z.enum(["company", "personal"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, connectionId, connectionType } = input;

      if (connectionType === "mcp-params") {
        // Delete from mcpConnectionParam table
        await ctx.db
          .delete(schemas.mcpConnectionParam)
          .where(eq(schemas.mcpConnectionParam.connectionKey, connectionId));
      } else {
        // Delete from account table (OAuth)
        // First check if this account is linked to this estate
        const estatePermission = await ctx.db.query.estateAccountsPermissions.findFirst({
          where: and(
            eq(estateAccountsPermissions.estateId, estateId),
            eq(estateAccountsPermissions.accountId, connectionId),
          ),
        });

        // Remove estate permission if it exists
        if (estatePermission) {
          await ctx.db
            .delete(estateAccountsPermissions)
            .where(
              and(
                eq(estateAccountsPermissions.estateId, estateId),
                eq(estateAccountsPermissions.accountId, connectionId),
              ),
            );
        }

        // Check if account is used by other estates
        const otherEstates = await ctx.db.query.estateAccountsPermissions.findFirst({
          where: eq(estateAccountsPermissions.accountId, connectionId),
        });

        // Only delete the account if it's not used by any other estate
        if (!otherEstates) {
          const acc = await ctx.db.query.account.findFirst({
            where: eq(account.id, connectionId),
          });

          if (acc && acc.userId === ctx.user.id) {
            await ctx.db.transaction(async (tx) => {
              const clientInfo = await tx.query.dynamicClientInfo.findFirst({
                where: and(
                  eq(schemas.dynamicClientInfo.providerId, acc.providerId),
                  eq(schemas.dynamicClientInfo.userId, ctx.user.id),
                ),
              });
              if (clientInfo) {
                const verificationKey = getMCPVerificationKey(acc.providerId, clientInfo.clientId);

                await tx
                  .delete(schemas.verification)
                  .where(eq(schemas.verification.identifier, verificationKey));
                await tx
                  .delete(schemas.dynamicClientInfo)
                  .where(eq(schemas.dynamicClientInfo.id, clientInfo.id));
              }

              await tx.delete(account).where(eq(account.id, connectionId));
            });
          }
        }
      }

      return { success: true };
    }),

  getMCPConnectionDetails: estateProtectedProcedure
    .input(
      z.object({
        connectionId: z.string(),
        connectionType: z.enum(["mcp-oauth", "mcp-params"]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { estateId, connectionId, connectionType } = input;

      if (connectionType === "mcp-params") {
        // Get params for param-based connection
        const params = await ctx.db.query.mcpConnectionParam.findMany({
          where: and(
            eq(schemas.mcpConnectionParam.estateId, estateId),
            eq(schemas.mcpConnectionParam.connectionKey, connectionId),
          ),
        });

        return {
          type: "params" as const,
          params: params.map((p) => ({
            key: p.paramKey,
            value: p.paramValue,
            type: p.paramType,
          })),
        };
      } else {
        // Get dynamic client info for OAuth connection
        const acc = await ctx.db.query.account.findFirst({
          where: eq(account.id, connectionId),
        });

        if (!acc) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Connection not found",
          });
        }

        const dynamicClient = await ctx.db.query.dynamicClientInfo.findFirst({
          where: and(
            eq(schemas.dynamicClientInfo.providerId, acc.providerId),
            eq(schemas.dynamicClientInfo.userId, acc.userId),
          ),
        });

        return {
          type: "oauth" as const,
          providerId: acc.providerId,
          scope: acc.scope,
          clientInfo: dynamicClient?.clientInfo || null,
          connectedAt: acc.createdAt,
        };
      }
    }),

  updateMCPConnectionParams: estateProtectedProcedure
    .input(
      z.object({
        connectionKey: z.string(),
        params: z.array(
          z.object({
            key: z.string(),
            value: z.string(),
            type: z.enum(["header", "query_param"]),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, connectionKey, params } = input;

      await ctx.db.transaction(async (tx) => {
        // Delete existing params
        await tx
          .delete(schemas.mcpConnectionParam)
          .where(
            and(
              eq(schemas.mcpConnectionParam.estateId, estateId),
              eq(schemas.mcpConnectionParam.connectionKey, connectionKey),
            ),
          );

        // Insert new params
        if (params.length > 0) {
          await tx.insert(schemas.mcpConnectionParam).values(
            params.map((param) => ({
              estateId,
              connectionKey,
              paramKey: param.key,
              paramValue: param.value,
              paramType: param.type,
            })),
          );
        }
      });

      return { success: true };
    }),

  saveMCPConnectionParams: estateProtectedProcedure
    .input(
      z.object({
        connectionKey: z.string(),
        params: z.array(
          z.object({
            key: z.string(),
            value: z.string(),
            type: z.enum(["header", "query_param"]),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, connectionKey, params } = input;

      await ctx.db.transaction(async (tx) => {
        if (params.length > 0) {
          const paramValues = params.map((param) => ({
            estateId,
            connectionKey,
            paramKey: param.key,
            paramValue: param.value,
            paramType: param.type,
          }));

          await tx
            .insert(schemas.mcpConnectionParam)
            .values(paramValues)
            .onConflictDoUpdate({
              target: [
                schemas.mcpConnectionParam.estateId,
                schemas.mcpConnectionParam.connectionKey,
                schemas.mcpConnectionParam.paramKey,
                schemas.mcpConnectionParam.paramType,
              ],
              set: {
                paramValue: sql`excluded.param_value`,
                updatedAt: new Date(),
              },
            });

          const currentParamKeys = params.map((p) => `${p.key}:${p.type}`);
          const existingParams = await tx.query.mcpConnectionParam.findMany({
            where: and(
              eq(schemas.mcpConnectionParam.estateId, estateId),
              eq(schemas.mcpConnectionParam.connectionKey, connectionKey),
            ),
          });

          const paramsToDelete = existingParams.filter(
            (existing) => !currentParamKeys.includes(`${existing.paramKey}:${existing.paramType}`),
          );

          if (paramsToDelete.length > 0) {
            const idsToDelete = paramsToDelete.map((p) => p.id);
            await tx
              .delete(schemas.mcpConnectionParam)
              .where(inArray(schemas.mcpConnectionParam.id, idsToDelete));
          }
        } else {
          await tx
            .delete(schemas.mcpConnectionParam)
            .where(
              and(
                eq(schemas.mcpConnectionParam.estateId, estateId),
                eq(schemas.mcpConnectionParam.connectionKey, connectionKey),
              ),
            );
        }
      });

      return { success: true };
    }),

  getMCPConnectionParams: estateProtectedProcedure
    .input(
      z.object({
        connectionKey: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { estateId, connectionKey } = input;
      const params = await ctx.db.query.mcpConnectionParam.findMany({
        where: and(
          eq(schemas.mcpConnectionParam.estateId, estateId),
          eq(schemas.mcpConnectionParam.connectionKey, connectionKey),
        ),
      });
      return params.map((param) => ({
        key: param.paramKey,
        value: param.paramValue,
        type: param.paramType,
      }));
    }),

  reconnectMCPServer: estateProtectedProcedure
    .input(
      z.object({
        agentDurableObject: z.object({
          durableObjectId: z.string(),
          durableObjectName: z.string(),
          className: z.string(),
        }),
        serverUrl: z.string(),
        mode: z.enum(["personal", "company"]),
        integrationSlug: z.string(),
        requiresParams: z.array(MCPParam).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { agentDurableObject, serverUrl, mode, integrationSlug, requiresParams } = input;
      const params = {
        db: ctx.db,
        agentInstanceName: agentDurableObject.durableObjectName,
      };

      const agentStub = await getAgentStubByName(
        toAgentClassName(agentDurableObject.className),
        params,
      );

      if (!agentStub) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to get agent stub for ${agentDurableObject.className}: ${agentDurableObject.durableObjectName}`,
        });
      }
      await agentStub.addEvents([
        {
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl,
            mode: mode,
            userId: ctx.user.id,
            integrationSlug,
            requiresParams,
            triggerLLMRequestOnEstablishedConnection: false,
          },
        },
      ]);

      return { success: true };
    }),
  createTemplateRepo: estateProtectedProcedure
    .input(
      z.object({
        repoName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, repoName } = input;
      const { accessToken, installationId } = await getGithubUserAccessTokenForEstate(
        ctx.db,
        estateId,
      ).catch((e) => {
        logger.log(e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Failed to get GitHub user access token, Pleased reconnect your GitHub account if this persists",
        });
      });

      const githubJWT = await generateGithubJWT();
      const installationInfoRes = await fetch(
        `https://api.github.com/app/installations/${installationId}`,
        {
          headers: {
            Authorization: `Bearer ${githubJWT}`,
            "User-Agent": "Iterate OS",
          },
        },
      );

      if (!installationInfoRes.ok) {
        logger.log("Failed to get GitHub installation info", await installationInfoRes.text());
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to get GitHub installation info",
        });
      }

      const installationInfoData = z
        .object({ account: z.object({ login: z.string() }) })
        .parse(await installationInfoRes.json());

      const TEMPLATE_REPO_NAME = "iterate-com/estate-template";
      const createRepoRes = await fetch(
        `https://api.github.com/repos/${TEMPLATE_REPO_NAME}/generate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "Iterate OS",
          },
          body: JSON.stringify({
            owner: installationInfoData.account.login,
            name: repoName,
            description: "Your iterate estate",
            private: true,
          }),
        },
      );

      if (createRepoRes.status === 409) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Repository already exists, Please try a different name",
        });
      }

      if (!createRepoRes.ok) {
        logger.error(await createRepoRes.text());
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create repository",
        });
      }

      const repoRes = z.object({ id: z.number() }).parse(await createRepoRes.json());

      await ctx.db
        .update(schemas.estate)
        .set({
          connectedRepoId: repoRes.id,
          connectedRepoRef: "main",
          connectedRepoPath: "/",
        })
        .where(eq(schemas.estate.id, estateId));

      return {
        success: true,
      };
    }),

  startThreadWithAgent: estateProtectedProcedure
    .input(
      z.object({
        channel: z.string().describe("The Slack channel ID or name"),
        firstMessage: z.string().optional().describe("The message text to send to Slack"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, channel, firstMessage } = input;

      return await startSlackAgentInChannel({
        db: ctx.db,
        estateId: estateId,
        slackChannelIdOrName: channel,
        firstMessage: firstMessage,
      });
    }),

  listSlackChannels: estateProtectedProcedure
    .input(
      z.object({
        types: z.string().optional().default("public_channel"),
        excludeArchived: z.boolean().optional().default(true),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { estateId, types, excludeArchived } = input;

      const slackAccount = await getSlackAccessTokenForEstate(ctx.db, estateId);
      if (!slackAccount) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No Slack integration found for this estate",
        });
      }

      const slackAPI = new WebClient(slackAccount.accessToken);
      const result = await slackAPI.conversations.list({
        types: types,
        exclude_archived: excludeArchived,
        limit: 999,
      });

      if (!result.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch channels from Slack",
        });
      }

      return {
        success: true,
        channels: result.channels || [],
      };
    }),

  /**
   * Sets up a trial Slack Connect channel for a new user
   * This is called from slack-connect.tsx, most commonly after Google Sign In with /trial/slack-connect redirect
   *
   * What this does:
   * 1. Checks for existing trial with same email and reuses estate if found
   * 2. Creates new organization/estate if no existing trial
   * 3. Links estate to iterate's bot account
   * 4. Creates provider estate mapping for the trial estate
   * 5. Creates/reuses Slack Connect channel and sends invite
   *
   * Note: Trial estates are deduplicated by email. If a trial already exists for the given email,
   * the existing estate will be reused and the current user will be added to its organization.
   *
   * User sync: External Slack Connect users are synced just-in-time when they send messages,
   * handled automatically by slack-agent.ts JIT sync logic.
   */
  setupSlackConnectTrial: protectedProcedure
    .use(({ ctx, path, next }) => next({ ctx: { advisoryLockKey: `${path}:${ctx.user.email}` } }))
    .concat(AdvisoryLocker.trpcPlugin())
    .mutation(async ({ ctx }) => {
      const userEmail = ctx.user.email;
      const userName = ctx.user.name;
      const userId = ctx.user.id;

      logger.info(`Setting up Slack Connect trial for ${userEmail}`);

      const iterateTeamId = ctx.env.SLACK_ITERATE_TEAM_ID;

      // Look up user by email and check if they have a trial estate
      // This follows the proper schema relationships: user → org → estate → override
      const existingUserWithTrial = await ctx.db.query.user.findFirst({
        where: eq(schemas.user.email, userEmail),
        with: {
          organizationUserMembership: {
            with: {
              organization: {
                with: {
                  estates: {
                    with: {
                      slackChannelEstateOverrides: {
                        where: eq(schemas.slackChannelEstateOverride.slackTeamId, iterateTeamId),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Find the first estate that has a trial override
      const existingTrial = existingUserWithTrial?.organizationUserMembership
        .flatMap((m) => {
          const overridenEstate = m.organization.estates.find(
            (e) => e.slackChannelEstateOverrides.length > 0,
          );
          if (overridenEstate) {
            return { estate: { ...overridenEstate, organization: m.organization } };
          }
          return [];
        })
        .find(Boolean);

      let estate;
      let organization;

      if (existingTrial) {
        estate = existingTrial.estate;
        organization = estate.organization;
        logger.info(
          `Reusing existing trial estate ${estate.id} for ${userEmail} (organization ${organization.id})`,
        );

        const existingMembership = await ctx.db.query.organizationUserMembership.findFirst({
          where: and(
            eq(schemas.organizationUserMembership.organizationId, organization.id),
            eq(schemas.organizationUserMembership.userId, userId),
          ),
        });

        if (!existingMembership) {
          await ctx.db.insert(schemas.organizationUserMembership).values({
            organizationId: organization.id,
            userId: userId,
            role: "owner",
          });
          logger.info(`Added user ${userId} as owner of existing organization ${organization.id}`);
        }
      } else {
        [organization] = await ctx.db
          .insert(schemas.organization)
          .values({
            name: `${userName || userEmail}'s Organization`,
          })
          .returning();

        logger.info(`Created organization ${organization.id} for ${userName}`);

        [estate] = await ctx.db
          .insert(schemas.estate)
          .values({
            name: `${userName}'s Estate`,
            organizationId: organization.id,
          })
          .returning();

        logger.info(`Created estate ${estate.id} for ${userName}`);

        await ctx.db.insert(schemas.organizationUserMembership).values({
          organizationId: organization.id,
          userId: userId,
          role: "owner",
        });

        logger.info(`Added user ${userId} as owner of organization ${organization.id}`);
      }

      // 3. Get iterate's Slack workspace estate
      const { getIterateSlackEstateId } = await import("../../utils/trial-channel-setup.ts");
      const iterateEstateId = await getIterateSlackEstateId(ctx.db);
      if (!iterateEstateId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace estate not found",
        });
      }

      // 4. Get iterate's bot account and token
      const iterateBotAccount = await getSlackAccessTokenForEstate(ctx.db, iterateEstateId);
      if (!iterateBotAccount) {
        throw new Error("Iterate Slack bot account not found");
      }

      // 5. Link trial user's estate to iterate's bot account
      // This gives the trial estate permission to use iterate's bot token for API calls
      await ctx.db
        .insert(schemas.estateAccountsPermissions)
        .values({
          accountId: iterateBotAccount.accountId,
          estateId: estate.id,
        })
        .onConflictDoNothing();

      logger.info(`Linked trial estate ${estate.id} to iterate's bot account`);

      // 6. Create provider estate mapping to link trial estate to iterate's Slack workspace
      await ctx.db
        .insert(schemas.providerEstateMapping)
        .values({
          internalEstateId: estate.id,
          externalId: iterateTeamId,
          providerId: "slack-bot",
          providerMetadata: {
            isTrial: true,
            createdVia: "trial_signup",
          },
        })
        .onConflictDoNothing();

      logger.info(`Created provider estate mapping for trial estate ${estate.id}`);

      // 7. Create trial channel and send invite
      // Note: User sync happens just-in-time when external users send messages
      const { createTrialSlackConnectChannel } = await import("../../utils/trial-channel-setup.ts");
      const result = await createTrialSlackConnectChannel({
        db: ctx.db,
        userEstateId: estate.id,
        userEmail,
        userName,
        iterateTeamId,
        iterateBotToken: iterateBotAccount.accessToken,
      });

      logger.info(
        `Set up trial for ${userEmail}: channel ${result.channelName} → estate ${estate.id}`,
      );

      return {
        success: true,
        estateId: estate.id,
        organizationId: organization.id,
        channelId: result.channelId,
        channelName: result.channelName,
      };
    }),

  /**
   * Upgrades a trial estate to a full Slack installation
   * This removes all trial-specific configuration so the user can connect their own Slack workspace
   */
  upgradeTrialToFullInstallation: protectedProcedure
    .input(
      z.object({
        estateId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId } = input;

      logger.info(`Upgrading trial estate ${estateId} to full installation`);

      // Verify this is actually a trial estate
      const estate = await ctx.db.query.estate.findFirst({
        where: eq(schemas.estate.id, estateId),
        columns: {
          organizationId: true,
        },
      });

      if (!estate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Estate not found",
        });
      }

      const { getSlackChannelOverrideId } = await import("../../utils/trial-channel-setup.ts");
      const trialChannelId = await getSlackChannelOverrideId(ctx.db, estateId);
      if (!trialChannelId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This estate is not a trial estate",
        });
      }

      // Verify user has permission to modify this estate
      const membership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(schemas.organizationUserMembership.organizationId, estate.organizationId),
          eq(schemas.organizationUserMembership.userId, ctx.user.id),
        ),
      });

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have permission to modify this estate",
        });
      }

      const iterateTeamId = ctx.env.SLACK_ITERATE_TEAM_ID;
      if (!iterateTeamId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace not configured",
        });
      }

      // Perform cleanup in a transaction
      await ctx.db.transaction(async (tx) => {
        // 1. Delete the channel override
        await tx
          .delete(schemas.slackChannelEstateOverride)
          .where(
            and(
              eq(schemas.slackChannelEstateOverride.estateId, estateId),
              eq(schemas.slackChannelEstateOverride.slackTeamId, iterateTeamId),
            ),
          );

        logger.info(`Deleted channel override for estate ${estateId}`);

        // 2. Delete the provider estate mapping
        await tx
          .delete(schemas.providerEstateMapping)
          .where(
            and(
              eq(schemas.providerEstateMapping.internalEstateId, estateId),
              eq(schemas.providerEstateMapping.providerId, "slack-bot"),
            ),
          );

        logger.info(`Deleted provider estate mapping for estate ${estateId}`);

        // 3. Delete all old Slack provider user mappings
        // These were created during trial and will be stale after connecting own workspace
        await tx
          .delete(schemas.providerUserMapping)
          .where(
            and(
              eq(schemas.providerUserMapping.estateId, estateId),
              eq(schemas.providerUserMapping.providerId, "slack-bot"),
            ),
          );

        logger.info(`Deleted Slack provider user mappings for estate ${estateId}`);

        // 4. Get iterate's estate to find the bot account
        const iterateEstateResult = await tx
          .select({
            estateId: schemas.providerEstateMapping.internalEstateId,
          })
          .from(schemas.providerEstateMapping)
          .where(
            and(
              eq(schemas.providerEstateMapping.externalId, iterateTeamId),
              eq(schemas.providerEstateMapping.providerId, "slack-bot"),
            ),
          )
          .limit(1);

        const iterateEstateId = iterateEstateResult[0]?.estateId;

        if (iterateEstateId) {
          const iterateBotAccount = await tx
            .select({
              accountId: schemas.account.id,
            })
            .from(schemas.estateAccountsPermissions)
            .innerJoin(
              schemas.account,
              eq(schemas.estateAccountsPermissions.accountId, schemas.account.id),
            )
            .where(
              and(
                eq(schemas.estateAccountsPermissions.estateId, iterateEstateId),
                eq(schemas.account.providerId, "slack-bot"),
              ),
            )
            .limit(1);

          if (iterateBotAccount[0]) {
            // 5. Delete the estate account permission
            await tx
              .delete(schemas.estateAccountsPermissions)
              .where(
                and(
                  eq(schemas.estateAccountsPermissions.estateId, estateId),
                  eq(schemas.estateAccountsPermissions.accountId, iterateBotAccount[0].accountId),
                ),
              );

            logger.info(`Deleted estate account permission for estate ${estateId}`);
          }
        }
      });

      logger.info(`Successfully upgraded trial estate ${estateId} to full installation`);

      return {
        success: true,
      };
    }),
});
