import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { generateRandomString } from "better-auth/crypto";
import { TRPCError } from "@trpc/server";
import { estateProtectedProcedure, router } from "../trpc.ts";
import { account, organizationUserMembership, estateAccountsPermissions } from "../../db/schema.ts";
import * as schemas from "../../db/schema.ts";
import { generateGithubJWT } from "../../integrations/github/github-utils.ts";

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
    const [githubInstallation] = await ctx.db
      .select({
        accountId: schemas.account.accountId,
      })
      .from(schemas.estateAccountsPermissions)
      .innerJoin(
        schemas.account,
        eq(schemas.estateAccountsPermissions.accountId, schemas.account.id),
      )
      .where(
        and(
          eq(schemas.estateAccountsPermissions.estateId, estateId),
          eq(schemas.account.providerId, "github-app"),
        ),
      )
      .limit(1);

    if (!githubInstallation) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Github installation not found",
      });
    }

    const jwt = await generateGithubJWT();

    const tokenRes = await fetch(
      `https://api.github.com/app/installations/${githubInstallation.accountId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "User-Agent": "Iterate OS",
        },
      },
    );

    if (!tokenRes.ok) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch access token",
      });
    }

    const { token } = (await tokenRes.json()) as { token: string };
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
    const [githubRepo] = await ctx.db
      .select({
        connectedRepoInfo: schemas.estate.connectedRepoId,
      })
      .from(schemas.estate)
      .where(eq(schemas.estate.id, estateId));
    if (!githubRepo) {
      return null;
    }
    return githubRepo.connectedRepoInfo;
  }),
  setGithubRepoForEstate: estateProtectedProcedure
    .input(
      z.object({
        repoId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, repoId } = input;

      await ctx.db
        .update(schemas.estate)
        .set({
          connectedRepoId: repoId,
          connectedRepoRef: "main",
          connectedRepoPath: "/",
        })
        .where(eq(schemas.estate.id, estateId));

      return {
        success: true,
      };
    }),
});
