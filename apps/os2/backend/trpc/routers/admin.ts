import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { router, adminProcedure, protectedProcedure } from "../trpc.ts";
import { user } from "../../db/schema.ts";

export const adminRouter = router({
  // Impersonate a user (creates a session as that user)
  impersonate: adminProcedure
    .input(
      z.object({
        userId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // This would typically integrate with better-auth's admin plugin
      // For now, return the user info that would be impersonated
      const targetUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
      });

      if (!targetUser) {
        throw new Error("User not found");
      }

      return {
        message: "Impersonation would be handled via Better Auth admin plugin",
        targetUser: {
          id: targetUser.id,
          email: targetUser.email,
          name: targetUser.name,
        },
      };
    }),

  // Stop impersonating
  stopImpersonating: protectedProcedure.mutation(async ({ ctx: _ctx }) => {
    // This would integrate with better-auth's admin plugin
    return {
      message: "Stop impersonation would be handled via Better Auth admin plugin",
    };
  }),

  // List all users (admin only)
  listUsers: adminProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const users = await ctx.db.query.user.findMany({
        limit,
        offset,
        orderBy: (u, { desc }) => [desc(u.createdAt)],
      });

      return users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        image: u.image,
        role: u.role,
        createdAt: u.createdAt,
      }));
    }),

  // List all organizations (admin only)
  listOrganizations: adminProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const orgs = await ctx.db.query.organization.findMany({
        limit,
        offset,
        orderBy: (o, { desc }) => [desc(o.createdAt)],
        with: {
          projects: true,
          members: {
            with: {
              user: true,
            },
          },
        },
      });

      return orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        projectCount: o.projects.length,
        memberCount: o.members.length,
        createdAt: o.createdAt,
      }));
    }),

  // Get session info for debugging
  sessionInfo: protectedProcedure.query(async ({ ctx }) => {
    return {
      user: {
        id: ctx.user.id,
        email: ctx.user.email,
        name: ctx.user.name,
        role: ctx.user.role,
      },
      session: ctx.session
        ? {
            expiresAt: ctx.session.session.expiresAt,
            ipAddress: ctx.session.session.ipAddress,
            userAgent: ctx.session.session.userAgent,
            impersonatedBy: ctx.session.session.impersonatedBy,
          }
        : null,
    };
  }),
});
