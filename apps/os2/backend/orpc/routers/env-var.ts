import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { ORPCError, protectedProcedure, projectProtectedProcedure, ProjectInput } from "../orpc.ts";
import { projectEnvVar, organization, organizationUserMembership, project } from "../../db/schema.ts";
import { encrypt } from "../../utils/encryption.ts";
import type { Context } from "../context.ts";

const projectLookup = async (
  db: Context["db"],
  organizationSlug: string,
  projectSlug: string,
  userId: string,
  userRole: string | null | undefined,
) => {
  const org = await db.query.organization.findFirst({
    where: eq(organization.slug, organizationSlug),
  });

  if (!org) {
    throw new ORPCError("NOT_FOUND", {
      message: `Organization with slug ${organizationSlug} not found`,
    });
  }

  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.organizationId, org.id),
      eq(organizationUserMembership.userId, userId),
    ),
  });

  if (!membership && userRole !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: "User does not have access to organization",
    });
  }

  const proj = await db.query.project.findFirst({
    where: and(eq(project.organizationId, org.id), eq(project.slug, projectSlug)),
  });

  if (!proj) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project with slug ${projectSlug} not found`,
    });
  }

  return { org, membership, project: proj };
};

export const envVarRouter = {
  list: projectProtectedProcedure.handler(async ({ context }) => {
    const envVars = await context.db.query.projectEnvVar.findMany({
      where: eq(projectEnvVar.projectId, context.project.id),
      orderBy: (vars, { asc }) => [asc(vars.key)],
    });

    return envVars.map((v) => ({
      id: v.id,
      key: v.key,
      maskedValue: maskValue(v.encryptedValue),
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));
  }),

  set: protectedProcedure
    .input(
      ProjectInput.extend({
        key: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[A-Z_][A-Z0-9_]*$/, {
            message:
              "Key must be uppercase letters, numbers, and underscores, starting with a letter or underscore",
          }),
        value: z.string(),
      }),
    )
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const encryptedValue = await encrypt(input.value);

      const existing = await context.db.query.projectEnvVar.findFirst({
        where: and(eq(projectEnvVar.projectId, proj.id), eq(projectEnvVar.key, input.key)),
      });

      if (existing) {
        const [updated] = await context.db
          .update(projectEnvVar)
          .set({ encryptedValue })
          .where(eq(projectEnvVar.id, existing.id))
          .returning();

        return {
          id: updated.id,
          key: updated.key,
          maskedValue: maskValue(updated.encryptedValue),
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        };
      }

      const [created] = await context.db
        .insert(projectEnvVar)
        .values({
          projectId: proj.id,
          key: input.key,
          encryptedValue,
        })
        .returning();

      if (!created) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Failed to create environment variable",
        });
      }

      return {
        id: created.id,
        key: created.key,
        maskedValue: maskValue(created.encryptedValue),
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    }),

  delete: protectedProcedure
    .input(ProjectInput.extend({ key: z.string() }))
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const existing = await context.db.query.projectEnvVar.findFirst({
        where: and(eq(projectEnvVar.projectId, proj.id), eq(projectEnvVar.key, input.key)),
      });

      if (!existing) {
        throw new ORPCError("NOT_FOUND", {
          message: "Environment variable not found",
        });
      }

      await context.db.delete(projectEnvVar).where(eq(projectEnvVar.id, existing.id));

      return { success: true };
    }),
};

function maskValue(encryptedValue: string): string {
  if (encryptedValue.length <= 8) {
    return "***";
  }
  return `${encryptedValue.substring(0, 4)}...${encryptedValue.substring(encryptedValue.length - 4)}`;
}
