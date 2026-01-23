import { z } from "zod/v4";
import { and, eq, ilike } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure, protectedProcedure } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { user, billingAccount } from "../../db/schema.ts";
import { getStripe } from "../../integrations/stripe/stripe.ts";

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

  chargeUsage: adminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        units: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await ctx.db.query.billingAccount.findFirst({
        where: eq(billingAccount.organizationId, input.organizationId),
      });

      if (!account?.stripeCustomerId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Organization has no billing account or Stripe customer",
        });
      }

      const stripe = getStripe();

      const meterEvent = await stripe.v2.billing.meterEvents.create({
        event_name: "test_usage_units",
        payload: {
          stripe_customer_id: account.stripeCustomerId,
          value: String(input.units),
        },
      });

      return {
        success: true,
        units: input.units,
        costCents: input.units,
        meterEventId: meterEvent.identifier,
        stripeCustomerId: account.stripeCustomerId,
      };
    }),

  impersonationInfo: protectedProcedure.query(async ({ ctx }) => {
    const impersonatedBy = ctx?.session?.session.impersonatedBy || undefined;
    const isAdmin = ctx?.user?.role === "admin" || undefined;
    return { impersonatedBy, isAdmin };
  }),

  searchUsersByEmail: adminProcedure
    .input(z.object({ searchEmail: z.string() }))
    .query(async ({ ctx, input }) => {
      const users = await ctx.db.query.user.findMany({
        where: ilike(schema.user.email, `%${input.searchEmail}%`),
        columns: { id: true, email: true, name: true },
        limit: 10,
      });
      return users;
    }),

  findUserByEmail: adminProcedure
    .input(z.object({ email: z.string() }))
    .query(async ({ ctx, input }) => {
      const foundUser = await ctx.db.query.user.findFirst({
        where: eq(user.email, input.email.toLowerCase()),
      });
      return foundUser;
    }),

  getProjectOwner: adminProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db.query.project.findFirst({
        where: eq(schema.project.id, input.projectId),
      });

      if (!project) {
        throw new Error("Project not found");
      }

      const ownerMembership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(schema.organizationUserMembership.organizationId, project.organizationId),
          eq(schema.organizationUserMembership.role, "owner"),
        ),
        with: { user: true },
      });

      if (!ownerMembership) {
        throw new Error("Organization owner not found");
      }

      return {
        userId: ownerMembership.user.id,
        email: ownerMembership.user.email,
        name: ownerMembership.user.name,
      };
    }),

  setUserRole: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(["user", "admin"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id && input.role !== "admin") {
        throw new Error("You cannot remove your own admin role");
      }

      const targetUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
      });

      if (!targetUser) {
        throw new Error("User not found");
      }

      await ctx.db.update(user).set({ role: input.role }).where(eq(user.id, input.userId));

      return {
        userId: input.userId,
        email: targetUser.email,
        name: targetUser.name,
        role: input.role,
      };
    }),

  // Introspect all tRPC procedures for the admin tRPC tools UI
  allProcedureInputs: adminProcedure.query(
    async (): Promise<
      Array<
        [
          string,
          {
            procedure: { _def: { type: string } };
            parsedProcedure: { optionsJsonSchema: Record<string, unknown> };
            meta?: { description?: string };
          },
        ]
      >
    > => {
      // Lazy import to avoid circular dependency
      const { appRouter } = await import("../root.ts");
      const { introspectRouter } = await import("../introspect.ts");
      return introspectRouter(appRouter);
    },
  ),
});
