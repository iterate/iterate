import { z } from "zod/v4";
import { and, eq, isNull } from "drizzle-orm";
import { ORPCError, protectedProcedure, projectProtectedProcedure, ProjectInput } from "../orpc.ts";
import { projectAccessToken, organization, organizationUserMembership, project } from "../../db/schema.ts";
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

export const accessTokenRouter = {
  list: projectProtectedProcedure.handler(async ({ context }) => {
    const tokens = await context.db.query.projectAccessToken.findMany({
      where: eq(projectAccessToken.projectId, context.project.id),
      orderBy: (token, { desc }) => [desc(token.createdAt)],
    });

    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      lastUsedAt: t.lastUsedAt,
      revokedAt: t.revokedAt,
      createdAt: t.createdAt,
    }));
  }),

  create: protectedProcedure
    .input(ProjectInput.extend({ name: z.string().min(1).max(100) }))
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const rawToken = generateToken();
      const tokenHash = await hashToken(rawToken);

      const [created] = await context.db
        .insert(projectAccessToken)
        .values({
          projectId: proj.id,
          name: input.name,
          tokenHash,
        })
        .returning();

      if (!created) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Failed to create access token",
        });
      }

      return {
        id: created.id,
        name: created.name,
        token: rawToken,
        createdAt: created.createdAt,
      };
    }),

  revoke: protectedProcedure
    .input(ProjectInput.extend({ id: z.string() }))
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const existing = await context.db.query.projectAccessToken.findFirst({
        where: and(
          eq(projectAccessToken.id, input.id),
          eq(projectAccessToken.projectId, proj.id),
          isNull(projectAccessToken.revokedAt),
        ),
      });

      if (!existing) {
        throw new ORPCError("NOT_FOUND", {
          message: "Access token not found or already revoked",
        });
      }

      const [revoked] = await context.db
        .update(projectAccessToken)
        .set({ revokedAt: new Date() })
        .where(eq(projectAccessToken.id, input.id))
        .returning();

      return {
        id: revoked.id,
        name: revoked.name,
        revokedAt: revoked.revokedAt,
      };
    }),
};

async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return `pat_${Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}
