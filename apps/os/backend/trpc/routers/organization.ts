import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { waitUntil } from "cloudflare:workers";
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
  listMembers: orgProtectedProcedure.query(async ({ ctx }) => {
    const members = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(schema.organizationUserMembership.organizationId, ctx.organization.id),
      with: {
        user: true,
      },
    });

    return members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
      role: m.role,
      createdAt: m.createdAt,
    }));
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
