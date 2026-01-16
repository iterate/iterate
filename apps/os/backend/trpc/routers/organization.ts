import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  router,
  protectedProcedure,
  protectedMutation,
  orgProtectedProcedure,
  orgAdminMutation,
} from "../trpc.ts";
import {
  organization,
  organizationUserMembership,
  organizationInvite,
  UserRole,
  user,
} from "../../db/schema.ts";
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

  // Create an invite for someone to join the organization
  createInvite: orgAdminMutation
    .input(
      z.object({
        email: z.email(),
        role: z.enum(UserRole).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Check if user is already a member
      const existingUser = await ctx.db.query.user.findFirst({
        where: eq(user.email, input.email),
      });

      if (existingUser) {
        const existingMembership = await ctx.db.query.organizationUserMembership.findFirst({
          where: and(
            eq(organizationUserMembership.organizationId, ctx.organization.id),
            eq(organizationUserMembership.userId, existingUser.id),
          ),
        });

        if (existingMembership) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "User is already a member of this organization",
          });
        }
      }

      // Check if invite already exists
      const existingInvite = await ctx.db.query.organizationInvite.findFirst({
        where: and(
          eq(organizationInvite.organizationId, ctx.organization.id),
          eq(organizationInvite.email, input.email),
        ),
      });

      if (existingInvite) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Invite already sent to this email",
        });
      }

      // Only owners can invite as owner
      if (input.role === "owner" && ctx.membership?.role !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only owners can invite other owners",
        });
      }

      const [invite] = await ctx.db
        .insert(organizationInvite)
        .values({
          organizationId: ctx.organization.id,
          email: input.email,
          invitedByUserId: ctx.user.id,
          role: input.role ?? "member",
        })
        .returning();

      return invite;
    }),

  // List pending invites for the organization
  listInvites: orgProtectedProcedure.query(async ({ ctx }) => {
    const invites = await ctx.db.query.organizationInvite.findMany({
      where: eq(organizationInvite.organizationId, ctx.organization.id),
      with: {
        invitedBy: true,
      },
    });

    return invites.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invitedBy: {
        id: inv.invitedBy.id,
        name: inv.invitedBy.name,
        email: inv.invitedBy.email,
      },
      createdAt: inv.createdAt,
    }));
  }),

  // Cancel/delete an invite
  cancelInvite: orgAdminMutation
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(organizationInvite)
        .where(
          and(
            eq(organizationInvite.id, input.inviteId),
            eq(organizationInvite.organizationId, ctx.organization.id),
          ),
        );

      return { success: true };
    }),

  // Get invites for the current user (across all orgs)
  myPendingInvites: protectedProcedure.query(async ({ ctx }) => {
    const invites = await ctx.db.query.organizationInvite.findMany({
      where: eq(organizationInvite.email, ctx.user.email),
      with: {
        organization: true,
        invitedBy: true,
      },
    });

    return invites.map((inv) => ({
      id: inv.id,
      role: inv.role,
      organization: {
        id: inv.organization.id,
        name: inv.organization.name,
        slug: inv.organization.slug,
      },
      invitedBy: {
        id: inv.invitedBy.id,
        name: inv.invitedBy.name,
      },
      createdAt: inv.createdAt,
    }));
  }),

  // Accept an invite
  acceptInvite: protectedMutation
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.db.query.organizationInvite.findFirst({
        where: and(
          eq(organizationInvite.id, input.inviteId),
          eq(organizationInvite.email, ctx.user.email),
        ),
        with: {
          organization: true,
        },
      });

      if (!invite) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invite not found or not for this user",
        });
      }

      // Add user to organization
      await ctx.db.insert(organizationUserMembership).values({
        organizationId: invite.organizationId,
        userId: ctx.user.id,
        role: invite.role as (typeof UserRole)[number],
      });

      // Delete the invite
      await ctx.db.delete(organizationInvite).where(eq(organizationInvite.id, invite.id));

      return invite.organization;
    }),

  // Decline an invite
  declineInvite: protectedMutation
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.db.query.organizationInvite.findFirst({
        where: and(
          eq(organizationInvite.id, input.inviteId),
          eq(organizationInvite.email, ctx.user.email),
        ),
      });

      if (!invite) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invite not found or not for this user",
        });
      }

      await ctx.db.delete(organizationInvite).where(eq(organizationInvite.id, invite.id));

      return { success: true };
    }),
});
