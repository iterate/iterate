import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import {
  createTrialSlackConnectChannel,
  getIterateSlackEstateId,
  resendSlackConnectInvite,
} from "../../utils/trial-channel-setup.ts";
import { getSlackAccessTokenForEstate } from "../../auth/token-utils.ts";
import { env } from "../../../env.ts";

export const trialRouter = router({
  /**
   * Sets up a trial Slack Connect channel for a new user
   * This is called after Google authentication
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
    .input(
      z.object({
        userEmail: z.string().email(),
        userName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { userEmail, userName } = input;
      const userId = ctx.user.id;

      logger.info(`Setting up Slack Connect trial for ${userEmail}`);

      // 1. Check if a trial estate already exists for this email
      const iterateTeamId = env.SLACK_ITERATE_TEAM_ID;
      if (!iterateTeamId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace not configured (missing SLACK_ITERATE_TEAM_ID)",
        });
      }

      const existingTrialOverrides = await ctx.db.query.slackChannelEstateOverride.findMany({
        where: eq(schema.slackChannelEstateOverride.slackTeamId, iterateTeamId),
        with: {
          estate: {
            with: {
              organization: true,
            },
          },
        },
      });

      // Find any existing trial for this email by checking metadata
      const existingTrial = existingTrialOverrides.find((override) => {
        const metadata = override.metadata as any;
        return metadata?.userEmail === userEmail && metadata?.createdVia === "trial_signup";
      });

      let estate;
      let organization;

      if (existingTrial) {
        // Reuse existing trial estate
        estate = existingTrial.estate;
        organization = estate.organization;
        logger.info(
          `Reusing existing trial estate ${estate.id} for ${userEmail} (organization ${organization.id})`,
        );

        // Ensure current user is added to the organization (if not already)
        const existingMembership = await ctx.db.query.organizationUserMembership.findFirst({
          where: and(
            eq(schema.organizationUserMembership.organizationId, organization.id),
            eq(schema.organizationUserMembership.userId, userId),
          ),
        });

        if (!existingMembership) {
          await ctx.db.insert(schema.organizationUserMembership).values({
            organizationId: organization.id,
            userId: userId,
            role: "owner",
          });
          logger.info(`Added user ${userId} as owner of existing organization ${organization.id}`);
        }
      } else {
        // Create new organization and estate
        [organization] = await ctx.db
          .insert(schema.organization)
          .values({
            name: `${userName}'s Organization`,
          })
          .returning();

        logger.info(`Created organization ${organization.id} for ${userName}`);

        [estate] = await ctx.db
          .insert(schema.estate)
          .values({
            name: `${userName}'s Estate`,
            organizationId: organization.id,
          })
          .returning();

        logger.info(`Created estate ${estate.id} for ${userName}`);

        // Add user to organization as owner
        await ctx.db.insert(schema.organizationUserMembership).values({
          organizationId: organization.id,
          userId: userId,
          role: "owner",
        });

        logger.info(`Added user ${userId} as owner of organization ${organization.id}`);
      }

      // 3. Get iterate's Slack workspace estate
      const iterateEstateId = await getIterateSlackEstateId(ctx.db, iterateTeamId);
      if (!iterateEstateId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace estate not found",
        });
      }

      // 4. Get iterate's bot account and token
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

      // 5. Link trial user's estate to iterate's bot account
      // This gives the trial estate permission to use iterate's bot token for API calls
      await ctx.db
        .insert(schema.estateAccountsPermissions)
        .values({
          accountId: iterateBotAccountId,
          estateId: estate.id,
        })
        .onConflictDoNothing();

      logger.info(`Linked trial estate ${estate.id} to iterate's bot account`);

      // 6. Create provider estate mapping to link trial estate to iterate's Slack workspace
      await ctx.db
        .insert(schema.providerEstateMapping)
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
      const result = await createTrialSlackConnectChannel({
        db: ctx.db,
        userEstateId: estate.id,
        userEmail,
        userName,
        iterateTeamId,
        iterateBotToken,
      });

      if (!result.success) {
        // Don't delete the org/estate - user can retry with different email
        return {
          success: false,
          error: result.error,
          message: result.message,
          estateId: estate.id,
          organizationId: organization.id,
        };
      }

      logger.info(
        `Successfully set up trial for ${userEmail}: channel ${result.channelName} → estate ${estate.id}`,
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
   * Resends Slack Connect invite with a different email address
   * Used when the original email doesn't have a Slack account
   */
  retrySlackConnectInvite: protectedProcedure
    .input(
      z.object({
        estateId: z.string(),
        alternateEmail: z.string().email(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, alternateEmail } = input;

      // Verify user owns this estate
      const membership = await ctx.db.query.organizationUserMembership.findFirst({
        where: eq(schema.organizationUserMembership.userId, ctx.user.id),
        with: {
          organization: {
            with: {
              estates: true,
            },
          },
        },
      });

      const userOwnsEstate = membership?.organization.estates.some((e) => e.id === estateId);
      if (!userOwnsEstate) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have access to this estate",
        });
      }

      // Get the channel override for this estate
      const iterateTeamId = env.SLACK_ITERATE_TEAM_ID;
      if (!iterateTeamId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack workspace not configured",
        });
      }

      const override = await ctx.db.query.slackChannelEstateOverride.findFirst({
        where: and(
          eq(schema.slackChannelEstateOverride.estateId, estateId),
          eq(schema.slackChannelEstateOverride.slackTeamId, iterateTeamId),
        ),
      });

      if (!override) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No trial channel found for this estate",
        });
      }

      // Get iterate's bot token
      const iterateEstateId = await getIterateSlackEstateId(ctx.db, iterateTeamId);
      if (!iterateEstateId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate workspace not found",
        });
      }

      const iterateBotToken = await getSlackAccessTokenForEstate(ctx.db, iterateEstateId);
      if (!iterateBotToken) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate bot token not found",
        });
      }

      // Resend invite
      const result = await resendSlackConnectInvite({
        channelId: override.slackChannelId,
        alternateEmail,
        iterateBotToken,
      });

      if (!result.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.error || "Failed to send invite",
        });
      }

      // Update the override metadata with the new email
      await ctx.db
        .update(schema.slackChannelEstateOverride)
        .set({
          metadata: {
            ...(override.metadata as object),
            invitedEmail: alternateEmail,
            retriedAt: new Date().toISOString(),
          },
        })
        .where(eq(schema.slackChannelEstateOverride.id, override.id));

      logger.info(`Resent Slack Connect invite to ${alternateEmail} for estate ${estateId}`);

      return {
        success: true,
        channelId: override.slackChannelId,
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
        where: eq(schema.estate.id, estateId),
        columns: {
          slackTrialConnectChannelId: true,
          organizationId: true,
        },
      });

      if (!estate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Estate not found",
        });
      }

      if (!estate.slackTrialConnectChannelId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This estate is not a trial estate",
        });
      }

      // Verify user has permission to modify this estate
      const membership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(schema.organizationUserMembership.organizationId, estate.organizationId),
          eq(schema.organizationUserMembership.userId, ctx.user!.id),
        ),
      });

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have permission to modify this estate",
        });
      }

      const iterateTeamId = env.SLACK_ITERATE_TEAM_ID;
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

        // 6. Clear the trial channel ID from the estate
        await tx
          .update(schema.estate)
          .set({
            slackTrialConnectChannelId: null,
          })
          .where(eq(schema.estate.id, estateId));

        logger.info(`Cleared trial channel ID from estate ${estateId}`);
      });

      logger.info(`Successfully upgraded trial estate ${estateId} to full installation`);

      return {
        success: true,
      };
    }),
});
