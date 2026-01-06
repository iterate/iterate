import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, instanceProtectedProcedure } from "../trpc.ts";
import * as schema from "../../db/schema.ts";

export const machineRouter = router({
  list: instanceProtectedProcedure.query(async ({ ctx }) => {
    return ctx.db.query.machine.findMany({
      where: eq(schema.machine.instanceId, ctx.instance.id),
      orderBy: (machine, { desc }) => [desc(machine.createdAt)],
    });
  }),

  create: instanceProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        type: z.enum(["daytona"]).default("daytona"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [machine] = await ctx.db
        .insert(schema.machine)
        .values({
          name: input.name,
          type: input.type,
          instanceId: ctx.instance.id,
          state: "started",
        })
        .returning();

      return machine;
    }),

  get: instanceProtectedProcedure
    .input(z.object({ machineId: z.string() }))
    .query(async ({ ctx, input }) => {
      const machine = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.id, input.machineId),
          eq(schema.machine.instanceId, ctx.instance.id),
        ),
      });

      if (!machine) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      return machine;
    }),

  archive: instanceProtectedProcedure
    .input(z.object({ machineId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const machine = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.id, input.machineId),
          eq(schema.machine.instanceId, ctx.instance.id),
        ),
      });

      if (!machine) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      const [updated] = await ctx.db
        .update(schema.machine)
        .set({ state: "archived" })
        .where(eq(schema.machine.id, input.machineId))
        .returning();

      return updated;
    }),

  delete: instanceProtectedProcedure
    .input(z.object({ machineId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const machine = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.id, input.machineId),
          eq(schema.machine.instanceId, ctx.instance.id),
        ),
      });

      if (!machine) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Machine not found",
        });
      }

      await ctx.db.delete(schema.machine).where(eq(schema.machine.id, input.machineId));

      return { success: true };
    }),
});
