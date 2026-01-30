import { z } from "zod/v4";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, projectProtectedProcedure, projectProtectedMutation } from "../trpc.ts";
import { projectEnvVar, secret } from "../../db/schema.ts";
import { pokeRunningMachinesToRefresh } from "../../utils/poke-machines.ts";
import { waitUntil } from "../../../env.ts";
import { logger } from "../../tag-logger.ts";
import { getUnifiedEnvVars } from "../../utils/env-vars.ts";
import { parseMagicString } from "../../egress-proxy/egress-proxy.ts";

export const envVarRouter = router({
  /**
   * List all environment variables for a project.
   * Returns a unified list including global vars, connection vars, user-defined vars,
   * and recommended vars (user-scoped secrets like Google OAuth).
   */
  list: projectProtectedProcedure.query(async ({ ctx }) => {
    const envVars = await getUnifiedEnvVars(ctx.db, ctx.project.id);

    return envVars.map((v) => ({
      key: v.key,
      value: v.value,
      isSecret: v.isSecret,
      description: v.description,
      egressProxyRule: v.egressProxyRule,
      source: v.source,
      createdAt: v.createdAt,
    }));
  }),

  set: projectProtectedMutation
    .input(
      z.object({
        key: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[A-Z_][A-Z0-9_]*$/, {
            message:
              "Key must be uppercase letters, numbers, and underscores, starting with a letter or underscore",
          }),
        value: z.string(),
        // TODO: remove machineId - we're no longer supporting machine-specific env vars
        machineId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // TODO: remove machineId support entirely
      const existing = await ctx.db.query.projectEnvVar.findFirst({
        where: and(
          eq(projectEnvVar.projectId, ctx.project.id),
          eq(projectEnvVar.key, input.key),
          isNull(projectEnvVar.machineId),
        ),
      });

      if (existing) {
        const [updated] = await ctx.db
          .update(projectEnvVar)
          .set({ value: input.value })
          .where(eq(projectEnvVar.id, existing.id))
          .returning();

        // Poke running machines to refresh their env vars
        waitUntil(
          pokeRunningMachinesToRefresh(ctx.db, ctx.project.id, ctx.env).catch((err) => {
            // Don't fail the mutation if poke fails
            logger.error("[env-var] Failed to poke machines", err);
          }),
        );

        return {
          id: updated.id,
          key: updated.key,
          value: updated.value,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        };
      }

      const [created] = await ctx.db
        .insert(projectEnvVar)
        .values({
          projectId: ctx.project.id,
          machineId: null, // Always project-level now
          key: input.key,
          value: input.value,
        })
        .returning();

      if (!created) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create environment variable",
        });
      }

      // Poke running machines to refresh their env vars
      waitUntil(
        pokeRunningMachinesToRefresh(ctx.db, ctx.project.id, ctx.env).catch((err) => {
          // Don't fail the mutation if poke fails
          logger.error("[env-var] Failed to poke machines", err);
        }),
      );

      return {
        id: created.id,
        key: created.key,
        value: created.value,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    }),

  delete: projectProtectedMutation
    .input(
      z.object({
        key: z.string(),
        // TODO: remove machineId - we're no longer supporting machine-specific env vars
        machineId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // TODO: remove machineId support entirely
      const existing = await ctx.db.query.projectEnvVar.findFirst({
        where: and(
          eq(projectEnvVar.projectId, ctx.project.id),
          eq(projectEnvVar.key, input.key),
          isNull(projectEnvVar.machineId),
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Environment variable not found",
        });
      }

      if (existing.type === "system") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "System environment variables cannot be deleted manually",
        });
      }

      await ctx.db.delete(projectEnvVar).where(eq(projectEnvVar.id, existing.id));

      // If this was a secret env var (env.KEY), also delete the orphaned secret
      const parsed = parseMagicString(existing.value);
      if (parsed) {
        const { secretKey } = parsed;
        // Only delete env.* secrets (user-created), not connector/global secrets
        if (secretKey.startsWith("env.")) {
          await ctx.db
            .delete(secret)
            .where(and(eq(secret.projectId, ctx.project.id), eq(secret.key, secretKey)));
        }
      }

      // Poke running machines to refresh their env vars
      waitUntil(
        pokeRunningMachinesToRefresh(ctx.db, ctx.project.id, ctx.env).catch((err) => {
          // Don't fail the mutation if poke fails
          logger.error("[env-var] Failed to poke machines", err);
        }),
      );

      return { success: true };
    }),
});
