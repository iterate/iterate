import { z } from "zod/v4";
import { and, eq, desc, like } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { parseRouter, type AnyRouter } from "trpc-cli";
import { typeid } from "typeid-js";
import { protectedProcedure, router } from "../trpc.ts";
import { schema } from "../../db/client.ts";
import { sendNotificationToIterateSlack } from "../../integrations/slack/slack-utils.ts";
import { syncSlackForEstateInBackground } from "../../integrations/slack/slack.ts";
import { getSlackAccessTokenForEstate } from "../../auth/token-utils.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "../../integrations/stripe/stripe.ts";
import type { DB } from "../../db/client.ts";
import { getAuth } from "../../auth/auth.ts";
import { createUserOrganizationAndEstate } from "../../org-utils.ts";
import { logger } from "../../tag-logger.ts";
import { E2ETestParams } from "../../utils/test-helpers/onboarding-test-schema.ts";
import {
  createTrialSlackConnectChannel,
  getIterateSlackEstateId,
} from "../../utils/trial-channel-setup.ts";
import { env } from "../../../env.ts";
import { deleteUserAccount } from "./user.ts";

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not authorized to access this resource",
    });
  }
  return next({ ctx });
});

const findUserByEmail = adminProcedure
  .input(z.object({ email: z.string() }))
  .query(async ({ ctx, input }) => {
    const user = await ctx.db.query.user.findFirst({
      where: eq(schema.user.email, input.email),
    });
    return user;
  });

const searchUsersByEmail = adminProcedure
  .input(
    z.object({
      searchEmail: z.string(),
    }),
  )
  .query(async ({ ctx, input }) => {
    const users = await ctx.db.query.user.findMany({
      where: like(schema.user.email, `%${input.searchEmail}%`),
      columns: {
        id: true,
        email: true,
        name: true,
      },
      limit: 10,
    });

    return users;
  });

const getEstateOwner = adminProcedure
  .input(z.object({ estateId: z.string() }))
  .query(async ({ ctx, input }) => {
    const estate = await ctx.db.query.estate.findFirst({
      where: eq(schema.estate.id, input.estateId),
    });

    if (!estate) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Estate not found",
      });
    }

    const ownerMembership = await ctx.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(schema.organizationUserMembership.organizationId, estate.organizationId),
        eq(schema.organizationUserMembership.role, "owner"),
      ),
      with: {
        user: true,
      },
    });

    if (!ownerMembership?.user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Estate owner not found",
      });
    }

    return {
      userId: ownerMembership.user.id,
      email: ownerMembership.user.email,
      name: ownerMembership.user.name,
    };
  });

const deleteUserByEmail = adminProcedure
  .input(z.object({ email: z.string().email() }))
  .mutation(async ({ ctx, input }) => {
    const user = await ctx.db.query.user.findFirst({
      where: eq(schema.user.email, input.email),
    });

    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    return deleteUserAccount({ db: ctx.db, user });
  });

const setupTestOnboardingUser = adminProcedure.mutation(async ({ ctx }) => {
  const auth = getAuth(ctx.db);
  const userEmail = `${typeid(`test_user`).toString()}@example.com`;

  const { user } = await auth.api.createUser({
    body: {
      email: userEmail,
      name: userEmail.split("@")[0],
      password: typeid("pass").toString(),
      role: "user",
    },
  });

  const { organization, estate } = await createUserOrganizationAndEstate(ctx.db, user);

  if (!estate) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create estate",
    });
  }

  let hasSeedData = false;
  if (ctx.env.ONBOARDING_E2E_TEST_SETUP_PARAMS) {
    try {
      const seedData = E2ETestParams.parse(JSON.parse(ctx.env.ONBOARDING_E2E_TEST_SETUP_PARAMS));

      const [_userAccount, botAccount, githubAccount] = await ctx.db
        .insert(schema.account)
        .values([
          {
            providerId: "slack",
            userId: user.id,
            accountId: seedData.slack.user.id,
            accessToken: seedData.slack.user.accessToken,
          },
          {
            providerId: "slack-bot",
            userId: user.id,
            accountId: seedData.slack.bot.id,
            accessToken: seedData.slack.bot.accessToken,
          },
          {
            providerId: "github-app",
            userId: user.id,
            accountId: seedData.github.installationId.toString(),
            accessToken: seedData.github.accessToken,
          },
        ])
        .onConflictDoNothing()
        .returning();

      await ctx.db
        .insert(schema.providerEstateMapping)
        .values([
          {
            providerId: "slack-bot",
            internalEstateId: estate.id,
            externalId: seedData.slack.teamId,
            providerMetadata: {
              botUserId: seedData.slack.bot.id,
            },
          },
        ])
        .onConflictDoNothing();

      await ctx.db
        .insert(schema.estateAccountsPermissions)
        .values([
          {
            accountId: botAccount.id,
            estateId: estate.id,
          },
          {
            accountId: githubAccount.id,
            estateId: estate.id,
          },
        ])
        .onConflictDoNothing();

      hasSeedData = true;
    } catch (error) {
      logger.error(`Failed to setup test onboarding user: ${error}`);
    }
  }

  return { user, organization, estate, hasSeedData };
});

const allProcedureInputs = adminProcedure.query(async () => {
  const { appRouter: router } = (await import("../root.ts")) as unknown as { appRouter: AnyRouter };
  const parsed = parseRouter({ router });
  return JSON.parse(
    JSON.stringify(parsed, (_key, value) => {
      if (value?._def?.procedure) return { _def: value._def };
      return value;
    }),
  ) as typeof parsed;
});

export const adminRouter = router({
  findUserByEmail,
  searchUsersByEmail,
  getEstateOwner,
  deleteUserByEmail,
  setupTestOnboardingUser,
  allProcedureInputs,
  impersonationInfo: protectedProcedure.query(async ({ ctx }) => {
    // || undefined means non-admins and non-impersonated users get `{}` from this endpoint, revealing no information
    // important because it's available to anyone signed in
    const impersonatedBy = ctx?.session?.session.impersonatedBy || undefined;
    const isAdmin = ctx?.user?.role === "admin" || undefined;
    return { impersonatedBy, isAdmin };
  }),
  sendSlackNotification: adminProcedure
    .input(
      z.object({
        message: z.string().min(1, "Message cannot be empty"),
        channel: z.string().min(1, "Channel cannot be empty"),
      }),
    )
    .mutation(async ({ input }) => {
      await sendNotificationToIterateSlack(input.message, input.channel);
      return { success: true };
    }),
  getSessionInfo: adminProcedure.query(async ({ ctx }) => {
    return {
      user: ctx.user,
      session: ctx.session,
    };
  }),
  listAllEstates: adminProcedure.query(async ({ ctx }) => {
    const estates = await ctx.db.query.estate.findMany({
      with: {
        organization: {
          with: {
            members: {
              where: eq(schema.organizationUserMembership.role, "owner"),
              with: {
                user: true,
              },
            },
          },
        },
      },
      orderBy: desc(schema.estate.updatedAt),
    });

    return estates.map((estate) => ({
      id: estate.id,
      name: estate.name,
      organizationId: estate.organizationId,
      organizationName: estate.organization.name,
      ownerEmail: estate.organization.members[0]?.user.email,
      ownerName: estate.organization.members[0]?.user.name,
      ownerId: estate.organization.members[0]?.user.id,
      connectedRepoId: estate.connectedRepoId,
      connectedRepoPath: estate.connectedRepoPath,
      connectedRepoRef: estate.connectedRepoRef,
      createdAt: estate.createdAt,
      updatedAt: estate.updatedAt,
    }));
  }),
  rebuildEstate: adminProcedure
    .input(z.object({ estateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { triggerEstateRebuild } = await import("./estate.ts");

      const estateData = await ctx.db.query.estate.findFirst({
        where: eq(schema.estate.id, input.estateId),
      });

      if (!estateData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Estate not found",
        });
      }

      if (!estateData.connectedRepoId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Estate has no connected repository",
        });
      }

      const result = await triggerEstateRebuild({
        db: ctx.db,
        env: ctx.env,
        estateId: input.estateId,
        commitHash: estateData.connectedRepoRef || "main",
        commitMessage: "Manual rebuild triggered by admin",
        isManual: true,
      });

      return { success: true, buildId: result.id };
    }),
  rebuildAllEstates: adminProcedure.mutation(async ({ ctx }) => {
    const { triggerEstateRebuild } = await import("./estate.ts");

    const estates = await ctx.db.query.estate.findMany({
      where: eq(schema.estate.connectedRepoId, schema.estate.connectedRepoId),
    });

    const results = [];

    for (const estate of estates) {
      if (!estate.connectedRepoId) {
        results.push({
          estateId: estate.id,
          estateName: estate.name,
          success: false,
          error: "No connected repository",
        });
        continue;
      }

      try {
        const result = await triggerEstateRebuild({
          db: ctx.db,
          env: ctx.env,
          estateId: estate.id,
          commitHash: estate.connectedRepoRef || "main",
          commitMessage: "Bulk rebuild triggered by admin",
          isManual: true,
        });

        results.push({
          estateId: estate.id,
          estateName: estate.name,
          success: true,
          buildId: result.id,
        });
      } catch (error) {
        results.push({
          estateId: estate.id,
          estateName: estate.name,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return {
      total: estates.length,
      results,
    };
  }),
  syncSlackForEstate: adminProcedure
    .input(z.object({ estateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const slackToken = await getSlackAccessTokenForEstate(ctx.db, input.estateId);

      if (!slackToken) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No Slack token found for this estate",
        });
      }

      // Get team ID from provider estate mapping
      const estateMapping = await ctx.db.query.providerEstateMapping.findFirst({
        where: and(
          eq(schema.providerEstateMapping.internalEstateId, input.estateId),
          eq(schema.providerEstateMapping.providerId, "slack-bot"),
        ),
      });

      if (!estateMapping) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No Slack team mapping found for this estate",
        });
      }

      return await syncSlackForEstateInBackground(
        ctx.db,
        slackToken,
        input.estateId,
        estateMapping.externalId,
      );
    }),
  syncSlackForAllEstates: adminProcedure.mutation(async ({ ctx }) => {
    return await syncSlackForAllEstatesHelper(ctx.db);
  }),
  // Create Stripe customer for an organization (admin only)
  createStripeCustomer: adminProcedure
    .input(
      z.object({
        organizationId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Fetch the organization
      const organization = await ctx.db.query.organization.findFirst({
        where: eq(schema.organization.id, input.organizationId),
      });

      if (!organization) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Organization not found",
        });
      }

      // Check if organization already has a Stripe customer
      if (organization.stripeCustomerId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Organization already has a Stripe customer: ${organization.stripeCustomerId}`,
        });
      }

      // Get the organization owner for Stripe customer details
      const ownerMembership = await ctx.db.query.organizationUserMembership.findFirst({
        where: (membership, { and, eq }) =>
          and(eq(membership.organizationId, input.organizationId), eq(membership.role, "owner")),
        with: {
          user: true,
        },
      });

      if (!ownerMembership) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Organization owner not found",
        });
      }

      // Create Stripe customer and subscription synchronously so we can return the result
      const customer = await createStripeCustomerAndSubscriptionForOrganization(
        ctx.db,
        organization,
        ownerMembership.user,
      );

      if (!customer) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create Stripe customer",
        });
      }

      return {
        success: true,
        stripeCustomerId: customer.id,
      };
    }),

  /**
   * Admin endpoint to manually create a trial Slack Connect channel
   * Can create a new estate/org or use an existing one
   */
  createTrialSlackChannel: adminProcedure
    .input(
      z.object({
        userEmail: z.string().email(),
        userName: z.string().optional(),
        existingEstateId: z.string().optional(),
        createNewEstate: z.boolean().default(true),
        estateName: z.string().optional(),
        organizationName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const {
        userEmail,
        userName,
        existingEstateId,
        createNewEstate,
        estateName,
        organizationName,
      } = input;

      let estateId = existingEstateId;
      let organizationId: string | undefined;

      // Create estate/org if needed
      if (createNewEstate) {
        const [org] = await ctx.db
          .insert(schema.organization)
          .values({
            name: organizationName || `${userName || userEmail}'s Organization`,
          })
          .returning();

        const [estate] = await ctx.db
          .insert(schema.estate)
          .values({
            name: estateName || `${userName || userEmail}'s Estate`,
            organizationId: org.id,
          })
          .returning();

        estateId = estate.id;
        organizationId = org.id;

        logger.info(`Admin created new org ${org.id} and estate ${estate.id} for trial channel`);
      } else if (!existingEstateId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either createNewEstate must be true or existingEstateId must be provided",
        });
      } else {
        // Get org ID from existing estate
        const estate = await ctx.db.query.estate.findFirst({
          where: eq(schema.estate.id, existingEstateId),
        });
        if (!estate) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Estate not found",
          });
        }
        organizationId = estate.organizationId;
      }

      // Get iterate's Slack workspace estate
      const iterateTeamId = env.SLACK_ITERATE_TEAM_ID;
      if (!iterateTeamId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace not configured (missing SLACK_ITERATE_TEAM_ID)",
        });
      }

      const iterateEstateId = await getIterateSlackEstateId(ctx.db, iterateTeamId);
      if (!iterateEstateId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace estate not found",
        });
      }

      // Get iterate's bot account and token
      const iterateBotAccountResult = await ctx.db
        .select({
          accountId: schema.account.id,
          accessToken: schema.account.accessToken,
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

      if (!iterateBotAccountResult[0]?.accessToken) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack bot account not found",
        });
      }

      const iterateBotToken = iterateBotAccountResult[0].accessToken;
      const iterateBotAccountId = iterateBotAccountResult[0].accountId;

      // Link trial estate to iterate's bot account
      await ctx.db
        .insert(schema.estateAccountsPermissions)
        .values({
          accountId: iterateBotAccountId,
          estateId: estateId!,
        })
        .onConflictDoNothing();

      logger.info(`Linked trial estate ${estateId} to iterate's bot account`);

      // Create trial channel and send invite
      const result = await createTrialSlackConnectChannel({
        db: ctx.db,
        userEstateId: estateId!,
        userEmail,
        userName: userName || userEmail.split("@")[0],
        iterateTeamId,
        iterateBotToken,
      });

      if (!result.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.message,
        });
      }

      logger.info(
        `Admin created trial channel ${result.channelName} for ${userEmail} → estate ${estateId}`,
      );

      return {
        success: true,
        estateId: estateId!,
        organizationId,
        channelId: result.channelId,
        channelName: result.channelName,
      };
    }),
});

/**
 * Helper function to sync Slack data for all estates
 * Used by both the tRPC procedure and the scheduled cron job
 */
export async function syncSlackForAllEstatesHelper(db: DB) {
  const estates = await db.query.estate.findMany();

  const syncPromises = estates.map(async (estate) => {
    try {
      const slackToken = await getSlackAccessTokenForEstate(db, estate.id);

      if (!slackToken) {
        return {
          estateId: estate.id,
          estateName: estate.name,
          success: false,
          error: "No Slack token found",
        };
      }

      // Get team ID from provider estate mapping
      const estateMapping = await db.query.providerEstateMapping.findFirst({
        where: and(
          eq(schema.providerEstateMapping.internalEstateId, estate.id),
          eq(schema.providerEstateMapping.providerId, "slack-bot"),
        ),
      });

      if (!estateMapping) {
        return {
          estateId: estate.id,
          estateName: estate.name,
          success: false,
          error: "No Slack team mapping found",
        };
      }

      const result = await syncSlackForEstateInBackground(
        db,
        slackToken,
        estate.id,
        estateMapping.externalId,
      );

      return {
        estateId: estate.id,
        estateName: estate.name,
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        estateId: estate.id,
        estateName: estate.name,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  const results = await Promise.all(syncPromises);

  return {
    total: estates.length,
    results,
  };
}
