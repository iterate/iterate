import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { generateRandomString } from "better-auth/crypto";
import { TRPCError } from "@trpc/server";
import { WebClient } from "@slack/web-api";
import { installationProtectedProcedure, router } from "../trpc.ts";
import {
  account,
  organizationUserMembership,
  installationAccountsPermissions,
} from "../../db/schema.ts";
import * as schema from "../../db/schema.ts";
import {
  getGithubInstallationForInstallation,
  getGithubRepoForInstallation,
  githubAppInstance,
  getOctokitForInstallation,
} from "../../integrations/github/github-utils.ts";
import { MCPParam } from "../../agent/tool-schemas.ts";
import { getMCPVerificationKey } from "../../agent/mcp/mcp-oauth-provider.ts";
import { getSlackAccessTokenForInstallation } from "../../auth/token-utils.ts";
import { getAgentStubByName, toAgentClassName } from "../../agent/agents/stub-getters.ts";
import { startSlackAgentInChannel } from "../../agent/start-slack-agent-in-channel.ts";
import { AdvisoryLocker } from "../../durable-objects/advisory-locker.ts";
import { logger } from "../../tag-logger.ts";
import { createGithubRepoInInstallationPool } from "../../org-utils.ts";
import { env } from "../../../env.ts";

// Define the integration providers we support
const INTEGRATION_PROVIDERS = {
  "github-app": {
    name: "GitHub App",
    description: "Install the GitHub app to your installation",
    icon: "github",
  },
  "slack-bot": {
    name: "Slack",
    description: "Connect Slack to your installation",
    icon: "slack",
  },
  google: {
    name: "Google",
    description: "Connect to your Google account",
    icon: "google",
  },
} as const;

// Helper function to get current user's installation ID
export const getCurrentUserInstallationId = async (
  db: any,
  userId: string,
): Promise<string | null> => {
  const userWithInstallation = await db.query.organizationUserMembership.findFirst({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: {
        with: {
          installations: {
            limit: 1,
          },
        },
      },
    },
  });

  return userWithInstallation?.organization?.installations?.[0]?.id || null;
};

export const integrationsRouter = router({
  // Get all integrations with their connection status
  list: installationProtectedProcedure.query(async ({ ctx, input }) => {
    const installationId = input.installationId;

    // Fetch installation-wide account connections
    const installationAccounts = await ctx.db.query.installationAccountsPermissions.findMany({
      where: eq(installationAccountsPermissions.installationId, installationId),
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
      { account: typeof account.$inferSelect; isInstallationWide: boolean }[]
    > = {};

    // Add installation-wide accounts
    installationAccounts.forEach(({ account: acc_item }) => {
      // Skip if account is null (orphaned permission record)
      if (!acc_item) return;
      if (!accountsByProvider[acc_item.providerId]) {
        accountsByProvider[acc_item.providerId] = [];
      }
      accountsByProvider[acc_item.providerId]!.push({
        account: acc_item,
        isInstallationWide: true,
      });
    });

    // Add personal accounts (only if not already in installation-wide)
    personalAccounts.forEach((acc_item) => {
      if (!acc_item) return;
      if (!accountsByProvider[acc_item.providerId]) {
        accountsByProvider[acc_item.providerId] = [];
      }

      // Check if this account is already in installation-wide connections
      const isAlreadyInstallationWide = installationAccounts.some(
        ({ account: instAcc }) => instAcc?.id === acc_item.id,
      );

      if (!isAlreadyInstallationWide) {
        accountsByProvider[acc_item.providerId]!.push({
          account: acc_item,
          isInstallationWide: false,
        });
      }
    });

    // Map to integration format
    const integrations = Object.entries(INTEGRATION_PROVIDERS).map(([providerId, provider]) => {
      const connections = accountsByProvider[providerId] || [];
      const latestConnection = connections[0]?.account; // Get the most recent connection
      const hasInstallationWide = connections.some((conn) => conn.isInstallationWide);
      const hasPersonal = connections.some((conn) => !conn.isInstallationWide);

      return {
        id: providerId as keyof typeof INTEGRATION_PROVIDERS,
        name: provider.name,
        description: provider.description,
        icon: provider.icon,
        connections: connections.length,
        isConnected: connections.length > 0,
        isInstallationWide: hasInstallationWide,
        isPersonal: hasPersonal,
        scope: latestConnection?.scope || null,
        connectedAt: latestConnection?.createdAt || null,
        accessTokenExpiresAt: latestConnection?.accessTokenExpiresAt || null,
      };
    });

    // Get MCP connections
    // 1. Get param-based MCP connections from mcpConnectionParam
    const mcpParams = await ctx.db.query.mcpConnectionParam.findMany({
      where: eq(schema.mcpConnectionParam.installationId, installationId),
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
      ...installationAccounts
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
        .filter(
          (acc) => !installationAccounts.some(({ account: instAcc }) => instAcc?.id === acc.id),
        )
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
  get: installationProtectedProcedure
    .input(
      z.object({
        providerId: z.enum(
          Object.keys(INTEGRATION_PROVIDERS) as [keyof typeof INTEGRATION_PROVIDERS],
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const installationId = input.installationId;

      // Fetch installation-wide account connections for this provider
      const installationAccounts = await ctx.db.query.installationAccountsPermissions.findMany({
        where: eq(installationAccountsPermissions.installationId, installationId),
        with: {
          account: true,
        },
      });

      const provider =
        INTEGRATION_PROVIDERS[input.providerId as keyof typeof INTEGRATION_PROVIDERS];
      if (!provider) {
        throw new Error(`Unknown provider: ${input.providerId}`);
      }

      const accounts = installationAccounts
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
  startGithubAppInstallFlow: installationProtectedProcedure
    .input(
      z.object({
        callbackURL: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const state = generateRandomString(32);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      const { installationId, callbackURL } = input;

      const redirectUri = `${ctx.env.VITE_PUBLIC_URL}/api/integrations/github/callback`;
      const data = JSON.stringify({
        userId: ctx.user.id,
        installationId,
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
  listAvailableGithubRepos: installationProtectedProcedure.query(async ({ ctx, input }) => {
    const { installationId } = input;

    const githubInstallation = await getGithubInstallationForInstallation(ctx.db, installationId);

    if (!githubInstallation) {
      const scopedOctokit = await getOctokitForInstallation(
        ctx.env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
      );

      const repo = await getGithubRepoForInstallation(ctx.db, installationId);
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
  getGithubRepoForInstallation: installationProtectedProcedure.query(async ({ ctx, input }) => {
    const { installationId } = input;
    const githubRepo = await getGithubRepoForInstallation(ctx.db, installationId);

    if (!githubRepo?.connectedRepoAccountId)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No repository connected to this installation.",
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

  createIterateManagedGithubRepo: installationProtectedProcedure
    .input(
      z.object({
        installationId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { installationId } = input;
      const installation = await ctx.db.query.installation.findFirst({
        where: eq(schema.installation.id, installationId),
        with: { organization: true },
      });
      if (!installation) throw new Error(`Installation ${installationId} not found`);
      const repo = await createGithubRepoInInstallationPool({
        organizationName: installation.organization.name,
        organizationId: installation.organizationId,
      });
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(schema.iterateConfigSource)
          .set({ deactivatedAt: new Date() })
          .where(eq(schema.iterateConfigSource.installationId, installationId));
        await tx.insert(schema.iterateConfigSource).values({
          installationId,
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

  setGithubRepoForInstallation: installationProtectedProcedure
    .input(
      z.object({
        repoId: z.number(),
        branch: z.string(),
        path: z.string().or(z.undefined()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { installationId, repoId, branch, path } = input;

      const githubInstallation = await getGithubInstallationForInstallation(ctx.db, installationId);

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
        .where(eq(schema.iterateConfigSource.installationId, installationId));

      // todo: cte? didn't seem to work first time i tried it
      await deactivateOthersQuery;
      await ctx.db.insert(schema.iterateConfigSource).values({
        installationId,
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
        const { triggerInstallationRebuild } = await import("./installation.ts");
        await triggerInstallationRebuild({
          db: ctx.db,
          env: ctx.env,
          installationId,
          commitHash,
          commitMessage,
          isManual: false, // This is an automatic build
        });
      }

      return {
        success: true,
      };
    }),
  disconnectGithubRepo: installationProtectedProcedure
    .input(
      z.object({
        deleteInstallation: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { installationId, deleteInstallation } = input;

      await ctx.db
        .update(schema.iterateConfigSource)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.iterateConfigSource.installationId, installationId));

      if (deleteInstallation) {
        const githubInstallation = await getGithubInstallationForInstallation(
          ctx.db,
          installationId,
        );

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

  // Disconnect an integration from the installation or personal account
  disconnect: installationProtectedProcedure
    .input(
      z.object({
        providerId: z.enum(
          Object.keys(INTEGRATION_PROVIDERS) as [keyof typeof INTEGRATION_PROVIDERS],
        ),
        disconnectType: z.enum(["installation", "personal", "both"]).default("both"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { installationId, providerId, disconnectType } = input;
      let installationDisconnected = 0;
      let personalDisconnected = 0;

      // Handle installation-wide disconnection
      if (disconnectType === "installation" || disconnectType === "both") {
        // Find all accounts for this provider connected to this installation
        const installationAccounts = await ctx.db.query.installationAccountsPermissions.findMany({
          where: eq(installationAccountsPermissions.installationId, installationId),
          with: {
            account: true,
          },
        });

        const installationAccountsToDisconnect = installationAccounts.filter(
          ({ account: acc }) => acc && acc.providerId === providerId,
        );

        if (installationAccountsToDisconnect.length > 0) {
          // Delete installation permissions for these accounts
          const accountIds = installationAccountsToDisconnect.map(({ account: acc }) => acc!.id);
          await ctx.db
            .delete(installationAccountsPermissions)
            .where(
              and(
                eq(installationAccountsPermissions.installationId, installationId),
                inArray(installationAccountsPermissions.accountId, accountIds),
              ),
            );
          installationDisconnected = accountIds.length;

          // For GitHub integrations, also clear the connected repo information and revoke the installation
          if (providerId === "github-app") {
            // Clear the connected repo information
            await ctx.db.transaction(async (tx) => {
              const disabledSources = await tx
                .update(schema.iterateConfigSource)
                .set({ deactivatedAt: new Date() })
                .where(eq(schema.iterateConfigSource.installationId, installationId))
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
            for (const { account: acc } of installationAccountsToDisconnect) {
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
            const otherInstallationPermissions =
              await ctx.db.query.installationAccountsPermissions.findFirst({
                where: eq(installationAccountsPermissions.accountId, accountId),
              });

            // If this account is not used by any other installation and belongs to the current user, delete it
            const acc = installationAccountsToDisconnect.find(
              (ea) => ea.account?.id === accountId,
            )?.account;
            if (!otherInstallationPermissions && acc?.userId === ctx.user.id) {
              await ctx.db.delete(account).where(eq(account.id, accountId));
            }
          }
        }
      }

      // Handle personal disconnection
      if (disconnectType === "personal" || disconnectType === "both") {
        // Find personal accounts for this provider (directly linked to user, not necessarily to installation)
        const personalAccounts = await ctx.db
          .select()
          .from(account)
          .where(and(eq(account.userId, ctx.user.id), eq(account.providerId, providerId)));

        if (personalAccounts.length > 0) {
          // For personal accounts, we need to check if they're used by any installation
          for (const personalAccount of personalAccounts) {
            // Check if this account is used by any installation
            const installationPermissions =
              await ctx.db.query.installationAccountsPermissions.findFirst({
                where: eq(installationAccountsPermissions.accountId, personalAccount.id),
              });

            // Only delete if not used by any installation (or if we're also disconnecting from installation)
            if (!installationPermissions || disconnectType === "both") {
              // First remove any installation permissions if they exist
              if (installationPermissions) {
                await ctx.db
                  .delete(installationAccountsPermissions)
                  .where(eq(installationAccountsPermissions.accountId, personalAccount.id));
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

      if (installationDisconnected === 0 && personalDisconnected === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No ${providerId} integration found to disconnect`,
        });
      }

      return ctx.sendTrpc(ctx.db, {
        success: true,
        installationDisconnected,
        personalDisconnected,
        totalDisconnected: installationDisconnected + personalDisconnected,
      });
    }),

  disconnectMCP: installationProtectedProcedure
    .input(
      z.object({
        connectionId: z.string(),
        connectionType: z.enum(["mcp-oauth", "mcp-params"]),
        mode: z.enum(["company", "personal"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { installationId, connectionId, connectionType } = input;

      if (connectionType === "mcp-params") {
        // Delete from mcpConnectionParam table
        await ctx.db
          .delete(schema.mcpConnectionParam)
          .where(eq(schema.mcpConnectionParam.connectionKey, connectionId));
      } else {
        // Delete from account table (OAuth)
        // First check if this account is linked to this installation
        const installationPermission = await ctx.db.query.installationAccountsPermissions.findFirst(
          {
            where: and(
              eq(installationAccountsPermissions.installationId, installationId),
              eq(installationAccountsPermissions.accountId, connectionId),
            ),
          },
        );

        // Remove installation permission if it exists
        if (installationPermission) {
          await ctx.db
            .delete(installationAccountsPermissions)
            .where(
              and(
                eq(installationAccountsPermissions.installationId, installationId),
                eq(installationAccountsPermissions.accountId, connectionId),
              ),
            );
        }

        // Check if account is used by other installations
        const otherInstallations = await ctx.db.query.installationAccountsPermissions.findFirst({
          where: eq(installationAccountsPermissions.accountId, connectionId),
        });

        // Only delete the account if it's not used by any other installation
        if (!otherInstallations) {
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

  getMCPConnectionDetails: installationProtectedProcedure
    .input(
      z.object({
        connectionId: z.string(),
        connectionType: z.enum(["mcp-oauth", "mcp-params"]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { installationId, connectionId, connectionType } = input;

      if (connectionType === "mcp-params") {
        // Get params for param-based connection
        const params = await ctx.db.query.mcpConnectionParam.findMany({
          where: and(
            eq(schema.mcpConnectionParam.installationId, installationId),
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

  updateMCPConnectionParams: installationProtectedProcedure
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
      const { installationId, connectionKey, params } = input;

      await ctx.db.transaction(async (tx) => {
        // Delete existing params
        await tx
          .delete(schema.mcpConnectionParam)
          .where(
            and(
              eq(schema.mcpConnectionParam.installationId, installationId),
              eq(schema.mcpConnectionParam.connectionKey, connectionKey),
            ),
          );

        // Insert new params
        if (params.length > 0) {
          await tx.insert(schema.mcpConnectionParam).values(
            params.map((param) => ({
              installationId,
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

  saveMCPConnectionParams: installationProtectedProcedure
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
      const { installationId, connectionKey, params } = input;

      await ctx.db.transaction(async (tx) => {
        if (params.length > 0) {
          const paramValues = params.map((param) => ({
            installationId,
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
                schema.mcpConnectionParam.installationId,
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
              eq(schema.mcpConnectionParam.installationId, installationId),
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
                eq(schema.mcpConnectionParam.installationId, installationId),
                eq(schema.mcpConnectionParam.connectionKey, connectionKey),
              ),
            );
        }
      });

      return { success: true };
    }),

  getMCPConnectionParams: installationProtectedProcedure
    .input(
      z.object({
        connectionKey: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { installationId, connectionKey } = input;
      const params = await ctx.db.query.mcpConnectionParam.findMany({
        where: and(
          eq(schema.mcpConnectionParam.installationId, installationId),
          eq(schema.mcpConnectionParam.connectionKey, connectionKey),
        ),
      });
      return params.map((param) => ({
        key: param.paramKey,
        value: param.paramValue,
        type: param.paramType,
      }));
    }),

  reconnectMCPServer: installationProtectedProcedure
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

  startThreadWithAgent: installationProtectedProcedure
    .input(
      z.object({
        channel: z.string().describe("The Slack channel ID or name"),
        firstMessage: z.string().optional().describe("The message text to send to Slack"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { installationId, channel, firstMessage } = input;

      return await startSlackAgentInChannel({
        db: ctx.db,
        installationId: installationId,
        slackChannelIdOrName: channel,
        firstMessage: firstMessage,
      });
    }),

  listSlackChannels: installationProtectedProcedure
    .input(
      z.object({
        types: z.string().optional().default("public_channel"),
        excludeArchived: z.boolean().optional().default(true),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { installationId, types, excludeArchived } = input;

      const slackAccount = await getSlackAccessTokenForInstallation(ctx.db, installationId);
      if (!slackAccount) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No Slack integration found for this installation",
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
   * 1. Checks for existing trial with same email and reuses installation if found
   * 2. Creates new organization/installation if no existing trial
   * 3. Links installation to iterate's bot account
   * 4. Creates provider installation mapping for the trial installation
   * 5. Creates/reuses Slack Connect channel and sends invite
   *
   * Note: Trial installations are deduplicated by email. If a trial already exists for the given email,
   * the existing installation will be reused and the current user will be added to its organization.
   *
   * User sync: External Slack Connect users are synced just-in-time when they send messages,
   * handled automatically by slack-agent.ts JIT sync logic.
   */
  setupSlackConnectTrial: installationProtectedProcedure
    .use(({ ctx, path, next }) => next({ ctx: { advisoryLockKey: `${path}:${ctx.user.email}` } }))
    .concat(AdvisoryLocker.trpcPlugin())
    .mutation(async ({ ctx }) => {
      const userEmail = ctx.user.email;
      const userName = ctx.user.name;

      logger.info(
        `Setting up Slack Connect trial for ${userEmail} on installation ${ctx.installation.id}`,
      );

      const iterateTeamId = ctx.env.SLACK_ITERATE_TEAM_ID;

      const { getIterateSlackInstallationId } = await import("../../utils/trial-channel-setup.ts");
      const iterateInstallationId = await getIterateSlackInstallationId(ctx.db);
      if (!iterateInstallationId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace installation not found",
        });
      }

      const iterateBotAccount = await getSlackAccessTokenForInstallation(
        ctx.db,
        iterateInstallationId,
      );
      if (!iterateBotAccount) {
        throw new Error("Iterate Slack bot account not found");
      }

      return ctx.db.transaction(async (tx) => {
        await tx
          .insert(schema.installationAccountsPermissions)
          .values({
            accountId: iterateBotAccount.accountId,
            installationId: ctx.installation.id,
          })
          .onConflictDoNothing();

        logger.info(`Linked installation ${ctx.installation.id} to iterate's bot account`);

        await tx
          .insert(schema.providerInstallationMapping)
          .values({
            internalInstallationId: ctx.installation.id,
            externalId: iterateTeamId,
            providerId: "slack-bot",
            providerMetadata: {
              isTrial: true,
              createdVia: "trial_signup",
            },
          })
          .onConflictDoNothing();

        logger.info(
          `Created provider installation mapping for installation ${ctx.installation.id}`,
        );

        return ctx.sendTrpc(tx, {
          success: true,
          installationId: ctx.installation.id,
          organizationId: ctx.installation.organizationId,
          userEmail,
          userName,
          iterateTeamId,
        });
      });
    }),

  /**
   * Upgrades a trial installation to a full Slack installation
   * This removes all trial-specific configuration so the user can connect their own Slack workspace
   */
  upgradeTrialToFullInstallation: installationProtectedProcedure
    .meta({ description: "Upgrades a trial installation to a full Slack installation" })
    .mutation(async ({ ctx, input }) => {
      const { installationId } = input;

      logger.info(`Upgrading trial installation ${installationId} to full installation`);

      // Verify this is actually a trial installation
      const installation = await ctx.db.query.installation.findFirst({
        where: eq(schema.installation.id, installationId),
        columns: {
          organizationId: true,
        },
      });

      if (!installation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Installation not found",
        });
      }

      const { getSlackChannelOverrideId } = await import("../../utils/trial-channel-setup.ts");
      const trialChannelId = await getSlackChannelOverrideId(ctx.db, installationId);
      if (!trialChannelId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This installation is not a trial installation",
        });
      }

      // Verify user has permission to modify this installation
      const membership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(schema.organizationUserMembership.organizationId, installation.organizationId),
          eq(schema.organizationUserMembership.userId, ctx.user.id),
        ),
      });

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have permission to modify this installation",
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
          .delete(schema.slackChannelOverride)
          .where(
            and(
              eq(schema.slackChannelOverride.installationId, installationId),
              eq(schema.slackChannelOverride.slackTeamId, iterateTeamId),
            ),
          );

        logger.info(`Deleted channel override for installation ${installationId}`);

        // 2. Delete the provider installation mapping
        await tx
          .delete(schema.providerInstallationMapping)
          .where(
            and(
              eq(schema.providerInstallationMapping.internalInstallationId, installationId),
              eq(schema.providerInstallationMapping.providerId, "slack-bot"),
            ),
          );

        logger.info(`Deleted provider installation mapping for installation ${installationId}`);

        // 3. Delete all old Slack provider user mappings
        // These were created during trial and will be stale after connecting own workspace
        await tx
          .delete(schema.providerUserMapping)
          .where(
            and(
              eq(schema.providerUserMapping.installationId, installationId),
              eq(schema.providerUserMapping.providerId, "slack-bot"),
            ),
          );

        logger.info(`Deleted Slack provider user mappings for installation ${installationId}`);

        // 4. Get iterate's installation to find the bot account
        const iterateInstallationResult = await tx
          .select({
            installationId: schema.providerInstallationMapping.internalInstallationId,
          })
          .from(schema.providerInstallationMapping)
          .where(
            and(
              eq(schema.providerInstallationMapping.externalId, iterateTeamId),
              eq(schema.providerInstallationMapping.providerId, "slack-bot"),
            ),
          )
          .limit(1);

        const iterateInstallationId = iterateInstallationResult[0]?.installationId;

        if (iterateInstallationId) {
          const iterateBotAccount = await tx
            .select({
              accountId: schema.account.id,
            })
            .from(schema.installationAccountsPermissions)
            .innerJoin(
              schema.account,
              eq(schema.installationAccountsPermissions.accountId, schema.account.id),
            )
            .where(
              and(
                eq(schema.installationAccountsPermissions.installationId, iterateInstallationId),
                eq(schema.account.providerId, "slack-bot"),
              ),
            )
            .limit(1);

          if (iterateBotAccount[0]) {
            // 5. Delete the installation account permission
            await tx
              .delete(schema.installationAccountsPermissions)
              .where(
                and(
                  eq(schema.installationAccountsPermissions.installationId, installationId),
                  eq(
                    schema.installationAccountsPermissions.accountId,
                    iterateBotAccount[0].accountId,
                  ),
                ),
              );

            logger.info(
              `Deleted installation account permission for installation ${installationId}`,
            );
          }
        }

        return ctx.sendTrpc(tx, { success: true, trialChannelId, installationId });
      });
    }),
});
