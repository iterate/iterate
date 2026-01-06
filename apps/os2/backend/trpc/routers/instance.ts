import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProtectedProcedure, instanceProtectedProcedure } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { generateSlugFromName } from "../../utils/slug.ts";

export const instanceRouter = router({
  list: orgProtectedProcedure.query(async ({ ctx }) => {
    return ctx.db.query.instance.findMany({
      where: eq(schema.instance.organizationId, ctx.organization.id),
    });
  }),

  create: orgProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = generateSlugFromName(input.name);

      const existing = await ctx.db.query.instance.findFirst({
        where: and(
          eq(schema.instance.organizationId, ctx.organization.id),
          eq(schema.instance.slug, slug),
        ),
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Instance with slug "${slug}" already exists in this organization`,
        });
      }

      const [instance] = await ctx.db
        .insert(schema.instance)
        .values({
          name: input.name,
          slug,
          organizationId: ctx.organization.id,
        })
        .returning();

      return instance;
    }),

  get: instanceProtectedProcedure.query(async ({ ctx }) => {
    return ctx.instance;
  }),

  update: instanceProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(schema.instance)
        .set({
          name: input.name,
        })
        .where(eq(schema.instance.id, ctx.instance.id))
        .returning();
      return updated;
    }),

  delete: instanceProtectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(schema.instance).where(eq(schema.instance.id, ctx.instance.id));
    return { success: true };
  }),
});
