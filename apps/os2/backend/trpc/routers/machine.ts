import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { router, projectProtectedProcedure } from "../trpc.ts";
import { machine, MachineType } from "../../db/schema.ts";

export const machineRouter = router({
  list: projectProtectedProcedure.query(async ({ ctx }) => {
    return ctx.db.query.machine.findMany({
      where: eq(machine.projectId, ctx.project.id),
      orderBy: (m, { desc }) => desc(m.createdAt),
    });
  }),

  create: projectProtectedProcedure
    .input(
      z.object({
        type: z.enum(MachineType).default("daytona"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [created] = await ctx.db
        .insert(machine)
        .values({
          type: input.type,
          projectId: ctx.project.id,
          createdBy: ctx.user.id,
        })
        .returning();

      return created;
    }),

  archive: projectProtectedProcedure
    .input(z.object({ machineId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(machine)
        .set({ state: "archived" })
        .where(and(eq(machine.id, input.machineId), eq(machine.projectId, ctx.project.id)))
        .returning();

      return updated;
    }),

  delete: projectProtectedProcedure
    .input(z.object({ machineId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(machine)
        .where(and(eq(machine.id, input.machineId), eq(machine.projectId, ctx.project.id)));

      return { success: true };
    }),
});
