import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../../trpc/trpc.ts";
import { schema } from "../../db/client.ts";
import { env } from "../../../env.ts";
import { stripeClient } from "./stripe.ts";

export const stripeRouter = router({
  createBillingPortalSession: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the user is a member of this organization and get the organization in one query
      const organization = await ctx.db.query.organization.findFirst({
        where: eq(schema.organization.id, input.organizationId),
        with: {
          members: {
            where: eq(schema.organizationUserMembership.userId, ctx.user.id),
          },
        },
      });

      if (!organization) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Organization ${input.organizationId} not found`,
        });
      }

      if (!organization.members || organization.members.length === 0) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `User ${ctx.user.id} does not have access to this organization ${input.organizationId}`,
        });
      }

      if (!organization.stripeCustomerId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Organization ${input.organizationId} does not have a Stripe customer ID`,
        });
      }

      const session = await stripeClient.billingPortal.sessions.create({
        customer: organization.stripeCustomerId,
        return_url: `${env.VITE_PUBLIC_URL}/${input.organizationId}`,
      });

      return {
        url: session.url,
      };
    }),
});
