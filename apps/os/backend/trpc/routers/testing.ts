import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import {
  ORPCError,
  publicProcedure,
  publicMutation,
  protectedProcedure,
  withProjectMutationInput,
} from "../trpc.ts";
import {
  user,
  organization,
  project,
  organizationUserMembership,
  projectConnection,
  event,
} from "../../db/schema.ts";
import { slugifyWithSuffix } from "../../utils/slug.ts";
import { isNonProd } from "../../../env.ts";

/** Generate a DiceBear avatar URL using a hash of the email as seed */
function generateDefaultAvatar(email: string): string {
  const normalized = email.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${Math.abs(hash).toString(36)}`;
}

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
    .handler(async ({ context, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const [newUser] = await context.db
        .insert(user)
        .values({
          email: input.email,
          name: input.name,
          role: input.role,
          emailVerified: true,
          image: generateDefaultAvatar(input.email),
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
    .handler(async ({ context, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const orgSlug = slugifyWithSuffix(input.name);

      const [newOrg] = await context.db
        .insert(organization)
        .values({
          name: input.name,
          slug: orgSlug,
        })
        .returning();

      if (!newOrg) {
        throw new Error("Failed to create organization");
      }

      await context.db.insert(organizationUserMembership).values({
        organizationId: newOrg.id,
        userId: context.user.id,
        role: "owner",
      });

      const projSlug = slugifyWithSuffix(input.projectName || "default");
      const [newProject] = await context.db
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
    .handler(async ({ context, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const results: string[] = [];

      if (input.email) {
        const deleted = await context.db
          .delete(user)
          .where(eq(user.email, input.email))
          .returning();
        results.push(`Deleted ${deleted.length} users`);
      }

      if (input.organizationSlug) {
        const deleted = await context.db
          .delete(organization)
          .where(eq(organization.slug, input.organizationSlug))
          .returning();
        results.push(`Deleted ${deleted.length} organizations`);
      }

      return { results };
    }),

  // Seed Slack project connection for tests
  seedSlackConnection: withProjectMutationInput({
    teamId: z.string().min(1),
    teamName: z.string().optional(),
    teamDomain: z.string().optional(),
  }).handler(async ({ context, input }) => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }

    const existingConnection = await context.db.query.projectConnection.findFirst({
      where: (pc, { eq, and }) =>
        and(eq(pc.projectId, context.project.id), eq(pc.provider, "slack")),
    });

    const providerData = {
      teamId: input.teamId,
      teamName: input.teamName ?? input.teamId,
      teamDomain: input.teamDomain ?? input.teamId,
    };

    if (existingConnection) {
      await context.db
        .update(projectConnection)
        .set({
          externalId: input.teamId,
          providerData,
        })
        .where(eq(projectConnection.id, existingConnection.id));
    } else {
      await context.db.insert(projectConnection).values({
        projectId: context.project.id,
        provider: "slack",
        externalId: input.teamId,
        scope: "project",
        userId: context.user.id,
        providerData,
      });
    }

    return { success: true };
  }),

  // Insert a test event
  insertEvent: withProjectMutationInput({
    type: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).default({}),
  }).handler(async ({ context, input }) => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }

    const [newEvent] = await context.db
      .insert(event)
      .values({
        type: input.type,
        payload: input.payload,
        projectId: context.project.id,
      })
      .returning();

    return newEvent;
  }),
};
