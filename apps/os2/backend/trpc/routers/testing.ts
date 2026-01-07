import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, publicMutation, protectedProcedure } from "../trpc.ts";
import { user, organization, project, organizationUserMembership } from "../../db/schema.ts";
import { generateSlug } from "../../utils/slug.ts";
import { isNonProd } from "../../../env.ts";

/**
 * Testing router - provides helpers for test setup
 * These endpoints are only available in non-production environments
 */
export const testingRouter = router({
  // Health check
  health: publicProcedure.query(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  // Trigger query invalidation broadcast (for e2e tests)
  triggerInvalidation: publicMutation.mutation(async () => {
    if (!isNonProd) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Testing endpoints are not available in production",
      });
    }
    return { triggered: true, timestamp: new Date().toISOString() };
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
      if (!isNonProd) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Testing endpoints are not available in production",
        });
      }
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

  // Create test organization with project
  createTestOrganization: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        projectName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isNonProd) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Testing endpoints are not available in production",
        });
      }
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

      const projSlug = generateSlug(input.projectName || "default");
      const [newProject] = await ctx.db
        .insert(project)
        .values({
          name: input.projectName || "Default Project",
          slug: projSlug,
          organizationId: newOrg.id,
        })
        .returning();

      return {
        organization: newOrg,
        project: newProject,
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
      if (!isNonProd) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Testing endpoints are not available in production",
        });
      }
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
