import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc.ts";
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

      // 1. Create organization
      const [organization] = await ctx.db
        .insert(schema.organization)
        .values({
          name: `${userName}'s Organization`,
        })
        .returning();

      logger.info(`Created organization ${organization.id} for ${userName}`);

      // 2. Create estate
      const [estate] = await ctx.db
        .insert(schema.estate)
        .values({
          name: `${userName}'s Estate`,
          organizationId: organization.id,
        })
        .returning();

      logger.info(`Created estate ${estate.id} for ${userName}`);

      // 3. Add user to organization as owner
      await ctx.db.insert(schema.organizationUserMembership).values({
        organizationId: organization.id,
        userId: userId,
        role: "owner",
      });

      logger.info(`Added user ${userId} as owner of organization ${organization.id}`);

      // 4. Get iterate's Slack workspace estate
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

      // 5. Get iterate's bot token
      const iterateBotToken = await getSlackAccessTokenForEstate(ctx.db, iterateEstateId);
      if (!iterateBotToken) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Iterate Slack bot token not found",
        });
      }

      // 6. Create trial channel and send invite
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
});
