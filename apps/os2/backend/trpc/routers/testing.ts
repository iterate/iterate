import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, publicProcedure, protectedProcedure } from "../trpc.ts";
import { user, organization, instance, organizationUserMembership } from "../../db/schema.ts";
import { generateSlug } from "../../utils/slug.ts";

/**
 * Testing router - provides helpers for test setup
 * These endpoints require service auth token in production
 */
export const testingRouter = router({
  // Health check
  health: publicProcedure.query(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  // Create test user (for e2e tests)
  createTestUser: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        name: z.string(),
        role: z.enum(["user", "admin"]).default("user"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // In production, this would require service auth
      const [newUser] = await ctx.db
        .insert(user)
        .values({
          email: input.email,
          name: input.name,
          role: input.role,
          emailVerified: true,
        })
        .onConflictDoUpdate({
          target: user.email,
          set: {
            name: input.name,
            role: input.role,
          },
        })
        .returning();

      return newUser;
    }),

  // Create test organization with instance
  createTestOrganization: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        instanceName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgSlug = generateSlug(input.name);

      const [newOrg] = await ctx.db
        .insert(organization)
        .values({
          name: input.name,
          slug: orgSlug,
        })
        .returning();

      if (!newOrg) {
        throw new Error("Failed to create organization");
      }

      await ctx.db.insert(organizationUserMembership).values({
        organizationId: newOrg.id,
        userId: ctx.user.id,
        role: "owner",
      });

      const instSlug = generateSlug(input.instanceName || "default");
      const [newInstance] = await ctx.db
        .insert(instance)
        .values({
          name: input.instanceName || "Default Instance",
          slug: instSlug,
          organizationId: newOrg.id,
        })
        .returning();

      return {
        organization: newOrg,
        instance: newInstance,
      };
    }),

  // Clean up test data
  cleanupTestData: publicProcedure
    .input(
      z.object({
        email: z.string().email().optional(),
        organizationSlug: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const results: string[] = [];

      if (input.email) {
        const deleted = await ctx.db
          .delete(user)
          .where(eq(user.email, input.email))
          .returning();
        results.push(`Deleted ${deleted.length} users`);
      }

      if (input.organizationSlug) {
        const deleted = await ctx.db
          .delete(organization)
          .where(eq(organization.slug, input.organizationSlug))
          .returning();
        results.push(`Deleted ${deleted.length} organizations`);
      }

      return { results };
    }),
});
