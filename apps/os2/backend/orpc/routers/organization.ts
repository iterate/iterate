import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { ORPCError, protectedProcedure, orgProtectedProcedure, OrgInput } from "../orpc.ts";
import {
  organization,
  organizationUserMembership,
  UserRole,
  user,
} from "../../db/schema.ts";
import { generateSlug } from "../../utils/slug.ts";
import type { Context } from "../context.ts";

const orgLookup = async (
  db: Context["db"],
  organizationSlug: string,
  userId: string,
  userRole: string | null | undefined,
) => {
  const org = await db.query.organization.findFirst({
    where: eq(organization.slug, organizationSlug),
  });

  if (!org) {
    throw new ORPCError("NOT_FOUND", {
      message: `Organization with slug ${organizationSlug} not found`,
    });
  }

  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.organizationId, org.id),
      eq(organizationUserMembership.userId, userId),
    ),
  });

  if (!membership && userRole !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: "User does not have access to organization",
    });
  }

  return { org, membership };
};

const checkAdmin = (membership: { role: string } | undefined, userRole: string | null | undefined) => {
  if (userRole === "admin") return;
  const role = membership?.role;
  if (!role || (role !== "owner" && role !== "admin")) {
    throw new ORPCError("FORBIDDEN", {
      message: "Only owners and admins can perform this action",
    });
  }
};

export const organizationRouter = {
  create: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(100) }))
    .handler(async ({ context, input }) => {
      const slug = generateSlug(input.name);

      const [newOrg] = await context.db
        .insert(organization)
        .values({
          name: input.name,
          slug,
        })
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

  bySlug: orgProtectedProcedure.handler(async ({ context }) => {
    return {
      ...context.organization,
      role: context.membership?.role,
    };
  }),

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

  update: protectedProcedure
    .input(OrgInput.extend({ name: z.string().min(1).max(100).optional() }))
    .handler(async ({ context, input }) => {
      const { org, membership } = await orgLookup(context.db, input.organizationSlug, context.user.id, context.user.role);
      checkAdmin(membership, context.user.role);

      const [updated] = await context.db
        .update(organization)
        .set({
          ...(input.name && { name: input.name }),
        })
        .where(eq(organization.id, org.id))
        .returning();

      return updated;
    }),

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

  addMember: protectedProcedure
    .input(OrgInput.extend({ email: z.string().email(), role: z.enum(UserRole).optional() }))
    .handler(async ({ context, input }) => {
      const { org, membership } = await orgLookup(context.db, input.organizationSlug, context.user.id, context.user.role);
      checkAdmin(membership, context.user.role);

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
          eq(organizationUserMembership.organizationId, org.id),
          eq(organizationUserMembership.userId, existingUser.id),
        ),
      });

      if (existingMembership) {
        return existingMembership;
      }

      if (input.role === "owner" && membership?.role !== "owner") {
        throw new ORPCError("FORBIDDEN", {
          message: "Only owners can add other owners",
        });
      }

      const [newMembership] = await context.db
        .insert(organizationUserMembership)
        .values({
          organizationId: org.id,
          userId: existingUser.id,
          role: input.role ?? "member",
        })
        .returning();

      if (!newMembership) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Failed to add member",
        });
      }

      return newMembership;
    }),

  updateMemberRole: protectedProcedure
    .input(OrgInput.extend({ userId: z.string(), role: z.enum(UserRole) }))
    .handler(async ({ context, input }) => {
      const { org, membership } = await orgLookup(context.db, input.organizationSlug, context.user.id, context.user.role);
      checkAdmin(membership, context.user.role);

      if (input.userId === context.user.id) {
        throw new ORPCError("FORBIDDEN", {
          message: "Cannot change your own role",
        });
      }

      if (input.role === "owner" && membership?.role !== "owner") {
        throw new ORPCError("FORBIDDEN", {
          message: "Only owners can promote to owner",
        });
      }

      const [updated] = await context.db
        .update(organizationUserMembership)
        .set({ role: input.role })
        .where(
          and(
            eq(organizationUserMembership.organizationId, org.id),
            eq(organizationUserMembership.userId, input.userId),
          ),
        )
        .returning();

      return updated;
    }),

  removeMember: protectedProcedure
    .input(OrgInput.extend({ userId: z.string() }))
    .handler(async ({ context, input }) => {
      const { org, membership } = await orgLookup(context.db, input.organizationSlug, context.user.id, context.user.role);
      checkAdmin(membership, context.user.role);

      if (input.userId === context.user.id) {
        throw new ORPCError("FORBIDDEN", {
          message: "Cannot remove yourself from the organization",
        });
      }

      const targetMembership = await context.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(organizationUserMembership.organizationId, org.id),
          eq(organizationUserMembership.userId, input.userId),
        ),
      });

      if (targetMembership?.role === "owner" && membership?.role !== "owner") {
        throw new ORPCError("FORBIDDEN", {
          message: "Only owners can remove other owners",
        });
      }

      await context.db
        .delete(organizationUserMembership)
        .where(
          and(
            eq(organizationUserMembership.organizationId, org.id),
            eq(organizationUserMembership.userId, input.userId),
          ),
        );

      return { success: true };
    }),

  delete: orgProtectedProcedure.handler(async ({ context }) => {
    checkAdmin(context.membership, context.user.role);

    if (context.membership?.role !== "owner") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only owners can delete organizations",
      });
    }

    await context.db.delete(organization).where(eq(organization.id, context.organization.id));

    return { success: true };
  }),
};
