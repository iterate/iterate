import { z } from "zod/v4";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, projectProtectedProcedure, projectProtectedMutation } from "../trpc.ts";
import { projectAccessToken } from "../../db/schema.ts";

export const accessTokenRouter = router({
  list: projectProtectedProcedure.query(async ({ ctx }) => {
    const tokens = await ctx.db.query.projectAccessToken.findMany({
      where: eq(projectAccessToken.projectId, ctx.project.id),
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

  create: projectProtectedMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rawToken = generateToken();
      const tokenHash = await hashToken(rawToken);

      const [created] = await ctx.db
        .insert(projectAccessToken)
        .values({
          projectId: ctx.project.id,
          name: input.name,
          tokenHash,
        })
        .returning();

      if (!created) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
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

  revoke: projectProtectedMutation
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.query.projectAccessToken.findFirst({
        where: and(
          eq(projectAccessToken.id, input.id),
          eq(projectAccessToken.projectId, ctx.project.id),
          isNull(projectAccessToken.revokedAt),
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Access token not found or already revoked",
        });
      }

      const [revoked] = await ctx.db
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
});

async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return `pat_${Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}
