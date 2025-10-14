import { z } from "zod/v4";
import { eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { waitUntil } from "../../../env.ts";
import {
  protectedProcedure,
  router,
  orgProtectedProcedure,
  orgAdminProcedure,
  getUserOrganizations,
} from "../trpc.ts";
import { schema } from "../../db/client.ts";
import {
  createStripeCustomerAndSubscriptionForOrganization,
  stripeClient,
} from "../../integrations/stripe/stripe.ts";
import { logger } from "../../tag-logger.ts";

type SlackUserProperties = {
  discoveredInChannels: string[] | undefined;
  slackUsername: string | undefined;
  slackRealName: string | undefined;
};

type OrganizationMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  isBot: boolean;
  createdAt: Date;
} & SlackUserProperties;

export const organizationRouter = router({
  // List all organizations the user has access to (excluding external)
  list: protectedProcedure.query(async ({ ctx }) => {
    const userOrganizations = await getUserOrganizations(ctx.db, ctx.user.id);

    return userOrganizations.map(({ organization, role }) => ({
      id: organization.id,
      name: organization.name,
      role,
      stripeCustomerId: organization.stripeCustomerId,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    }));
  }),

  // Create a new organization
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Organization name is required"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Create the organization
      const [organization] = await ctx.db
        .insert(schema.organization)
        .values({ name: input.name })
        .returning();

      if (!organization) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create organization",
        });
      }

      // Make the current user the owner
      await ctx.db.insert(schema.organizationUserMembership).values({
        organizationId: organization.id,
        userId: ctx.user.id,
        role: "owner",
      });

      // Create a default estate for this organization
      const [estate] = await ctx.db
        .insert(schema.estate)
        .values({
          name: `${input.name} Estate`,
          organizationId: organization.id,
        })
        .returning();

      if (!estate) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create default estate",
        });
      }

      // Create Stripe customer and subscribe in the background (non-blocking)
      waitUntil(
        createStripeCustomerAndSubscriptionForOrganization(ctx.db, organization, ctx.user).catch(
          () => {
            // Error is already logged in the helper function
          },
        ),
      );

      return {
        organization,
        estate,
      };
    }),

  // Get organization by ID
  get: orgProtectedProcedure.query(async ({ ctx }) => {
    return ctx.organization;
  }),

  // Update organization name
  updateName: orgAdminProcedure
    .input(
      z.object({
        name: z.string().min(1, "Organization name is required"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updatedOrganization] = await ctx.db
        .update(schema.organization)
        .set({ name: input.name })
        .where(eq(schema.organization.id, ctx.organization.id))
        .returning();

      if (!updatedOrganization) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update organization",
        });
      }

      const stripeCustomerId = updatedOrganization.stripeCustomerId;

      if (stripeCustomerId) {
        waitUntil(
          (async () => {
            try {
              await stripeClient.customers.update(stripeCustomerId, {
                name: updatedOrganization.name,
              });
            } catch (error) {
              logger.error(
                `Failed to update Stripe customer ${stripeCustomerId} for organization ${updatedOrganization.id}`,
                error,
              );
            }
          })(),
        );
      }

      return updatedOrganization;
    }),

  // List all members of an organization
  listMembers: orgProtectedProcedure.query(async ({ ctx }): Promise<OrganizationMember[]> => {
    const members = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(schema.organizationUserMembership.organizationId, ctx.organization.id),
      with: {
        user: true,
      },
    });

    // Get estate for this organization to fetch slack channels
    const estate = await ctx.db.query.estate.findFirst({
      where: eq(schema.estate.organizationId, ctx.organization.id),
    });

    // Fetch slack channels and metadata for all users
    const channelsByUser = new Map<string, string[]>();

    if (estate && members.length > 0) {
      // Fetch provider mappings for all users to get Slack usernames
      const providerMappings = await ctx.db.query.providerUserMapping.findMany({
        where: inArray(
          schema.providerUserMapping.internalUserId,
          members.map((m) => m.user.id),
        ),
      });

      // Fetch all slack channels for this estate
      const slackChannels = await ctx.db.query.slackChannel.findMany({
        where: eq(schema.slackChannel.estateId, estate.id),
      });

      const channelMap = new Map(slackChannels.map((c) => [c.externalId, c.name]));

      // Extract channel names and user metadata for each external user
      const userMetadataMap = new Map<string, { slackUsername?: string; slackRealName?: string }>();

      for (const mapping of providerMappings) {
        const metadata = mapping.providerMetadata as any;
        const discoveredChannels = metadata?.discoveredInChannels as string[] | undefined;

        // Extract Slack username and real name
        userMetadataMap.set(mapping.internalUserId, {
          slackUsername: metadata?.name,
          slackRealName: metadata?.profile?.real_name || metadata?.real_name,
        });

        if (discoveredChannels && Array.isArray(discoveredChannels)) {
          const channelNames = discoveredChannels
            .map((channelId) => channelMap.get(channelId))
            .filter((name): name is string => name !== undefined);

          if (channelNames.length > 0) {
            channelsByUser.set(mapping.internalUserId, channelNames);
          }
        }
      }

      return members.map((m): OrganizationMember => {
        const isGuestOrExternal = ["external", "guest"].includes(m.role);
        const userMetadata = userMetadataMap.get(m.user.id);
        return {
          id: m.id,
          userId: m.user.id,
          name: m.user.name,
          email: m.user.email,
          image: m.user.image,
          role: m.role,
          isBot: m.user.isBot,
          createdAt: m.createdAt,
          discoveredInChannels: isGuestOrExternal ? channelsByUser.get(m.user.id) || [] : undefined,
          slackUsername: userMetadata?.slackUsername,
          slackRealName: userMetadata?.slackRealName,
        };
      });
    }

    // If no estate found, return basic member info without Slack metadata
    return members.map(
      (m): OrganizationMember => ({
        id: m.id,
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
        role: m.role,
        isBot: m.user.isBot,
        createdAt: m.createdAt,
        discoveredInChannels: undefined,
        slackUsername: undefined,
        slackRealName: undefined,
      }),
    );
  }),

  // Update a member's role
  updateMemberRole: orgAdminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(["member", "admin", "owner", "guest"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Prevent users from changing their own role
      if (input.userId === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot change your own role",
        });
      }

      // Get the membership to update
      const membershipToUpdate = await ctx.db.query.organizationUserMembership.findFirst({
        where: (membership, { and, eq }) =>
          and(
            eq(membership.organizationId, ctx.organization.id),
            eq(membership.userId, input.userId),
          ),
      });

      if (!membershipToUpdate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Member not found in this organization",
        });
      }

      // Update the member's role
      const [updatedMembership] = await ctx.db
        .update(schema.organizationUserMembership)
        .set({ role: input.role })
        .where(eq(schema.organizationUserMembership.id, membershipToUpdate.id))
        .returning();

      if (!updatedMembership) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update member role",
        });
      }

      return updatedMembership;
    }),
});
