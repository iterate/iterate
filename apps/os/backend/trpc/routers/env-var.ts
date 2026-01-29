import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, projectProtectedProcedure, projectProtectedMutation } from "../trpc.ts";
import { projectEnvVar } from "../../db/schema.ts";
import { pokeRunningMachinesToRefresh } from "../../utils/poke-machines.ts";
import { waitUntil } from "../../../env.ts";
import { logger } from "../../tag-logger.ts";

export const envVarRouter = router({
  list: projectProtectedProcedure
    .input(
      z.object({
        machineId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const envVars = await ctx.db.query.projectEnvVar.findMany({
        where: input.machineId
          ? and(
              eq(projectEnvVar.projectId, ctx.project.id),
              eq(projectEnvVar.machineId, input.machineId),
            )
          : eq(projectEnvVar.projectId, ctx.project.id),
        orderBy: (vars, { asc }) => [asc(vars.key)],
      });

      // Note: env vars are stored plain-text now. Secrets go in the secret table.
      return envVars.map((v) => ({
        id: v.id,
        key: v.key,
        machineId: v.machineId,
        type: v.type,
        value: v.value,
        description: v.description,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
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
        description: z.string().optional(),
        machineId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.query.projectEnvVar.findFirst({
        where: and(
          eq(projectEnvVar.projectId, ctx.project.id),
          eq(projectEnvVar.key, input.key),
          input.machineId ? eq(projectEnvVar.machineId, input.machineId) : undefined,
        ),
      });

      if (existing) {
        const [updated] = await ctx.db
          .update(projectEnvVar)
          .set({ value: input.value, description: input.description })
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
          machineId: updated.machineId,
          value: updated.value,
          description: updated.description,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        };
      }

      const [created] = await ctx.db
        .insert(projectEnvVar)
        .values({
          projectId: ctx.project.id,
          machineId: input.machineId,
          key: input.key,
          value: input.value,
          description: input.description,
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
        machineId: created.machineId,
        value: created.value,
        description: created.description,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    }),

  delete: projectProtectedMutation
    .input(
      z.object({
        key: z.string(),
        machineId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.query.projectEnvVar.findFirst({
        where: and(
          eq(projectEnvVar.projectId, ctx.project.id),
          eq(projectEnvVar.key, input.key),
          input.machineId ? eq(projectEnvVar.machineId, input.machineId) : undefined,
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

      await ctx.db
        .delete(projectEnvVar)
        .where(
          and(
            eq(projectEnvVar.id, existing.id),
            input.machineId ? eq(projectEnvVar.machineId, input.machineId) : undefined,
          ),
        );

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
