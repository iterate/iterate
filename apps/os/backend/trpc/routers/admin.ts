import { z } from "zod";
import { and, eq, desc, like, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { parseRouter, type AnyRouter } from "trpc-cli";
import { typeid } from "typeid-js";
import { protectedProcedure, protectedProcedureWithNoEstateRestrictions, router } from "../trpc.ts";
import { schema } from "../../db/client.ts";
import { sendNotificationToIterateSlack } from "../../integrations/slack/slack-utils.ts";
import { syncSlackForInstallationInBackground } from "../../integrations/slack/slack.ts";
import { getSlackAccessTokenForEstate } from "../../auth/token-utils.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "../../integrations/stripe/stripe.ts";
import type { DB } from "../../db/client.ts";
import { getAuth } from "../../auth/auth.ts";
import { createUserOrganizationAndInstallation } from "../../org-utils.ts";
import { logger } from "../../tag-logger.ts";
import { E2ETestParams } from "../../utils/test-helpers/onboarding-test-schema.ts";
import {
  createTrialSlackConnectChannel,
  getIterateSlackInstallationId,
} from "../../utils/trial-channel-setup.ts";
import { env } from "../../../env.ts";
import { recentActiveSources } from "../../db/helpers.ts";
import { queuer } from "../../outbox/outbox-queuer.ts";
import { outboxClient } from "../../outbox/client.ts";
import { deleteUserAccount } from "./user.ts";

// don't use `protectedProcedure` because that prevents the use of `installationId`. safe to use without the restrictions because we're checking the user is an admin
const adminProcedure = protectedProcedureWithNoEstateRestrictions.use(({ ctx, next }) => {
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

const getInstallationOwner = adminProcedure
  .input(z.object({ installationId: z.string() }))
  .query(async ({ ctx, input }) => {
    const installation = await ctx.db.query.installation.findFirst({
      where: eq(schema.installation.id, input.installationId),
    });

    if (!installation) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Installation not found",
      });
    }

    const ownerMembership = await ctx.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(schema.organizationUserMembership.organizationId, installation.organizationId),
        eq(schema.organizationUserMembership.role, "owner"),
      ),
      with: {
        user: true,
      },
    });

    if (!ownerMembership?.user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Installation owner not found",
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

  const { organization, installation } = await createUserOrganizationAndInstallation(ctx.db, user);

  if (!installation) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create installation",
    });
  }

  let hasSeedData = false;
  if (ctx.env.ONBOARDING_E2E_TEST_SETUP_PARAMS) {
    try {
      const seedData = E2ETestParams.parse(JSON.parse(ctx.env.ONBOARDING_E2E_TEST_SETUP_PARAMS));

      const [_userAccount, botAccount] = await ctx.db
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
        ])
        .onConflictDoNothing()
        .returning();

      await ctx.db
        .insert(schema.providerInstallationMapping)
        .values([
          {
            providerId: "slack-bot",
            internalInstallationId: installation.id,
            externalId: seedData.slack.teamId,
            providerMetadata: {
              botUserId: seedData.slack.bot.id,
            },
          },
        ])
        .onConflictDoNothing();

      await ctx.db
        .insert(schema.installationAccountsPermissions)
        .values([
          {
            accountId: botAccount.id,
            installationId: installation.id,
          },
        ])
        .onConflictDoNothing();

      hasSeedData = true;
    } catch (error) {
      logger.error(`Failed to setup test onboarding user: ${error}`);
    }
  }

  return { user, organization, installation, hasSeedData };
});

const markTestUserAsOnboarded = adminProcedure
  .input(
    z.object({
      organizationId: z.string(),
      installationId: z.string(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.db.insert(schema.installationOnboardingEvent).values({
      installationId: input.installationId,
      organizationId: input.organizationId,
      eventType: "OnboardingCompleted",
      category: "user",
    });
    await ctx.db
      .update(schema.organization)
      .set({
        stripeCustomerId: "TEST_CUSTOMER_ID",
      })
      .where(eq(schema.organization.id, input.organizationId));
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
  getInstallationOwner,
  deleteUserByEmail,
  setupTestOnboardingUser,
  markTestUserAsOnboarded,
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
  listAllInstallations: adminProcedure.query(async ({ ctx }) => {
    const installations = await ctx.db.query.installation.findMany({
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
        ...recentActiveSources,
      },
      orderBy: desc(schema.installation.updatedAt),
    });

    return installations.map((installation) => ({
      id: installation.id,
      name: installation.name,
      organizationId: installation.organizationId,
      organizationName: installation.organization.name,
      ownerEmail: installation.organization.members[0]?.user.email,
      ownerName: installation.organization.members[0]?.user.name,
      ownerId: installation.organization.members[0]?.user.id,
      connectedRepoId: installation.sources?.[0]?.repoId ?? null,
      connectedRepoPath: installation.sources?.[0]?.path ?? null,
      connectedRepoRef: installation.sources?.[0]?.branch ?? null,
      createdAt: installation.createdAt,
      updatedAt: installation.updatedAt,
    }));
  }),
  rebuildInstallation: adminProcedure
    .input(z.object({ installationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { triggerInstallationRebuild } = await import("./installation.ts");

      const _installationData = await ctx.db.query.installation.findFirst({
        where: eq(schema.installation.id, input.installationId),
        with: recentActiveSources,
      });

      const installationData = {
        ..._installationData,
        connectedRepoId: _installationData?.sources?.[0]?.repoId ?? null,
        connectedRepoRef: _installationData?.sources?.[0]?.branch ?? null,
        connectedRepoPath: _installationData?.sources?.[0]?.path ?? null,
      };

      if (!installationData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Installation not found",
        });
      }

      if (!installationData.connectedRepoId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Installation has no connected repository",
        });
      }

      const result = await triggerInstallationRebuild({
        db: ctx.db,
        env: ctx.env,
        installationId: input.installationId,
        commitHash: installationData.connectedRepoRef || "main",
        commitMessage: "Manual rebuild triggered by admin",
        isManual: true,
      });

      return { success: true, buildId: result.id };
    }),
  rebuildAllInstallations: adminProcedure.mutation(async ({ ctx }) => {
    const { triggerInstallationRebuild } = await import("./installation.ts");

    const installations = await ctx.db.query.installation.findMany({
      with: recentActiveSources,
    });

    const results = [];

    for (const installation of installations) {
      if (!installation.sources.at(0)?.repoId) {
        results.push({
          installationId: installation.id,
          installationName: installation.name,
          success: false,
          error: "No connected repository",
        });
        continue;
      }

      try {
        const result = await triggerInstallationRebuild({
          db: ctx.db,
          env: ctx.env,
          installationId: installation.id,
          commitHash: installation.sources.at(0)?.branch || "main",
          commitMessage: "Bulk rebuild triggered by admin",
          isManual: true,
        });

        results.push({
          installationId: installation.id,
          installationName: installation.name,
          success: true,
          buildId: result.id,
        });
      } catch (error) {
        results.push({
          installationId: installation.id,
          installationName: installation.name,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return {
      total: installations.length,
      results,
    };
  }),
  syncSlackForInstallation: adminProcedure
    .input(z.object({ installationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const slackAccount = await getSlackAccessTokenForEstate(ctx.db, input.installationId);

      if (!slackAccount) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No Slack token found for this installation",
        });
      }

      // Get team ID from provider installation mapping
      const installationMapping = await ctx.db.query.providerInstallationMapping.findFirst({
        where: and(
          eq(schema.providerInstallationMapping.internalInstallationId, input.installationId),
          eq(schema.providerInstallationMapping.providerId, "slack-bot"),
        ),
      });

      if (!installationMapping) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No Slack team mapping found for this installation",
        });
      }

      return await syncSlackForInstallationInBackground(
        ctx.db,
        slackAccount.accessToken,
        input.installationId,
        installationMapping.externalId,
      );
    }),
  syncSlackForAllInstallations: adminProcedure.mutation(async ({ ctx }) => {
    return await syncSlackForAllInstallationsHelper(ctx.db);
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
        userEmail: z.email(),
        userName: z.string().optional(),
        existingInstallationId: z.string().optional(),
        createNewEstate: z.boolean().default(true),
        estateName: z.string().optional(),
        organizationName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const {
        userEmail,
        userName,
        existingInstallationId,
        createNewEstate,
        estateName,
        organizationName,
      } = input;

      let installationId = existingInstallationId;
      let organizationId: string | undefined;

      // Create estate/org if needed
      if (createNewEstate) {
        const [org] = await ctx.db
          .insert(schema.organization)
          .values({
            name: organizationName || `${userName || userEmail}'s Organization`,
          })
          .returning();

        const [installation] = await ctx.db
          .insert(schema.installation)
          .values({
            name: estateName || `${userName || userEmail}'s Installation`,
            organizationId: org.id,
            slug: typeid("ins").toString(),
          })
          .returning();

        installationId = installation.id;
        organizationId = org.id;

        logger.info(
          `Admin created new org ${org.id} and installation ${installation.id} for trial channel`,
        );
      } else if (!existingInstallationId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either createNewEstate must be true or existingInstallationId must be provided",
        });
      } else {
        // Get org ID from existing estate
        const estate = await ctx.db.query.installation.findFirst({
          where: eq(schema.installation.id, existingInstallationId),
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
        throw new Error("Iterate Slack workspace not configured (missing SLACK_ITERATE_TEAM_ID)");
      }

      const iterateInstallationId = await getIterateSlackInstallationId(ctx.db);
      if (!iterateInstallationId) {
        throw new Error("Iterate Slack workspace estate not found");
      }

      // Get iterate's bot account and token
      const iterateBotAccount = await getSlackAccessTokenForEstate(ctx.db, iterateInstallationId);
      if (!iterateBotAccount) {
        throw new Error("Iterate Slack bot account not found");
      }

      // Link trial estate to iterate's bot account
      await ctx.db
        .insert(schema.installationAccountsPermissions)
        .values({
          accountId: iterateBotAccount.accountId,
          installationId: installationId!,
        })
        .onConflictDoNothing();

      logger.info(`Linked trial estate ${installationId} to iterate's bot account`);

      // Create trial channel and send invite
      const result = await createTrialSlackConnectChannel({
        db: ctx.db,
        userInstallationId: installationId!,
        userEmail,
        userName: userName || userEmail.split("@")[0],
        iterateTeamId,
        iterateBotToken: iterateBotAccount.accessToken,
      });

      logger.info(
        `Admin created trial channel ${result.channelName} for ${userEmail} → estate ${installationId}`,
      );

      return {
        success: true,
        installationId: installationId!,
        organizationId,
        channelId: result.channelId,
        channelName: result.channelName,
      };
    }),

  outbox: {
    poke: adminProcedure
      .meta({
        description:
          "Emit a meaningless message into the outbox queue. Note that consumers are defined separately, so may or may not choose to subscribe to this mutation.",
      })
      .input(z.object({ message: z.string() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.db.transaction(async (tx) => {
          const [{ now: dbtime }] = await tx.execute(sql`select now()`);
          const reply = `You used ${input.message.split(" ").length} words, well done.`;
          return ctx.sendTrpc(tx, { dbtime, reply });
        });
      }),
    pokeOutboxClientDirectly: adminProcedure
      .input(z.object({ message: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await outboxClient.sendTx(ctx.db, "testing:poke", async (tx) => {
          const [{ now: dbtime }] = await tx.execute<{ now: string }>(sql`select now()::text`);
          return {
            payload: { dbtime: dbtime, message: `${input.message} at ${new Date().toISOString()}` },
          };
        });
        return { done: true };
      }),
    peek: adminProcedure
      .meta({
        description:
          "Peek at the outbox queue. Use drizzle studio to filter based on read count, visibility time, event name, consumer name, look at archive queue etc.",
      })
      .input(
        z
          .object({
            limit: z.number().optional(),
            offset: z.number().optional(),
            minReadCount: z.number().optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        return await queuer.peekQueue(ctx.db, input);
      }),
    peekArchive: adminProcedure
      .meta({
        description:
          "Peek at the outbox archive queue. Use drizzle studio to filter based on read count, visibility time, event name, consumer name, look at archive queue etc.",
      })
      .input(
        z
          .object({
            limit: z.number().optional(),
            offset: z.number().optional(),
            minReadCount: z.number().optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        return await queuer.peekArchive(ctx.db, input);
      }),
    process: adminProcedure
      .meta({
        description:
          "Process the outbox queue. This *shoulud* be happening automatically after events are added, and in a cron job",
      })
      .mutation(async ({ ctx }) => {
        return await queuer.processQueue(ctx.db);
      }),
  },
});

/**
 * Helper function to sync Slack data for all installations
 * Used by both the tRPC procedure and the scheduled cron job
 */
export async function syncSlackForAllInstallationsHelper(db: DB) {
  const installations = await db.query.installation.findMany();

  const syncPromises = installations.map(async (installation) => {
    try {
      const slackAccount = await getSlackAccessTokenForEstate(db, installation.id);

      if (!slackAccount) {
        return {
          installationId: installation.id,
          installationName: installation.name,
          success: false,
          error: "No Slack token found",
        };
      }

      // Get team ID from provider installation mapping
      const installationMapping = await db.query.providerInstallationMapping.findFirst({
        where: and(
          eq(schema.providerInstallationMapping.internalInstallationId, installation.id),
          eq(schema.providerInstallationMapping.providerId, "slack-bot"),
        ),
      });

      if (!installationMapping) {
        return {
          installationId: installation.id,
          installationName: installation.name,
          success: false,
          error: "No Slack team mapping found",
        };
      }

      const result = await syncSlackForInstallationInBackground(
        db,
        slackAccount.accessToken,
        installation.id,
        installationMapping.externalId,
      );

      return {
        installationId: installation.id,
        installationName: installation.name,
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        installationId: installation.id,
        installationName: installation.name,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  const results = await Promise.all(syncPromises);

  return {
    total: installations.length,
    results,
  };
}
