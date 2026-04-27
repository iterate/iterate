import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { slugifyWithSuffix } from "@iterate-com/shared/slug";
import { generateDefaultAvatar } from "@iterate-com/shared/default-avatar";
import {
  publicProcedure,
  publicMutation,
  protectedProcedure,
  projectProtectedProcedure,
  ProjectInput,
} from "../procedures.ts";
import { user, project, projectConnection } from "../../db/schema.ts";
import { getDefaultProjectSandboxProvider } from "../../utils/sandbox-providers.ts";
import { isNonProd } from "../../../env.ts";
import { createAuthWorkerClient } from "../../utils/auth-worker-client.ts";

/**
 * Testing router - provides helpers for test setup
 * These endpoints are only available in non-production environments
 */
export const testingRouter = {
  // Health check
  health: publicProcedure.handler(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  // Trigger query invalidation broadcast (for e2e tests)
  triggerInvalidation: publicMutation.handler(async () => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
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
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const [newUser] = await ctx.db
        .insert(user)
        .values({
          email: input.email,
          name: input.name,
          emailVerified: true,
          image: generateDefaultAvatar(input.email),
        })
        .onConflictDoUpdate({
          target: user.email,
          set: {
            name: input.name,
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
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const authClient = createAuthWorkerClient({ asUser: { authUserId: ctx.user.authUserId! } });
      const authOrganization = await authClient.organization.create({
        name: input.name,
      });

      const projSlug = slugifyWithSuffix(input.projectName || "default");
      const sandboxProvider = getDefaultProjectSandboxProvider(ctx.env, import.meta.env.DEV);
      const authProject = await authClient.project.create({
        organizationSlug: authOrganization.slug,
        name: input.projectName || "Default Project",
        slug: projSlug,
      });
      const [newProject] = await ctx.db
        .insert(project)
        .values({
          authProjectId: authProject.id,
          authOrganizationId: authOrganization.id,
          authOrganizationSlug: authOrganization.slug,
          name: authProject.name,
          slug: authProject.slug,
          sandboxProvider,
        })
        .returning();

      return {
        organization: authOrganization,
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
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const results: string[] = [];

      if (input.email) {
        const deleted = await ctx.db.delete(user).where(eq(user.email, input.email)).returning();
        results.push(`Deleted ${deleted.length} users`);
      }

      if (input.organizationSlug) {
        const deleted = await ctx.db
          .delete(project)
          .where(eq(project.authOrganizationSlug, input.organizationSlug))
          .returning();
        results.push(`Deleted ${deleted.length} projects for organization slug`);
      }

      return { results };
    }),

  // Seed Slack project connection for tests
  seedSlackConnection: projectProtectedProcedure
    .input(
      z.object({
        ...ProjectInput.shape,
        teamId: z.string().min(1),
        teamName: z.string().optional(),
        teamDomain: z.string().optional(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }

      const existingConnection = await ctx.db.query.projectConnection.findFirst({
        where: (pc, { eq, and }) => and(eq(pc.projectId, ctx.project.id), eq(pc.provider, "slack")),
      });

      const providerData = {
        teamId: input.teamId,
        teamName: input.teamName ?? input.teamId,
        teamDomain: input.teamDomain ?? input.teamId,
      };

      if (existingConnection) {
        await ctx.db
          .update(projectConnection)
          .set({
            externalId: input.teamId,
            providerData,
          })
          .where(eq(projectConnection.id, existingConnection.id));
      } else {
        await ctx.db.insert(projectConnection).values({
          projectId: ctx.project.id,
          provider: "slack",
          externalId: input.teamId,
          scope: "project",
          userId: ctx.user.id,
          providerData,
        });
      }

      return { success: true };
    }),
};
