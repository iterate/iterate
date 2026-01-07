import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, projectProtectedProcedure, projectProtectedMutation } from "../trpc.ts";
import { machine, MachineType } from "../../db/schema.ts";

export const machineRouter = router({
  // List machines in project
  list: projectProtectedProcedure
    .input(
      z.object({
        includeArchived: z.boolean().default(false).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const includeArchived = input.includeArchived ?? false;

      const machines = await ctx.db.query.machine.findMany({
        where: includeArchived
          ? eq(machine.projectId, ctx.project.id)
          : and(eq(machine.projectId, ctx.project.id), eq(machine.state, "started")),
        orderBy: (m, { desc }) => [desc(m.createdAt)],
      });

      return machines;
    }),

  // Get machine by ID
  byId: projectProtectedProcedure
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const m = await ctx.db.query.machine.findFirst({
        where: and(
          eq(machine.id, input.machineId),
          eq(machine.projectId, ctx.project.id),
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
    .input(
      z.object({
        name: z.string().min(1).max(100),
        type: z.enum(MachineType).default("daytona"),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [newMachine] = await ctx.db
        .insert(machine)
        .values({
          name: input.name,
          type: input.type,
          projectId: ctx.project.id,
          state: "started",
          metadata: input.metadata ?? {},
        })
        .returning();

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
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(machine)
        .set({ state: "archived" })
        .where(
          and(
            eq(machine.id, input.machineId),
            eq(machine.projectId, ctx.project.id),
          ),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      return updated;
    }),

  // Unarchive a machine (restore)
  unarchive: projectProtectedMutation
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(machine)
        .set({ state: "started" })
        .where(
          and(
            eq(machine.id, input.machineId),
            eq(machine.projectId, ctx.project.id),
          ),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      return updated;
    }),

  // Delete a machine permanently
  delete: projectProtectedMutation
    .input(
      z.object({
        machineId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db
        .delete(machine)
        .where(
          and(
            eq(machine.id, input.machineId),
            eq(machine.projectId, ctx.project.id),
          ),
        )
        .returning();

      if (result.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      return { success: true };
    }),

  // Update machine settings
  update: projectProtectedMutation
    .input(
      z.object({
        machineId: z.string(),
        name: z.string().min(1).max(100).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(machine)
        .set({
          ...(input.name && { name: input.name }),
          ...(input.metadata && { metadata: input.metadata }),
        })
        .where(
          and(
            eq(machine.id, input.machineId),
            eq(machine.projectId, ctx.project.id),
          ),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      return updated;
    }),
});
