import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";
import { account } from "../../db/schema.ts";
import { eq, and } from "drizzle-orm";

// Define the integration providers we support
const INTEGRATION_PROVIDERS = {
  github: {
    name: "GitHub",
    description: "Connect to your GitHub account",
    icon: "github",
  },
  slack: {
    name: "Slack",
    description: "Connect to your Slack workspace",
    icon: "slack",
  },
  google: {
    name: "Google",
    description: "Connect to your Google account",
    icon: "google",
  },
} as const;

export const integrationsRouter = router({
  // Get all integrations with their connection status
  list: protectedProcedure.query(async ({ ctx }) => {
    // Fetch all accounts for the current user
    const userAccounts = await ctx.db.select().from(account).where(eq(account.userId, ctx.user.id));

    // Group accounts by provider
    const accountsByProvider = userAccounts.reduce(
      (acc, acc_item) => {
        if (!acc[acc_item.providerId]) {
          acc[acc_item.providerId] = [];
        }
        acc[acc_item.providerId]!.push(acc_item);
        return acc;
      },
      {} as Record<string, typeof userAccounts>,
    );

    // Map to integration format
    const integrations = Object.entries(INTEGRATION_PROVIDERS).map(([providerId, provider]) => {
      const connections = accountsByProvider[providerId] || [];
      const latestConnection = connections[0]; // Get the most recent connection

      return {
        id: providerId,
        name: provider.name,
        description: provider.description,
        icon: provider.icon,
        connections: connections.length,
        apps: 1, // Static for now, could be dynamic based on usage
        isConnected: connections.length > 0,
        scope: latestConnection?.scope || null,
        connectedAt: latestConnection?.createdAt || null,
        accessTokenExpiresAt: latestConnection?.accessTokenExpiresAt || null,
      };
    });

    return integrations;
  }),

  // Get details for a specific integration
  get: protectedProcedure
    .input(z.object({ providerId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userAccounts = await ctx.db
        .select()
        .from(account)
        .where(and(eq(account.userId, ctx.user.id), eq(account.providerId, input.providerId)));

      const provider =
        INTEGRATION_PROVIDERS[input.providerId as keyof typeof INTEGRATION_PROVIDERS];
      if (!provider) {
        throw new Error(`Unknown provider: ${input.providerId}`);
      }

      return {
        id: input.providerId,
        name: provider.name,
        description: provider.description,
        icon: provider.icon,
        connections: userAccounts.length,
        accounts: userAccounts.map((acc) => ({
          id: acc.id,
          accountId: acc.accountId,
          scope: acc.scope,
          createdAt: acc.createdAt,
          accessTokenExpiresAt: acc.accessTokenExpiresAt,
        })),
        isConnected: userAccounts.length > 0,
      };
    }),
});
