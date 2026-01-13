import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedMutation, orgProtectedProcedure, orgAdminMutation } from "../trpc.ts";
import { organization, organizationUserMembership, UserRole, user } from "../../db/schema.ts";
import { slugify, slugifyWithSuffix } from "../../utils/slug.ts";

export const organizationRouter = router({
  create: protectedMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const baseSlug = slugify(input.name);
      const existing = await ctx.db.query.organization.findFirst({
        where: eq(organization.slug, baseSlug),
      });

      const slug = existing ? slugifyWithSuffix(input.name) : baseSlug;

      const [newOrg] = await ctx.db
        .insert(organization)
        .values({ name: input.name, slug })
        .returning();

      if (!newOrg) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create organization",
        });
      }

      await ctx.db.insert(organizationUserMembership).values({
        organizationId: newOrg.id,
        userId: ctx.user.id,
        role: "owner",
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

  // Get organization with projects
  withProjects: orgProtectedProcedure.query(async ({ ctx }) => {
    const org = await ctx.db.query.organization.findFirst({
      where: eq(organization.id, ctx.organization.id),
      with: {
        projects: true,
      },
    });

    return {
      ...org,
      role: ctx.membership?.role,
    };
  }),

  // Update organization settings
  update: orgAdminMutation
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

  addMember: orgAdminMutation
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(UserRole).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existingUser = await ctx.db.query.user.findFirst({
        where: eq(user.email, input.email),
      });

      if (!existingUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      const existingMembership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(organizationUserMembership.organizationId, ctx.organization.id),
          eq(organizationUserMembership.userId, existingUser.id),
        ),
      });

      if (existingMembership) {
        return existingMembership;
      }

      if (input.role === "owner" && ctx.membership?.role !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only owners can add other owners",
        });
      }

      const [membership] = await ctx.db
        .insert(organizationUserMembership)
        .values({
          organizationId: ctx.organization.id,
          userId: existingUser.id,
          role: input.role ?? "member",
        })
        .returning();

      if (!membership) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to add member",
        });
      }

      return membership;
    }),

  // Update member role
  updateMemberRole: orgAdminMutation
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
  removeMember: orgAdminMutation
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
  delete: orgAdminMutation.mutation(async ({ ctx }) => {
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
