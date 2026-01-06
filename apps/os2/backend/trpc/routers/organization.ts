import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, orgProtectedProcedure, orgAdminProcedure } from "../trpc.ts";
import {
  organization,
  organizationUserMembership,
  instance,
  UserRole,
} from "../../db/schema.ts";
import { generateSlug } from "../../utils/slug.ts";

export const organizationRouter = router({
  // Create a new organization
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = generateSlug(input.name);

      const [newOrg] = await ctx.db
        .insert(organization)
        .values({
          name: input.name,
          slug,
        })
        .returning();

      if (!newOrg) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create organization",
        });
      }

      // Add creator as owner
      await ctx.db.insert(organizationUserMembership).values({
        organizationId: newOrg.id,
        userId: ctx.user.id,
        role: "owner",
      });

      // Create default instance
      const instanceSlug = generateSlug("default");
      await ctx.db.insert(instance).values({
        name: "Default Instance",
        slug: instanceSlug,
        organizationId: newOrg.id,
      });

      return newOrg;
    }),

  // Get organization by slug
  bySlug: orgProtectedProcedure.query(async ({ ctx }) => {
    return {
      ...ctx.organization,
      role: ctx.membership?.role,
    };
  }),

  // Get organization with instances
  withInstances: orgProtectedProcedure.query(async ({ ctx }) => {
    const org = await ctx.db.query.organization.findFirst({
      where: eq(organization.id, ctx.organization.id),
      with: {
        instances: true,
      },
    });

    return {
      ...org,
      role: ctx.membership?.role,
    };
  }),

  // Update organization settings
  update: orgAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(organization)
        .set({
          ...(input.name && { name: input.name }),
        })
        .where(eq(organization.id, ctx.organization.id))
        .returning();

      return updated;
    }),

  // Get organization members
  members: orgProtectedProcedure.query(async ({ ctx }) => {
    const members = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.organizationId, ctx.organization.id),
      with: {
        user: true,
      },
    });

    return members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      user: {
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
      },
      createdAt: m.createdAt,
    }));
  }),

  // Update member role
  updateMemberRole: orgAdminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(UserRole),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Can't change your own role
      if (input.userId === ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot change your own role",
        });
      }

      // Only owners can promote to owner
      if (input.role === "owner" && ctx.membership?.role !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only owners can promote to owner",
        });
      }

      const [updated] = await ctx.db
        .update(organizationUserMembership)
        .set({ role: input.role })
        .where(
          and(
            eq(organizationUserMembership.organizationId, ctx.organization.id),
            eq(organizationUserMembership.userId, input.userId),
          ),
        )
        .returning();

      return updated;
    }),

  // Remove member from organization
  removeMember: orgAdminProcedure
    .input(
      z.object({
        userId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Can't remove yourself
      if (input.userId === ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot remove yourself from the organization",
        });
      }

      // Check if trying to remove an owner
      const targetMembership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(organizationUserMembership.organizationId, ctx.organization.id),
          eq(organizationUserMembership.userId, input.userId),
        ),
      });

      if (targetMembership?.role === "owner" && ctx.membership?.role !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only owners can remove other owners",
        });
      }

      await ctx.db
        .delete(organizationUserMembership)
        .where(
          and(
            eq(organizationUserMembership.organizationId, ctx.organization.id),
            eq(organizationUserMembership.userId, input.userId),
          ),
        );

      return { success: true };
    }),

  // Delete organization (owner only)
  delete: orgAdminProcedure.mutation(async ({ ctx }) => {
    if (ctx.membership?.role !== "owner") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only owners can delete organizations",
      });
    }

    await ctx.db.delete(organization).where(eq(organization.id, ctx.organization.id));

    return { success: true };
  }),
});
