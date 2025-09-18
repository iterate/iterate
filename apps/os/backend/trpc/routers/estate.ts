import { z } from "zod";
import { eq } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc.ts";
import { estate, organizationUserMembership } from "../../db/schema.ts";
import type { DB } from "../../db/client.ts";

// Helper function to check if user has access to a specific estate
export const checkUserEstateAccess = async (
  db: DB,
  userId: string,
  estateId: string,
): Promise<boolean> => {
  const userWithEstates = await db.query.organizationUserMembership.findFirst({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: {
        with: {
          estates: true,
        },
      },
    },
  });

  if (!userWithEstates?.organization?.estates) {
    return false;
  }

  return userWithEstates.organization.estates.some((estate: any) => estate.id === estateId);
};

export const estateRouter = router({
  // Get a specific estate (with permission check)
  get: protectedProcedure
    .input(
      z.object({
        estateId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Check if user has access to this estate
      const hasAccess = await checkUserEstateAccess(ctx.db, ctx.user.id, input.estateId);
      if (!hasAccess) {
        throw new Error("Access denied: User does not have permission to access this estate");
      }

      const userEstate = await ctx.db.query.estate.findFirst({
        where: eq(estate.id, input.estateId),
      });

      if (!userEstate) {
        throw new Error("Estate not found");
      }

      return {
        id: userEstate.id,
        name: userEstate.name,
        organizationId: userEstate.organizationId,
        createdAt: userEstate.createdAt,
        updatedAt: userEstate.updatedAt,
      };
    }),

  // Update estate name
  updateName: protectedProcedure
    .input(
      z.object({
        estateId: z.string(),
        name: z.string().min(1, "Estate name cannot be empty").max(100, "Estate name too long"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Check if user has access to this estate
      const hasAccess = await checkUserEstateAccess(ctx.db, ctx.user.id, input.estateId);
      if (!hasAccess) {
        throw new Error("Access denied: User does not have permission to update this estate");
      }

      // Update the estate name
      const updatedEstate = await ctx.db
        .update(estate)
        .set({
          name: input.name,
          updatedAt: new Date(),
        })
        .where(eq(estate.id, input.estateId))
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
});
