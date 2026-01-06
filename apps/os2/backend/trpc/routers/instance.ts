import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProtectedProcedure, instanceProtectedProcedure, orgAdminProcedure } from "../trpc.ts";
import { instance } from "../../db/schema.ts";
import { generateSlug } from "../../utils/slug.ts";

export const instanceRouter = router({
  // List instances in organization
  list: orgProtectedProcedure.query(async ({ ctx }) => {
    const instances = await ctx.db.query.instance.findMany({
      where: eq(instance.organizationId, ctx.organization.id),
      orderBy: (inst, { desc }) => [desc(inst.createdAt)],
    });

    return instances;
  }),

  // Get instance by slug
  bySlug: instanceProtectedProcedure.query(async ({ ctx }) => {
    return ctx.instance;
  }),

  // Create a new instance
  create: orgAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = generateSlug(input.name);

      const [newInstance] = await ctx.db
        .insert(instance)
        .values({
          name: input.name,
          slug,
          organizationId: ctx.organization.id,
        })
        .returning();

      if (!newInstance) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create instance",
        });
      }

      return newInstance;
    }),

  // Update instance settings
  update: instanceProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(instance)
        .set({
          ...(input.name && { name: input.name }),
        })
        .where(eq(instance.id, ctx.instance.id))
        .returning();

      return updated;
    }),

  // Delete instance
  delete: instanceProtectedProcedure.mutation(async ({ ctx }) => {
    // Check if this is the last instance in the organization
    const instanceCount = await ctx.db.query.instance.findMany({
      where: eq(instance.organizationId, ctx.organization.id),
    });

    if (instanceCount.length <= 1) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Cannot delete the last instance in an organization",
      });
    }

    await ctx.db.delete(instance).where(eq(instance.id, ctx.instance.id));

    return { success: true };
  }),
});
