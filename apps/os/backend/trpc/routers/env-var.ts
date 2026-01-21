import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { ORPCError, withProjectInput, withProjectMutationInput } from "../trpc.ts";
import { projectEnvVar } from "../../db/schema.ts";
import { encrypt } from "../../utils/encryption.ts";
import { pokeRunningMachinesToRefresh } from "../../utils/poke-machines.ts";
import { waitUntil } from "../../../env.ts";
import { logger } from "../../tag-logger.ts";

export const envVarRouter = {
  list: withProjectInput({
    machineId: z.string().optional(),
  }).handler(async ({ context, input }) => {
    const envVars = await context.db.query.projectEnvVar.findMany({
      where: input.machineId
        ? and(
            eq(projectEnvVar.projectId, context.project.id),
            eq(projectEnvVar.machineId, input.machineId),
          )
        : eq(projectEnvVar.projectId, context.project.id),
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

  set: withProjectMutationInput({
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
  }).handler(async ({ context, input }) => {
    const encryptedValue = await encrypt(input.value);

    const existing = await context.db.query.projectEnvVar.findFirst({
      where: and(
        eq(projectEnvVar.projectId, context.project.id),
        eq(projectEnvVar.key, input.key),
        input.machineId ? eq(projectEnvVar.machineId, input.machineId) : undefined,
      ),
    });

    if (existing) {
      const [updated] = await context.db
        .update(projectEnvVar)
        .set({ encryptedValue })
        .where(eq(projectEnvVar.id, existing.id))
        .returning();

      // Poke running machines to refresh their env vars
      waitUntil(
        pokeRunningMachinesToRefresh(context.db, context.project.id, context.env).catch((err) => {
          // Don't fail the mutation if poke fails
          logger.error("[env-var] Failed to poke machines", err);
        }),
      );

      return {
        id: updated.id,
        key: updated.key,
        machineId: updated.machineId,
        maskedValue: maskValue(updated.encryptedValue),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
    }

    const [created] = await context.db
      .insert(projectEnvVar)
      .values({
        projectId: context.project.id,
        machineId: input.machineId,
        key: input.key,
        encryptedValue,
      })
      .returning();

    if (!created) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to create environment variable",
      });
    }

    // Poke running machines to refresh their env vars
    waitUntil(
      pokeRunningMachinesToRefresh(context.db, context.project.id, context.env).catch((err) => {
        // Don't fail the mutation if poke fails
        logger.error("[env-var] Failed to poke machines", err);
      }),
    );

    return {
      id: created.id,
      key: created.key,
      machineId: created.machineId,
      maskedValue: maskValue(created.encryptedValue),
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  }),

  delete: withProjectMutationInput({
    key: z.string(),
    machineId: z.string().optional(),
  }).handler(async ({ context, input }) => {
    const existing = await context.db.query.projectEnvVar.findFirst({
      where: and(
        eq(projectEnvVar.projectId, context.project.id),
        eq(projectEnvVar.key, input.key),
        input.machineId ? eq(projectEnvVar.machineId, input.machineId) : undefined,
      ),
    });

    if (!existing) {
      throw new ORPCError("NOT_FOUND", {
        message: "Environment variable not found",
      });
    }

    if (existing.type === "system") {
      throw new ORPCError("FORBIDDEN", {
        message: "System environment variables cannot be deleted manually",
      });
    }

    await context.db
      .delete(projectEnvVar)
      .where(
        and(
          eq(projectEnvVar.id, existing.id),
          input.machineId ? eq(projectEnvVar.machineId, input.machineId) : undefined,
        ),
      );

    // Poke running machines to refresh their env vars
    waitUntil(
      pokeRunningMachinesToRefresh(context.db, context.project.id, context.env).catch((err) => {
        // Don't fail the mutation if poke fails
        logger.error("[env-var] Failed to poke machines", err);
      }),
    );

    return { success: true };
  }),
};

function maskValue(encryptedValue: string): string {
  if (encryptedValue.length <= 8) {
    return "***";
  }
  return `${encryptedValue.substring(0, 4)}...${encryptedValue.substring(encryptedValue.length - 4)}`;
}
