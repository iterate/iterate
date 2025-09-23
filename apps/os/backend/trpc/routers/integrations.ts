import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { generateRandomString } from "better-auth/crypto";
import { TRPCError } from "@trpc/server";
import { estateProtectedProcedure, router } from "../trpc.ts";
import { account, organizationUserMembership, estateAccountsPermissions } from "../../db/schema.ts";
import * as schemas from "../../db/schema.ts";
import {
  generateGithubJWT,
  getGithubInstallationForEstate,
  getGithubRepoForEstate,
  getGithubInstallationToken,
} from "../../integrations/github/github-utils.ts";

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

    // Group accounts by provider and track connection type
    const accountsByProvider: Record<
      string,
      { account: typeof account.$inferSelect; isEstateWide: boolean }[]
    > = {};

    // Add estate-wide accounts
    estateAccounts.forEach(({ account: acc_item }) => {
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
      if (!accountsByProvider[acc_item.providerId]) {
        accountsByProvider[acc_item.providerId] = [];
      }

      // Check if this account is already in estate-wide connections
      const isAlreadyEstateWide = estateAccounts.some(
        ({ account: estateAcc }) => estateAcc.id === acc_item.id,
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

    return integrations;
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
        .filter(({ account: acc }) => acc.providerId === input.providerId)
        .map(({ account: acc }) => acc);

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
  startGithubAppInstallFlow: estateProtectedProcedure.mutation(async ({ ctx, input }) => {
    const state = generateRandomString(32);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const { estateId } = input;

    const redirectUri = `${ctx.env.VITE_PUBLIC_URL}/api/integrations/github/callback`;
    const data = JSON.stringify({
      userId: ctx.user.id,
      estateId,
      redirectUri,
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
    const availableRepos = await fetch(`https://api.github.com/installation/repositories`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Iterate OS",
      },
    });

    if (!availableRepos.ok) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch available repositories",
      });
    }

    const AvailableRepos = z.object({
      repositories: z.array(
        z.object({
          id: z.number(),
          full_name: z.string(),
          private: z.boolean(),
        }),
      ),
    });

    const availableReposData = AvailableRepos.parse(await availableRepos.json());
    return availableReposData.repositories;
  }),
  getGithubRepoForEstate: estateProtectedProcedure.query(async ({ ctx, input }) => {
    const { estateId } = input;
    const githubRepo = await getGithubRepoForEstate(ctx.db, estateId);
    if (!githubRepo) return null;

    return {
      repoId: githubRepo.connectedRepoId,
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

      await ctx.db
        .update(schemas.estate)
        .set({
          connectedRepoId: repoId,
          connectedRepoRef: branch,
          connectedRepoPath: path,
        })
        .where(eq(schemas.estate.id, estateId));

      return {
        success: true,
      };
    }),
  disconnectGithubRepo: estateProtectedProcedure.mutation(async ({ ctx, input }) => {
    const { estateId } = input;

    await ctx.db
      .update(schemas.estate)
      .set({
        connectedRepoId: null,
        connectedRepoRef: null,
        connectedRepoPath: null,
      })
      .where(eq(schemas.estate.id, estateId));

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
          ({ account: acc }) => acc.providerId === providerId,
        );

        if (estateAccountsToDisconnect.length > 0) {
          // Delete estate permissions for these accounts
          const accountIds = estateAccountsToDisconnect.map(({ account: acc }) => acc.id);
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
              if (acc.providerId === "github-app" && acc.accountId) {
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
                    console.error(
                      `Failed to revoke GitHub installation ${acc.accountId}: ${deleteResponse.status} ${deleteResponse.statusText}`,
                    );
                  } else if (deleteResponse.ok) {
                    console.log(`Successfully revoked GitHub installation ${acc.accountId}`);
                  }
                } catch (error) {
                  // Log error but don't fail the disconnection
                  console.error(`Error revoking GitHub installation ${acc.accountId}:`, error);
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
              (ea) => ea.account.id === accountId,
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
});
