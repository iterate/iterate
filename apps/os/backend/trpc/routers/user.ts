import { z } from "zod/v4";
import { and, eq, ne } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import { waitUntil } from "cloudflare:workers";
import { protectedProcedure, router } from "../trpc.ts";
import { user } from "../../db/schema.ts";

import { schema, type DB } from "../../db/client.ts";
import { stripeClient } from "../../integrations/stripe/stripe.ts";
import { logger } from "../../tag-logger.ts";

interface DeleteUserAccountParams {
  db: DB;
  user: typeof schema.user.$inferSelect;
}

export interface DeleteUserAccountResult {
  success: true;
  deletedUser: string;
  deletedOrganizations: string[];
  deletedEstates: string[];
}

export async function deleteUserAccount({
  db,
  user,
}: DeleteUserAccountParams): Promise<DeleteUserAccountResult> {
  const result = await db.transaction(async (tx) => {
    const ownedMemberships = await tx.query.organizationUserMembership.findMany({
      where: eq(schema.organizationUserMembership.userId, user.id),
      with: {
        organization: {
          with: {
            estates: true,
          },
        },
      },
    });

    const ownerOrganizations = ownedMemberships.filter((membership) => membership.role === "owner");

    const deletedOrganizations: string[] = [];
    const deletedEstates: string[] = [];
    const stripeCustomerIds: string[] = [];

    for (const membership of ownerOrganizations) {
      const org = membership.organization;

      // Check if there exists another owner for this organization (besides the current user)
      const anotherOwnerExists = await tx.query.organizationUserMembership.findFirst({
        where: and(
          eq(schema.organizationUserMembership.organizationId, org.id),
          eq(schema.organizationUserMembership.role, "owner"),
          ne(schema.organizationUserMembership.userId, user.id),
        ),
        columns: { id: true },
      });

      if (anotherOwnerExists) {
        // Another owner remains; do not delete the organization
        continue;
      }

      // No other owners remain; delete the organization (cascades to estates and their children)
      for (const estate of org.estates) {
        deletedEstates.push(estate.id);
      }

      if (org.stripeCustomerId) {
        stripeCustomerIds.push(org.stripeCustomerId);
      }

      await tx.delete(schema.organization).where(eq(schema.organization.id, org.id));
      deletedOrganizations.push(org.id);
    }

    await tx.delete(schema.user).where(eq(schema.user.id, user.id));

    return {
      success: true as const,
      deletedUser: user.id,
      deletedOrganizations,
      deletedEstates,
      stripeCustomerIds,
    };
  });

  const { stripeCustomerIds, ...payload } = result;

  if (stripeCustomerIds.length > 0) {
    waitUntil(
      Promise.all(
        stripeCustomerIds.map(async (customerId) => {
          try {
            await stripeClient.customers.del(customerId);
          } catch (error) {
            logger.error(`Failed to delete Stripe customer ${customerId}`, error);
          }
        }),
      ),
    );
  }

  return payload;
}

export const userRouter = router({
  // Get current user information
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.user;
  }),

  // Update user profile
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Name cannot be empty").max(100, "Name too long").optional(),
        debugMode: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Update the user
      const [updatedUser] = await ctx.db
        .update(user)
        .set(input)
        .where(eq(user.id, userId))
        .returning();

      if (!updatedUser) {
        throw new Error("Failed to update user");
      }

      return updatedUser;
    }),

  deleteAccount: protectedProcedure.mutation(async ({ ctx }) => {
    const currentUser = await ctx.db.query.user.findFirst({
      where: eq(user.id, ctx.user.id),
    });

    if (!currentUser) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    return deleteUserAccount({ db: ctx.db, user: currentUser });
  }),
});
