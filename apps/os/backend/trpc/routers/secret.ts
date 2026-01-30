import { z } from "zod/v4";
import { and, eq, isNull, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { typeid } from "typeid-js";
import { router, projectProtectedProcedure, projectProtectedMutation } from "../trpc.ts";
import { secret } from "../../db/schema.ts";
import { encryptWithSecret } from "../../utils/encryption-core.ts";
import { pokeRunningMachinesToRefresh } from "../../utils/poke-machines.ts";
import { waitUntil } from "../../../env.ts";
import { logger } from "../../tag-logger.ts";
import { secretKeyToEnvVar } from "../../utils/env-vars.ts";

export const secretRouter = router({
  listProjectSecrets: projectProtectedProcedure.query(async ({ ctx }) => {
    // Fetch secrets for project scope and global scope
    // Global: all scope fields are null
    // Project: projectId matches current project
    const secrets = await ctx.db.query.secret.findMany({
      where: or(
        // Global secrets (all scope fields null)
        and(isNull(secret.organizationId), isNull(secret.projectId), isNull(secret.userId)),
        // Project secrets
        eq(secret.projectId, ctx.project.id),
      ),
      orderBy: (secrets, { asc }) => [asc(secrets.key)],
    });

    // Transform to frontend format
    return secrets.map((s) => ({
      id: s.id,
      key: s.key,
      description: s.description,
      egressProxyRule: s.egressProxyRule,
      isGlobal: s.organizationId === null && s.projectId === null && s.userId === null,
      scope: s.projectId
        ? "project"
        : s.organizationId
          ? "organization"
          : s.userId
            ? "user"
            : "global",
      recommendedEnvVar: secretKeyToEnvVar(s.key),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }),

  create: projectProtectedMutation
    .input(
      z.object({
        key: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[a-z]+\.\w+$/, {
            message:
              "Key must be two dot-separated words with no spaces (e.g. stripe.api_key, github.access_token, env.FOO_BAR)",
          }),
        value: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const encryptionSecret = ctx.env.ENCRYPTION_SECRET;
      if (!encryptionSecret) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Encryption secret not configured",
        });
      }

      // Check if secret already exists for this project
      const existing = await ctx.db.query.secret.findFirst({
        where: and(eq(secret.projectId, ctx.project.id), eq(secret.key, input.key)),
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A secret with this key already exists in this project",
        });
      }

      const encryptedValue = await encryptWithSecret(input.value, encryptionSecret);

      const [created] = await ctx.db
        .insert(secret)
        .values({
          id: typeid("sec").toString() as `sec_${string}`,
          projectId: ctx.project.id,
          organizationId: null,
          userId: null,
          key: input.key,
          encryptedValue,
          description: input.description,
          egressProxyRule: "true", // Default to allow all
        })
        .returning();

      if (!created) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create secret",
        });
      }

      // Poke running machines to refresh their env vars
      waitUntil(
        pokeRunningMachinesToRefresh(ctx.db, ctx.project.id, ctx.env).catch((err) => {
          logger.error("[secret] Failed to poke machines", err);
        }),
      );

      return {
        id: created.id,
        key: created.key,
        description: created.description,
        egressProxyRule: created.egressProxyRule,
        recommendedEnvVar: secretKeyToEnvVar(created.key),
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    }),

  update: projectProtectedMutation
    .input(
      z.object({
        id: z.string(),
        value: z.string().min(1).optional(),
        description: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the secret exists and belongs to this project
      const existing = await ctx.db.query.secret.findFirst({
        where: eq(secret.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Secret not found",
        });
      }

      // Prevent editing global secrets
      if (!existing.projectId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Global secrets cannot be edited",
        });
      }

      if (existing.projectId !== ctx.project.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have permission to edit this secret",
        });
      }

      const updateData: {
        encryptedValue?: string;
        description?: string;
        updatedAt: Date;
      } = {
        updatedAt: new Date(),
      };

      if (input.value) {
        const encryptionSecret = ctx.env.ENCRYPTION_SECRET;
        if (!encryptionSecret) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Encryption secret not configured",
          });
        }
        updateData.encryptedValue = await encryptWithSecret(input.value, encryptionSecret);
      }

      if (input.description !== undefined) {
        updateData.description = input.description;
      }

      const [updated] = await ctx.db
        .update(secret)
        .set(updateData)
        .where(eq(secret.id, input.id))
        .returning();

      // Poke running machines to refresh their env vars
      waitUntil(
        pokeRunningMachinesToRefresh(ctx.db, ctx.project.id, ctx.env).catch((err) => {
          logger.error("[secret] Failed to poke machines", err);
        }),
      );

      return {
        id: updated.id,
        key: updated.key,
        description: updated.description,
        egressProxyRule: updated.egressProxyRule,
        recommendedEnvVar: secretKeyToEnvVar(updated.key),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
    }),

  updateByKey: projectProtectedMutation
    .input(
      z.object({
        key: z.string(),
        value: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Find the secret by key for this project
      const existing = await ctx.db.query.secret.findFirst({
        where: and(eq(secret.projectId, ctx.project.id), eq(secret.key, input.key)),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Secret not found",
        });
      }

      const encryptionSecret = ctx.env.ENCRYPTION_SECRET;
      if (!encryptionSecret) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Encryption secret not configured",
        });
      }

      const encryptedValue = await encryptWithSecret(input.value, encryptionSecret);

      const [updated] = await ctx.db
        .update(secret)
        .set({ encryptedValue, updatedAt: new Date() })
        .where(eq(secret.id, existing.id))
        .returning();

      // Poke running machines to refresh their env vars
      waitUntil(
        pokeRunningMachinesToRefresh(ctx.db, ctx.project.id, ctx.env).catch((err) => {
          logger.error("[secret] Failed to poke machines", err);
        }),
      );

      return {
        id: updated.id,
        key: updated.key,
        updatedAt: updated.updatedAt,
      };
    }),

  delete: projectProtectedMutation
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the secret exists and belongs to this project
      const existing = await ctx.db.query.secret.findFirst({
        where: eq(secret.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Secret not found",
        });
      }

      // Prevent deleting global secrets
      if (!existing.projectId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Global secrets cannot be deleted",
        });
      }

      if (existing.projectId !== ctx.project.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have permission to delete this secret",
        });
      }

      await ctx.db.delete(secret).where(eq(secret.id, input.id));

      // Poke running machines to refresh their env vars
      waitUntil(
        pokeRunningMachinesToRefresh(ctx.db, ctx.project.id, ctx.env).catch((err) => {
          logger.error("[secret] Failed to poke machines", err);
        }),
      );

      return { success: true };
    }),
});
