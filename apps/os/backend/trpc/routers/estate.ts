import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import {
  protectedProcedure,
  estateProtectedProcedure,
  getUserEstateAccess,
  router,
} from "../trpc.ts";
import { estate, builds } from "../../db/schema.ts";

export const estateRouter = router({
  // Check if user has access to a specific estate (non-throwing version)
  checkAccess: protectedProcedure
    .input(
      z.object({
        estateId: z.string(),
        organizationId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        // Use the shared helper function
        const result = await getUserEstateAccess(
          ctx.db,
          ctx.user.id,
          input.estateId,
          input.organizationId,
        );

        if (result.hasAccess && result.estate) {
          return {
            hasAccess: true,
            estate: {
              id: result.estate.id,
              name: result.estate.name,
              organizationId: result.estate.organizationId,
            },
          };
        }

        return { hasAccess: false, estate: null };
      } catch {
        // Return false on any error instead of throwing
        return { hasAccess: false, estate: null };
      }
    }),

  // Get a specific estate (with permission check)
  get: estateProtectedProcedure.query(async ({ ctx }) => {
    // The estate is already validated and available in context
    const userEstate = ctx.estate;

    return {
      id: userEstate.id,
      name: userEstate.name,
      organizationId: userEstate.organizationId,
      createdAt: userEstate.createdAt,
      updatedAt: userEstate.updatedAt,
    };
  }),

  // Update estate name
  updateName: estateProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Estate name cannot be empty").max(100, "Estate name too long"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The estate is already validated and available in context
      const estateId = ctx.estate.id;

      // Update the estate name
      const updatedEstate = await ctx.db
        .update(estate)
        .set({
          name: input.name,
          updatedAt: new Date(),
        })
        .where(eq(estate.id, estateId))
        .returning();

      if (!updatedEstate[0]) {
        throw new Error("Failed to update estate");
      }

      return {
        id: updatedEstate[0].id,
        name: updatedEstate[0].name,
        organizationId: updatedEstate[0].organizationId,
        createdAt: updatedEstate[0].createdAt,
        updatedAt: updatedEstate[0].updatedAt,
      };
    }),

  // Get builds for an estate
  getBuilds: estateProtectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { estateId } = input;
      const limit = input.limit || 20;

      const estateBuilds = await ctx.db
        .select()
        .from(builds)
        .where(eq(builds.estateId, estateId))
        .orderBy(desc(builds.createdAt))
        .limit(limit);

      return estateBuilds;
    }),
});
