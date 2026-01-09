import { z } from "zod/v4";
import { eq, and, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { Daytona } from "@daytonaio/sdk";
import { typeid } from "typeid-js";
import { router, projectProtectedProcedure, projectProtectedMutation, t } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { env } from "../../../env.ts";
import { decrypt, encrypt } from "../../utils/encryption.ts";
import type { DB } from "../../db/client.ts";
import { generateToken } from "./access-token.ts";

const daytonaMiddleware = t.middleware(async ({ ctx, next }) => {
  const daytona = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  return next({ ctx: { ...ctx, daytona } });
});

export const machineRouter = router({
  // List machines in project
  list: projectProtectedProcedure
    .use(daytonaMiddleware)
    .input(
      z.object({
        includeArchived: z.boolean().default(false).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const includeArchived = input.includeArchived ?? false;

      const machines = await ctx.db.query.machine.findMany({
        where: includeArchived
          ? eq(schema.machine.projectId, ctx.project.id)
          : and(eq(schema.machine.projectId, ctx.project.id), eq(schema.machine.state, "started")),
        orderBy: (m, { desc }) => [desc(m.createdAt)],
      });

      return machines;
    }),

  // Get machine by ID
  byId: projectProtectedProcedure
    .use(daytonaMiddleware)
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const m = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.id, input.machineId),
          eq(schema.machine.projectId, ctx.project.id),
        ),
      });

      if (!m) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      return m;
    }),

  // Create a new machine
  create: projectProtectedMutation
    .use(daytonaMiddleware)
    .input(
      z.object({
        name: z.string().min(1).max(100),
        type: z.enum(schema.MachineType).default("daytona"),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const machineAuthToken = generateToken();
      const machineId = typeid("mach").toString();

      const globalEnvVars = await ctx.db.query.projectEnvVar.findMany({
        where: and(
          eq(schema.projectEnvVar.projectId, ctx.project.id),
          isNull(schema.projectEnvVar.machineId),
        ),
      });

      const envVars = Object.fromEntries(
        await Promise.all(
          globalEnvVars.map(
            async (envVar) => [envVar.key, await decrypt(envVar.encryptedValue)] as const,
          ),
        ),
      );

      // If there is no defined key, use the default one for now
      // TODO: very dangerous, remove this as soon as we have things setup
      if (!envVars["OPENAI_API_KEY"]) {
        envVars["OPENAI_API_KEY"] = env.OPENAI_API_KEY;
      }

      const sandbox = await ctx.daytona
        .create({
          name: machineId,
          snapshot: ctx.env.DAYTONA_SNAPSHOT_NAME,
          envVars: {
            ...envVars,
            MACHINE_AUTH_TOKEN: machineAuthToken,
          },
          autoStopInterval: 0,
          public: true,
        })
        .catch((err) => {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`,
          });
        });

      const newMachine = await ctx.db
        .transaction(async (tx) => {
          const [newMachine] = await tx
            .insert(schema.machine)
            .values({
              id: machineId,
              name: input.name,
              type: input.type,
              projectId: ctx.project.id,
              state: "started",
              metadata: input.metadata ?? {},
              externalId: sandbox.id,
            })
            .returning();

          await tx.insert(schema.projectEnvVar).values({
            projectId: ctx.project.id,
            machineId,
            key: "MACHINE_AUTH_TOKEN",
            encryptedValue: await encrypt(machineAuthToken),
            type: "system",
          });

          return newMachine;
        })
        .catch(async (err) => {
          if (sandbox) await sandbox.delete();
          throw err;
        });

      if (!newMachine) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create machine",
        });
      }

      return newMachine;
    }),

  // Archive a machine
  archive: projectProtectedMutation
    .use(daytonaMiddleware)
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(schema.machine)
        .set({ state: "archived" })
        .where(
          and(eq(schema.machine.id, input.machineId), eq(schema.machine.projectId, ctx.project.id)),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      const sandbox = await ctx.daytona.get(input.machineId).catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to get sandbox: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      if (sandbox.state === "started") await sandbox.stop();
      await sandbox.archive();

      return updated;
    }),

  // Unarchive a machine (restore)
  unarchive: projectProtectedMutation
    .use(daytonaMiddleware)
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(schema.machine)
        .set({ state: "started" })
        .where(
          and(eq(schema.machine.id, input.machineId), eq(schema.machine.projectId, ctx.project.id)),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      const sandbox = await ctx.daytona.get(input.machineId).catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to get sandbox: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      if (sandbox.state === "archived") {
        await sandbox.start();
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Machine is not archived",
        });
      }

      return updated;
    }),

  // Delete a machine permanently
  delete: projectProtectedMutation
    .use(daytonaMiddleware)
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db
        .delete(schema.machine)
        .where(
          and(eq(schema.machine.id, input.machineId), eq(schema.machine.projectId, ctx.project.id)),
        )
        .returning();

      if (result.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      const sandbox = await ctx.daytona.get(input.machineId).catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to get sandbox: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

      if (sandbox.state === "started") await sandbox.stop();
      await sandbox.delete();

      return { success: true };
    }),

  getPreviewInfo: projectProtectedProcedure
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return getMachinePreviewInfo({
        db: ctx.db,
        projectId: ctx.project.id,
        machineId: input.machineId,
      });
    }),
});

export async function getMachinePreviewInfo({
  db,
  projectId,
  machineId,
}: {
  db: DB;
  projectId: string;
  machineId: string;
}) {
  const machineRecord = await db.query.machine.findFirst({
    where: and(eq(schema.machine.id, machineId), eq(schema.machine.projectId, projectId)),
  });
  if (!machineRecord) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Machine not found",
    });
  }

  const tokenEnvVar = await db.query.projectEnvVar.findFirst({
    where: and(
      eq(schema.projectEnvVar.projectId, projectId),
      eq(schema.projectEnvVar.machineId, machineId),
      eq(schema.projectEnvVar.key, "MACHINE_AUTH_TOKEN"),
    ),
  });
  if (!tokenEnvVar) throw new Error("Machine auth token not found");

  const machineAuthToken = await decrypt(tokenEnvVar.encryptedValue);
  const previewUrl = `https://3000-${machineRecord.externalId}.proxy.daytona.works`;
  const headers = {
    Authorization: `${machineAuthToken}`,
    "X-Daytona-Skip-Preview-Warning": "true",
  };

  return {
    url: previewUrl,
    headers,
  };
}
