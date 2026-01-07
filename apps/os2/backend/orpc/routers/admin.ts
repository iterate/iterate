import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { adminProcedure, protectedProcedure } from "../orpc.ts";
import { user } from "../../db/schema.ts";

export const adminRouter = {
  impersonate: adminProcedure
    .input(
      z.object({
        userId: z.string(),
      }),
    )
    .handler(async ({ context, input }) => {
      const targetUser = await context.db.query.user.findFirst({
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

  stopImpersonating: protectedProcedure.handler(async () => {
    return {
      message: "Stop impersonation would be handled via Better Auth admin plugin",
    };
  }),

  listUsers: adminProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .handler(async ({ context, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const users = await context.db.query.user.findMany({
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

  listOrganizations: adminProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .handler(async ({ context, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const orgs = await context.db.query.organization.findMany({
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

  sessionInfo: protectedProcedure.handler(async ({ context }) => {
    return {
      user: {
        id: context.user.id,
        email: context.user.email,
        name: context.user.name,
        role: context.user.role,
      },
      session: context.session
        ? {
            expiresAt: context.session.session.expiresAt,
            ipAddress: context.session.session.ipAddress,
            userAgent: context.session.session.userAgent,
            impersonatedBy: context.session.session.impersonatedBy,
          }
        : null,
    };
  }),
};
