import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, publicProcedure } from "../trpc.ts";
import { user, organizationUserMembership } from "../../db/schema.ts";
import { getAuth } from "../../auth/auth.ts";

export const userRouter = router({
  superadmin: publicProcedure.mutation(async ({ ctx }) => {
    const authHeader = ctx.rawRequest.headers.get("Authorization");
    if (authHeader !== `Bearer ${process.env.SERVICE_AUTH_TOKEN}`) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    const session = await getAuth(ctx.db).api.signInEmailOTP({
      body: {
        email: "superadmin@nustom.com",
        otp: "123456",
      },
      // userId: ctx.user.id,
      // expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    });
  }),
  // Get current user
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.user;
  }),

  // Get user's organizations
  myOrganizations: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.userId, ctx.user.id),
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
  memberships: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.userId, ctx.user.id),
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
  updateSettings: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        image: z.string().url().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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
});
