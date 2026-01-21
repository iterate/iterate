import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { protectedProcedure, protectedMutation } from "../trpc.ts";
import { user, organizationUserMembership } from "../../db/schema.ts";

export const userRouter = {
  // Get current user
  me: protectedProcedure.handler(async ({ context }) => {
    return context.user;
  }),

  // Get user's organizations
  myOrganizations: protectedProcedure.handler(async ({ context }) => {
    const memberships = await context.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.userId, context.user.id),
      with: {
        organization: {
          with: {
            projects: true,
          },
        },
      },
    });

    return memberships.map((m) => ({
      ...m.organization,
      role: m.role,
    }));
  }),

  // Get user's memberships with org details (for settings page)
  memberships: protectedProcedure.handler(async ({ context }) => {
    const memberships = await context.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.userId, context.user.id),
      with: {
        organization: true,
      },
    });

    return memberships.map((m) => ({
      id: m.id,
      role: m.role,
      organization: {
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
      },
    }));
  }),

  // Update user settings
  updateSettings: protectedMutation
    .input(
      z.object({
        name: z.string().min(1).optional(),
        image: z.string().url().optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      const [updated] = await context.db
        .update(user)
        .set({
          ...(input.name && { name: input.name }),
          ...(input.image && { image: input.image }),
        })
        .where(eq(user.id, context.user.id))
        .returning();

      return updated;
    }),
};
