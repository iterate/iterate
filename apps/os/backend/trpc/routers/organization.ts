import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import {
  ORPCError,
  protectedProcedure,
  protectedMutation,
  orgProtectedProcedure,
  orgAdminMutation,
  withOrgAdminMutationInput,
} from "../trpc.ts";
import {
  organization,
  organizationUserMembership,
  organizationInvite,
  UserRole,
  user,
} from "../../db/schema.ts";
import { slugify } from "../../utils/slug.ts";

export const organizationRouter = {
  create: protectedMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .handler(async ({ context, input }) => {
      const slug = slugify(input.name);
      const existing = await context.db.query.organization.findFirst({
        where: eq(organization.slug, slug),
      });

      if (existing) {
        throw new ORPCError("CONFLICT", {
          message: "An organization with this name already exists",
        });
      }

      const [newOrg] = await context.db
        .insert(organization)
        .values({ name: input.name, slug })
        .returning();

      if (!newOrg) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Failed to create organization",
        });
      }

      await context.db.insert(organizationUserMembership).values({
        organizationId: newOrg.id,
        userId: context.user.id,
        role: "owner",
      });

      return newOrg;
    }),

  // Get organization by slug
  bySlug: orgProtectedProcedure.handler(async ({ context }) => {
    return {
      ...context.organization,
      role: context.membership?.role,
    };
  }),

  // Get organization with projects
  withProjects: orgProtectedProcedure.handler(async ({ context }) => {
    const org = await context.db.query.organization.findFirst({
      where: eq(organization.id, context.organization.id),
      with: {
        projects: true,
      },
    });

    return {
      ...org,
      role: context.membership?.role,
    };
  }),

  // Update organization settings
  update: withOrgAdminMutationInput({
    name: z.string().min(1).max(100).optional(),
  }).handler(async ({ context, input }) => {
    const [updated] = await context.db
      .update(organization)
      .set({
        ...(input.name && { name: input.name }),
      })
      .where(eq(organization.id, context.organization.id))
      .returning();

    return updated;
  }),

  // Get organization members
  members: orgProtectedProcedure.handler(async ({ context }) => {
    const members = await context.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.organizationId, context.organization.id),
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

  addMember: withOrgAdminMutationInput({
    email: z.string().email(),
    role: z.enum(UserRole).optional(),
  }).handler(async ({ context, input }) => {
    const existingUser = await context.db.query.user.findFirst({
      where: eq(user.email, input.email),
    });

    if (!existingUser) {
      throw new ORPCError("NOT_FOUND", {
        message: "User not found",
      });
    }

    const existingMembership = await context.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(organizationUserMembership.organizationId, context.organization.id),
        eq(organizationUserMembership.userId, existingUser.id),
      ),
    });

    if (existingMembership) {
      return existingMembership;
    }

    if (input.role === "owner" && context.membership?.role !== "owner") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only owners can add other owners",
      });
    }

    const [membership] = await context.db
      .insert(organizationUserMembership)
      .values({
        organizationId: context.organization.id,
        userId: existingUser.id,
        role: input.role ?? "member",
      })
      .returning();

    if (!membership) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to add member",
      });
    }

    return membership;
  }),

  // Update member role
  updateMemberRole: withOrgAdminMutationInput({
    userId: z.string(),
    role: z.enum(UserRole),
  }).handler(async ({ context, input }) => {
    // Can't change your own role
    if (input.userId === context.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "Cannot change your own role",
      });
    }

    // Only owners can promote to owner
    if (input.role === "owner" && context.membership?.role !== "owner") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only owners can promote to owner",
      });
    }

    const [updated] = await context.db
      .update(organizationUserMembership)
      .set({ role: input.role })
      .where(
        and(
          eq(organizationUserMembership.organizationId, context.organization.id),
          eq(organizationUserMembership.userId, input.userId),
        ),
      )
      .returning();

    return updated;
  }),

  // Remove member from organization
  removeMember: withOrgAdminMutationInput({
    userId: z.string(),
  }).handler(async ({ context, input }) => {
    // Can't remove yourself
    if (input.userId === context.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "Cannot remove yourself from the organization",
      });
    }

    // Check if trying to remove an owner
    const targetMembership = await context.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(organizationUserMembership.organizationId, context.organization.id),
        eq(organizationUserMembership.userId, input.userId),
      ),
    });

    if (targetMembership?.role === "owner" && context.membership?.role !== "owner") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only owners can remove other owners",
      });
    }

    await context.db
      .delete(organizationUserMembership)
      .where(
        and(
          eq(organizationUserMembership.organizationId, context.organization.id),
          eq(organizationUserMembership.userId, input.userId),
        ),
      );

    return { success: true };
  }),

  // Delete organization (owner only)
  delete: orgAdminMutation.handler(async ({ context }) => {
    if (context.membership?.role !== "owner") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only owners can delete organizations",
      });
    }

    await context.db.delete(organization).where(eq(organization.id, context.organization.id));

    return { success: true };
  }),

  // Create an invite for someone to join the organization
  createInvite: withOrgAdminMutationInput({
    email: z.email(),
    role: z.enum(UserRole).optional(),
  }).handler(async ({ context, input }) => {
    // Check if user is already a member
    const existingUser = await context.db.query.user.findFirst({
      where: eq(user.email, input.email),
    });

    if (existingUser) {
      const existingMembership = await context.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(organizationUserMembership.organizationId, context.organization.id),
          eq(organizationUserMembership.userId, existingUser.id),
        ),
      });

      if (existingMembership) {
        throw new ORPCError("CONFLICT", {
          message: "User is already a member of this organization",
        });
      }
    }

    // Check if invite already exists
    const existingInvite = await context.db.query.organizationInvite.findFirst({
      where: and(
        eq(organizationInvite.organizationId, context.organization.id),
        eq(organizationInvite.email, input.email),
      ),
    });

    if (existingInvite) {
      throw new ORPCError("CONFLICT", {
        message: "Invite already sent to this email",
      });
    }

    // Only owners can invite as owner
    if (input.role === "owner" && context.membership?.role !== "owner") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only owners can invite other owners",
      });
    }

    const [invite] = await context.db
      .insert(organizationInvite)
      .values({
        organizationId: context.organization.id,
        email: input.email,
        invitedByUserId: context.user.id,
        role: input.role ?? "member",
      })
      .returning();

    return invite;
  }),

  // List pending invites for the organization
  listInvites: orgProtectedProcedure.handler(async ({ context }) => {
    const invites = await context.db.query.organizationInvite.findMany({
      where: eq(organizationInvite.organizationId, context.organization.id),
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
  cancelInvite: withOrgAdminMutationInput({
    inviteId: z.string(),
  }).handler(async ({ context, input }) => {
    await context.db
      .delete(organizationInvite)
      .where(
        and(
          eq(organizationInvite.id, input.inviteId),
          eq(organizationInvite.organizationId, context.organization.id),
        ),
      );

    return { success: true };
  }),

  // Get invites for the current user (across all orgs)
  myPendingInvites: protectedProcedure.handler(async ({ context }) => {
    const invites = await context.db.query.organizationInvite.findMany({
      where: eq(organizationInvite.email, context.user.email),
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
    .handler(async ({ context, input }) => {
      const invite = await context.db.query.organizationInvite.findFirst({
        where: and(
          eq(organizationInvite.id, input.inviteId),
          eq(organizationInvite.email, context.user.email),
        ),
        with: {
          organization: true,
        },
      });

      if (!invite) {
        throw new ORPCError("NOT_FOUND", {
          message: "Invite not found or not for this user",
        });
      }

      // Add user to organization
      await context.db.insert(organizationUserMembership).values({
        organizationId: invite.organizationId,
        userId: context.user.id,
        role: invite.role as (typeof UserRole)[number],
      });

      // Delete the invite
      await context.db.delete(organizationInvite).where(eq(organizationInvite.id, invite.id));

      return invite.organization;
    }),

  // Decline an invite
  declineInvite: protectedMutation
    .input(z.object({ inviteId: z.string() }))
    .handler(async ({ context, input }) => {
      const invite = await context.db.query.organizationInvite.findFirst({
        where: and(
          eq(organizationInvite.id, input.inviteId),
          eq(organizationInvite.email, context.user.email),
        ),
      });

      if (!invite) {
        throw new ORPCError("NOT_FOUND", {
          message: "Invite not found or not for this user",
        });
      }

      await context.db.delete(organizationInvite).where(eq(organizationInvite.id, invite.id));

      return { success: true };
    }),

  // Leave an organization (self-removal)
  leave: orgProtectedProcedure.handler(async ({ context }) => {
    await context.db
      .delete(organizationUserMembership)
      .where(
        and(
          eq(organizationUserMembership.organizationId, context.organization.id),
          eq(organizationUserMembership.userId, context.user.id),
        ),
      );

    return { success: true };
  }),
};
