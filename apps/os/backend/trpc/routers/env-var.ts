import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, projectProtectedProcedure, projectProtectedMutation } from "../trpc.ts";
import { projectEnvVar } from "../../db/schema.ts";
import { encrypt } from "../../utils/encryption.ts";

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

      return envVars.map((v) => ({
        id: v.id,
        key: v.key,
        machineId: v.machineId,
        type: v.type,
        maskedValue: maskValue(v.encryptedValue),
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
        machineId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const encryptedValue = await encrypt(input.value);

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
          .set({ encryptedValue })
          .where(eq(projectEnvVar.id, existing.id))
          .returning();

        return {
          id: updated.id,
          key: updated.key,
          machineId: updated.machineId,
          maskedValue: maskValue(updated.encryptedValue),
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
          encryptedValue,
        })
        .returning();

      if (!created) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create environment variable",
        });
      }

      return {
        id: created.id,
        key: created.key,
        machineId: created.machineId,
        maskedValue: maskValue(created.encryptedValue),
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

      return { success: true };
    }),
});

function maskValue(encryptedValue: string): string {
  if (encryptedValue.length <= 8) {
    return "***";
  }
  return `${encryptedValue.substring(0, 4)}...${encryptedValue.substring(encryptedValue.length - 4)}`;
}
