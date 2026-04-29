import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { protectedProcedure } from "../procedures.ts";
import { user } from "../../db/schema.ts";
import { listOrganizationsFromAuthWorker } from "../../auth/auth-context.ts";

export const userRouter = {
  // Get current user
  me: protectedProcedure.handler(async ({ context: ctx }) => {
    return ctx.user;
  }),

  // Get user's organizations
  myOrganizations: protectedProcedure.handler(async ({ context: ctx }) => {
    return listOrganizationsFromAuthWorker({
      db: ctx.db,
      authUserId: ctx.user.authUserId!,
    });
  }),

  // Get user's memberships with org details (for settings page)
  memberships: protectedProcedure.handler(async ({ context: ctx }) => {
    const organizations = await listOrganizationsFromAuthWorker({
      db: ctx.db,
      authUserId: ctx.user.authUserId!,
    });

    return organizations.map((organization) => ({
      id: `${organization.id}:${ctx.user.id}`,
      role: organization.role,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
    }));
  }),

  // Update user settings
  updateSettings: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        image: z.string().url().optional(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const [updated] = await ctx.db
        .update(user)
        .set({
          ...(input.name && { name: input.name }),
          ...(input.image && { image: input.image }),
        })
        .where(eq(user.id, ctx.user.id))
        .returning();

      return updated;
    }),
};
