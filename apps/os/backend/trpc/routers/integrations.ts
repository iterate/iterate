import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { generateRandomString } from "better-auth/crypto";
import { TRPCError } from "@trpc/server";
import { WebClient } from "@slack/web-api";
import { estateProtectedProcedure, router } from "../trpc.ts";
import { account, organizationUserMembership, estateAccountsPermissions } from "../../db/schema.ts";
import * as schema from "../../db/schema.ts";
import {
  getGithubInstallationForEstate,
  getGithubRepoForEstate,
  githubAppInstance,
  getOctokitForInstallation,
} from "../../integrations/github/github-utils.ts";
import { MCPParam } from "../../agent/tool-schemas.ts";
import { getMCPVerificationKey } from "../../agent/mcp/mcp-oauth-provider.ts";
import { getSlackAccessTokenForEstate } from "../../auth/token-utils.ts";
import { getAgentStubByName, toAgentClassName } from "../../agent/agents/stub-getters.ts";
import { startSlackAgentInChannel } from "../../agent/start-slack-agent-in-channel.ts";
import { AdvisoryLocker } from "../../durable-objects/advisory-locker.ts";
import { logger } from "../../tag-logger.ts";
import { createGithubRepoInEstatePool } from "../../org-utils.ts";
import { env } from "../../../env.ts";

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
        id: providerId as keyof typeof INTEGRATION_PROVIDERS,
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
      where: eq(schema.mcpConnectionParam.estateId, estateId),
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
        providerId: z.enum(
          Object.keys(INTEGRATION_PROVIDERS) as [keyof typeof INTEGRATION_PROVIDERS],
        ),
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

      await ctx.db.insert(schema.verification).values({
        identifier: state,
        value: data,
        expiresAt,
      });

      const installationUrl = await githubAppInstance().getInstallationUrl({ state });

      return {
        installationUrl,
      };
    }),
  listAvailableGithubRepos: estateProtectedProcedure.query(async ({ ctx, input }) => {
    const { estateId } = input;

    const githubInstallation = await getGithubInstallationForEstate(ctx.db, estateId);

    if (!githubInstallation) {
      const scopedOctokit = await getOctokitForInstallation(
        ctx.env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
      );

      const repo = await getGithubRepoForEstate(ctx.db, estateId);
      if (!repo) return [];
      const repoInfo = await scopedOctokit.request("GET /repositories/{repository_id}", {
        repository_id: repo.connectedRepoId,
      });
      if (repoInfo.status !== 200) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch repository details",
        });
      }
      const repoData = z
        .object({
          id: z.number(),
          full_name: z.string(),
          private: z.boolean(),
          default_branch: z.string(),
        })
        .parse(repoInfo.data);
      return [repoData];
    }

    const repos = await Array.fromAsync(
      githubAppInstance().eachRepository.iterator({
        installationId: parseInt(githubInstallation.accountId),
      }),
    ).then((arr) =>
      arr.map(({ repository }) => ({
        id: repository.id,
        full_name: repository.full_name,
        private: repository.private,
        default_branch: repository.default_branch,
      })),
    );

    return repos;
  }),
  getGithubRepoForEstate: estateProtectedProcedure.query(async ({ ctx, input }) => {
    const { estateId } = input;
    const githubRepo = await getGithubRepoForEstate(ctx.db, estateId);

    if (!githubRepo?.connectedRepoAccountId)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No repository connected to this estate.",
      });

    const scopedOctokit = await getOctokitForInstallation(githubRepo.connectedRepoAccountId);

    const repoResponse = await scopedOctokit.request("GET /repositories/{repository_id}", {
      repository_id: githubRepo.connectedRepoId,
    });

    if (repoResponse.status !== 200) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Failed to fetch repository details for repository id ${githubRepo.connectedRepoId}`,
      });
    }

    const repoData = z
      .object({ name: z.string(), full_name: z.string(), html_url: z.string() })
      .parse(repoResponse.data);

    return {
      repoId: githubRepo.connectedRepoId,
      repoName: repoData.name,
      repoFullName: repoData.full_name,
      branch: githubRepo.connectedRepoRef,
      path: githubRepo.connectedRepoPath,
      htmlUrl: repoData.html_url,
      managedBy:
        githubRepo.connectedRepoAccountId === ctx.env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID
          ? ("iterate" as const)
          : ("user" as const),
    };
  }),

  createIterateManagedGithubRepo: estateProtectedProcedure
    .input(
      z.object({
        estateId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId } = input;
      const estate = await ctx.db.query.estate.findFirst({
        where: eq(schema.estate.id, estateId),
        with: { organization: true },
      });
      if (!estate) throw new Error(`Estate ${estateId} not found`);
      const repo = await createGithubRepoInEstatePool({
        organizationName: estate.organization.name,
        organizationId: estate.organizationId,
      });
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(schema.iterateConfigSource)
          .set({ deactivatedAt: new Date() })
          .where(eq(schema.iterateConfigSource.estateId, estateId));
        await tx.insert(schema.iterateConfigSource).values({
          estateId,
          provider: "github",
          repoId: repo.id,
          branch: repo.default_branch,
          accountId: ctx.env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
        });
      });
      return {
        success: true,
      };
    }),

  setGithubRepoForEstate: estateProtectedProcedure
    .input(
      z.object({
        repoId: z.number(),
        branch: z.string(),
        path: z.string().or(z.undefined()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, repoId, branch, path } = input;

      const githubInstallation = await getGithubInstallationForEstate(ctx.db, estateId);

      const accountId =
        githubInstallation?.accountId ?? ctx.env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID;
      const scopedOctokit = await getOctokitForInstallation(accountId);

      const repo = await scopedOctokit
        .request("GET /repositories/{id}", { id: repoId })
        .catch((e) => {
          throw new Error(
            `Oh no: GET /repositories/${repoId} failed with account id ${accountId}`,
            { cause: e },
          );
        });
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

      const deactivateOthersQuery = ctx.db
        .update(schema.iterateConfigSource)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.iterateConfigSource.estateId, estateId));

      // todo: cte? didn't seem to work first time i tried it
      await deactivateOthersQuery;
      await ctx.db.insert(schema.iterateConfigSource).values({
        estateId,
        repoId,
        branch,
        path,
        provider: "github",
        accountId,
      });

      const branchData = await scopedOctokit.rest.repos.getBranch({
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
        .update(schema.iterateConfigSource)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.iterateConfigSource.estateId, estateId));

      if (deleteInstallation) {
        const githubInstallation = await getGithubInstallationForEstate(ctx.db, estateId);

        if (githubInstallation) {
          await ctx.db
            .delete(schema.account)
            .where(
              and(
                eq(schema.account.accountId, githubInstallation.accountId),
                eq(schema.account.providerId, "github-app"),
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
        providerId: z.enum(
          Object.keys(INTEGRATION_PROVIDERS) as [keyof typeof INTEGRATION_PROVIDERS],
        ),
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
            await ctx.db.transaction(async (tx) => {
              const disabledSources = await tx
                .update(schema.iterateConfigSource)
                .set({ deactivatedAt: new Date() })
                .where(eq(schema.iterateConfigSource.estateId, estateId))
                .returning();

              const latestManagedSource = disabledSources
                .filter((s) => s.accountId === env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID)
                .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
                .at(0);

              if (latestManagedSource) {
                const { id, createdAt, updatedAt, deactivatedAt, ...rest } = latestManagedSource;
                await tx.insert(schema.iterateConfigSource).values(rest);
              }
            });

            // Always revoke the GitHub app installation
            for (const { account: acc } of estateAccountsToDisconnect) {
              if (acc && acc.providerId === "github-app" && acc.accountId) {
                try {
                  const deleteResponse =
                    await githubAppInstance().octokit.rest.apps.deleteInstallation({
                      installation_id: parseInt(acc.accountId),
                    });

                  if (deleteResponse.status !== 204) {
                    // Log error but don't fail the disconnection
                    logger.error(
                      `Failed to revoke GitHub installation ${acc.accountId}: ${deleteResponse.status} ${deleteResponse.data}`,
                    );
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

      return ctx.sendToOutbox(ctx.db, {
        success: true,
        estateDisconnected,
        personalDisconnected,
        totalDisconnected: estateDisconnected + personalDisconnected,
      });
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
          .delete(schema.mcpConnectionParam)
          .where(eq(schema.mcpConnectionParam.connectionKey, connectionId));
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
                  eq(schema.dynamicClientInfo.providerId, acc.providerId),
                  eq(schema.dynamicClientInfo.userId, ctx.user.id),
                ),
              });
              if (clientInfo) {
                const verificationKey = getMCPVerificationKey(acc.providerId, clientInfo.clientId);

                await tx
                  .delete(schema.verification)
                  .where(eq(schema.verification.identifier, verificationKey));
                await tx
                  .delete(schema.dynamicClientInfo)
                  .where(eq(schema.dynamicClientInfo.id, clientInfo.id));
              }

              await tx.delete(schema.account).where(eq(account.id, connectionId));
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
            eq(schema.mcpConnectionParam.estateId, estateId),
            eq(schema.mcpConnectionParam.connectionKey, connectionId),
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
            eq(schema.dynamicClientInfo.providerId, acc.providerId),
            eq(schema.dynamicClientInfo.userId, acc.userId),
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
          .delete(schema.mcpConnectionParam)
          .where(
            and(
              eq(schema.mcpConnectionParam.estateId, estateId),
              eq(schema.mcpConnectionParam.connectionKey, connectionKey),
            ),
          );

        // Insert new params
        if (params.length > 0) {
          await tx.insert(schema.mcpConnectionParam).values(
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
            .insert(schema.mcpConnectionParam)
            .values(paramValues)
            .onConflictDoUpdate({
              target: [
                schema.mcpConnectionParam.estateId,
                schema.mcpConnectionParam.connectionKey,
                schema.mcpConnectionParam.paramKey,
                schema.mcpConnectionParam.paramType,
              ],
              set: {
                paramValue: sql`excluded.param_value`,
                updatedAt: new Date(),
              },
            });

          const currentParamKeys = params.map((p) => `${p.key}:${p.type}`);
          const existingParams = await tx.query.mcpConnectionParam.findMany({
            where: and(
              eq(schema.mcpConnectionParam.estateId, estateId),
              eq(schema.mcpConnectionParam.connectionKey, connectionKey),
            ),
          });

          const paramsToDelete = existingParams.filter(
            (existing) => !currentParamKeys.includes(`${existing.paramKey}:${existing.paramType}`),
          );

          if (paramsToDelete.length > 0) {
            const idsToDelete = paramsToDelete.map((p) => p.id);
            await tx
              .delete(schema.mcpConnectionParam)
              .where(inArray(schema.mcpConnectionParam.id, idsToDelete));
          }
        } else {
          await tx
            .delete(schema.mcpConnectionParam)
            .where(
              and(
                eq(schema.mcpConnectionParam.estateId, estateId),
                eq(schema.mcpConnectionParam.connectionKey, connectionKey),
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
          eq(schema.mcpConnectionParam.estateId, estateId),
          eq(schema.mcpConnectionParam.connectionKey, connectionKey),
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
  setupSlackConnectTrial: estateProtectedProcedure
    .use(({ ctx, path, next }) => next({ ctx: { advisoryLockKey: `${path}:${ctx.user.email}` } }))
    .concat(AdvisoryLocker.trpcPlugin())
    .mutation(async ({ ctx }) => {
      const userEmail = ctx.user.email;
      const userName = ctx.user.name;

      logger.info(`Setting up Slack Connect trial for ${userEmail} on estate ${ctx.estate.id}`);

      const iterateTeamId = ctx.env.SLACK_ITERATE_TEAM_ID;

      const { getIterateSlackEstateId } = await import("../../utils/trial-channel-setup.ts");
      const iterateEstateId = await getIterateSlackEstateId(ctx.db);
      if (!iterateEstateId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace estate not found",
        });
      }

      const iterateBotAccount = await getSlackAccessTokenForEstate(ctx.db, iterateEstateId);
      if (!iterateBotAccount) {
        throw new Error("Iterate Slack bot account not found");
      }

      return ctx.db.transaction(async (tx) => {
        await tx
          .insert(schema.estateAccountsPermissions)
          .values({
            accountId: iterateBotAccount.accountId,
            estateId: ctx.estate.id,
          })
          .onConflictDoNothing();

        logger.info(`Linked estate ${ctx.estate.id} to iterate's bot account`);

        await tx
          .insert(schema.providerEstateMapping)
          .values({
            internalEstateId: ctx.estate.id,
            externalId: iterateTeamId,
            providerId: "slack-bot",
            providerMetadata: {
              isTrial: true,
              createdVia: "trial_signup",
            },
          })
          .onConflictDoNothing();

        logger.info(`Created provider estate mapping for estate ${ctx.estate.id}`);

        return ctx.sendToOutbox(tx, {
          success: true,
          estateId: ctx.estate.id,
          organizationId: ctx.estate.organizationId,
          userEmail,
          userName,
          iterateTeamId,
        });
      });
    }),

  /**
   * Upgrades a trial estate to a full Slack installation
   * This removes all trial-specific configuration so the user can connect their own Slack workspace
   */
  upgradeTrialToFullInstallation: estateProtectedProcedure
    .meta({ description: "Upgrades a trial estate to a full Slack installation" })
    .mutation(async ({ ctx, input }) => {
      const { estateId } = input;

      logger.info(`Upgrading trial estate ${estateId} to full installation`);

      // Verify this is actually a trial estate
      const estate = await ctx.db.query.estate.findFirst({
        where: eq(schema.estate.id, estateId),
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
          eq(schema.organizationUserMembership.organizationId, estate.organizationId),
          eq(schema.organizationUserMembership.userId, ctx.user.id),
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
      return ctx.db.transaction(async (tx) => {
        // 1. Delete the channel override
        await tx
          .delete(schema.slackChannelEstateOverride)
          .where(
            and(
              eq(schema.slackChannelEstateOverride.estateId, estateId),
              eq(schema.slackChannelEstateOverride.slackTeamId, iterateTeamId),
            ),
          );

        logger.info(`Deleted channel override for estate ${estateId}`);

        // 2. Delete the provider estate mapping
        await tx
          .delete(schema.providerEstateMapping)
          .where(
            and(
              eq(schema.providerEstateMapping.internalEstateId, estateId),
              eq(schema.providerEstateMapping.providerId, "slack-bot"),
            ),
          );

        logger.info(`Deleted provider estate mapping for estate ${estateId}`);

        // 3. Delete all old Slack provider user mappings
        // These were created during trial and will be stale after connecting own workspace
        await tx
          .delete(schema.providerUserMapping)
          .where(
            and(
              eq(schema.providerUserMapping.estateId, estateId),
              eq(schema.providerUserMapping.providerId, "slack-bot"),
            ),
          );

        logger.info(`Deleted Slack provider user mappings for estate ${estateId}`);

        // 4. Get iterate's estate to find the bot account
        const iterateEstateResult = await tx
          .select({
            estateId: schema.providerEstateMapping.internalEstateId,
          })
          .from(schema.providerEstateMapping)
          .where(
            and(
              eq(schema.providerEstateMapping.externalId, iterateTeamId),
              eq(schema.providerEstateMapping.providerId, "slack-bot"),
            ),
          )
          .limit(1);

        const iterateEstateId = iterateEstateResult[0]?.estateId;

        if (iterateEstateId) {
          const iterateBotAccount = await tx
            .select({
              accountId: schema.account.id,
            })
            .from(schema.estateAccountsPermissions)
            .innerJoin(
              schema.account,
              eq(schema.estateAccountsPermissions.accountId, schema.account.id),
            )
            .where(
              and(
                eq(schema.estateAccountsPermissions.estateId, iterateEstateId),
                eq(schema.account.providerId, "slack-bot"),
              ),
            )
            .limit(1);

          if (iterateBotAccount[0]) {
            // 5. Delete the estate account permission
            await tx
              .delete(schema.estateAccountsPermissions)
              .where(
                and(
                  eq(schema.estateAccountsPermissions.estateId, estateId),
                  eq(schema.estateAccountsPermissions.accountId, iterateBotAccount[0].accountId),
                ),
              );

            logger.info(`Deleted estate account permission for estate ${estateId}`);
          }
        }

        return ctx.sendToOutbox(tx, { success: true, trialChannelId, estateId });
      });
    }),
});
