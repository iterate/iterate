import { z } from "zod";
import { eq } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc.ts";
import { organizationUserMembership } from "../../db/schema.ts";

export const estatesRouter = router({
  // Get all estates for the current user
  list: protectedProcedure.query(async ({ ctx }) => {
    const userOrganizations = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.userId, ctx.user.id),
      with: {
        organization: {
          with: {
            estates: true,
          },
        },
      },
    });

    // Flatten estates from all organizations the user belongs to
    const estates = userOrganizations.flatMap(({ organization }) =>
      organization.estates.map((estate) => ({
        id: estate.id,
        name: estate.name,
        organizationId: estate.organizationId,
        organizationName: organization.name,
        createdAt: estate.createdAt,
        updatedAt: estate.updatedAt,
      })),
    );

    return estates;
  }),

  // Get current user's default/first estate
  getCurrent: protectedProcedure.query(async ({ ctx }) => {
    const userOrganization = await ctx.db.query.organizationUserMembership.findFirst({
      where: eq(organizationUserMembership.userId, ctx.user.id),
      with: {
        organization: {
          with: {
            estates: {
              limit: 1,
            },
          },
        },
      },
    });

    if (!userOrganization || !userOrganization.organization.estates[0]) {
      throw new Error("User has no associated estate");
    }

    const estate = userOrganization.organization.estates[0];
    return {
      id: estate.id,
      name: estate.name,
      organizationId: estate.organizationId,
      organizationName: userOrganization.organization.name,
      createdAt: estate.createdAt,
      updatedAt: estate.updatedAt,
    };
  }),

  // Get estate by ID (with permission check)
  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const userOrganizations = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.userId, ctx.user.id),
      with: {
        organization: {
          with: {
            estates: true,
          },
        },
      },
    });

    // Find the estate across all user's organizations
    const userEstate = userOrganizations
      .flatMap(({ organization }) =>
        organization.estates.map((estate) => ({
          estate,
          organizationName: organization.name,
        })),
      )
      .find(({ estate }) => estate.id === input.id);

    if (!userEstate) {
      throw new Error("Estate not found or access denied");
    }

    return {
      id: userEstate.estate.id,
      name: userEstate.estate.name,
      organizationId: userEstate.estate.organizationId,
      organizationName: userEstate.organizationName,
      createdAt: userEstate.estate.createdAt,
      updatedAt: userEstate.estate.updatedAt,
    };
  }),
});
