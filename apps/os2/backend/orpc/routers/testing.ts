import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { ORPCError, publicProcedure, protectedProcedure } from "../orpc.ts";
import { user, organization, project, organizationUserMembership } from "../../db/schema.ts";
import { generateSlug } from "../../utils/slug.ts";
import { isNonProd } from "../../../env.ts";

export const testingRouter = {
  health: publicProcedure.handler(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

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
      const orgSlug = generateSlug(input.name);

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

      const projSlug = generateSlug(input.projectName || "default");
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
};
