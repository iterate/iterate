import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProtectedProcedure, orgAdminMutation } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { getStripe } from "../../integrations/stripe/stripe.ts";
import { BILLING_METERS } from "../../billing/meters.generated.ts";
import { env } from "../../../env.ts";

export const billingRouter = router({
  getBillingAccount: orgProtectedProcedure.query(async ({ ctx }) => {
    const account = await ctx.db.query.billingAccount.findFirst({
      where: eq(schema.billingAccount.organizationId, ctx.organization.id),
    });

    return account ?? null;
  }),

  createCheckoutSession: orgAdminMutation
    .input(
      z.object({
        successUrl: z.string().url().optional(),
        cancelUrl: z.string().url().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const stripe = getStripe();

      const account = await ctx.db.transaction(async (tx) => {
        let existing = await tx.query.billingAccount.findFirst({
          where: eq(schema.billingAccount.organizationId, ctx.organization.id),
        });

        if (!existing) {
          const [newAccount] = await tx
            .insert(schema.billingAccount)
            .values({
              organizationId: ctx.organization.id,
            })
            .returning();
          existing = newAccount;
        }

        if (!existing) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create billing account",
          });
        }

        if (!existing.stripeCustomerId) {
          const customer = await stripe.customers.create({
            name: ctx.organization.name,
            email: ctx.user.email ?? undefined, // For Stripe→PostHog data warehouse linking
            metadata: {
              organizationId: ctx.organization.id,
              organizationSlug: ctx.organization.slug,
              createdByUserId: ctx.user.id, // For PostHog tracking in webhooks
            },
          });

          await tx
            .update(schema.billingAccount)
            .set({ stripeCustomerId: customer.id })
            .where(eq(schema.billingAccount.id, existing.id));

          existing = { ...existing, stripeCustomerId: customer.id };
        }

        return existing;
      });

      const baseUrl = env.VITE_PUBLIC_URL;
      // Encode slug to handle legacy data with periods or special chars
      const encodedOrgSlug = encodeURIComponent(ctx.organization.slug);
      const defaultSuccessUrl = `${baseUrl}/orgs/${encodedOrgSlug}/billing?success=true`;
      const defaultCancelUrl = `${baseUrl}/orgs/${encodedOrgSlug}/billing?canceled=true`;

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: account.stripeCustomerId!,
        line_items: [
          {
            price: env.STRIPE_METERED_PRICE_ID,
          },
        ],
        success_url: input.successUrl ?? defaultSuccessUrl,
        cancel_url: input.cancelUrl ?? defaultCancelUrl,
        client_reference_id: ctx.organization.id,
        subscription_data: {
          metadata: {
            organizationId: ctx.organization.id,
            organizationSlug: ctx.organization.slug,
          },
        },
      });

      if (!session.url) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create checkout session",
        });
      }

      return { url: session.url };
    }),

  createPortalSession: orgAdminMutation.mutation(async ({ ctx }) => {
    const stripe = getStripe();

    const account = await ctx.db.query.billingAccount.findFirst({
      where: eq(schema.billingAccount.organizationId, ctx.organization.id),
    });

    if (!account?.stripeCustomerId) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No billing account found. Please subscribe first.",
      });
    }

    const baseUrl = env.VITE_PUBLIC_URL;
    // Encode slug to handle legacy data with periods or special chars
    const returnUrl = `${baseUrl}/orgs/${encodeURIComponent(ctx.organization.slug)}/billing`;

    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: returnUrl,
    });

    return { url: session.url };
  }),

  getUsageSummary: orgProtectedProcedure.query(async ({ ctx }) => {
    const account = await ctx.db.query.billingAccount.findFirst({
      where: eq(schema.billingAccount.organizationId, ctx.organization.id),
    });

    if (!account?.stripeSubscriptionId) {
      return null;
    }

    return {
      totalUsage: 0,
      periodStart: account.currentPeriodStart,
      periodEnd: account.currentPeriodEnd,
      subscriptionStatus: account.subscriptionStatus,
    };
  }),

  getAvailableMeters: orgProtectedProcedure.query(() => {
    const meters = Object.values(BILLING_METERS);

    type MeterSummary = {
      key: string;
      displayName: string;
      provider: string;
      model?: string;
      unit: string;
      direction?: string;
      costPerUnit: number;
    };

    const byCategory = meters.reduce(
      (acc, meter) => {
        if (!acc[meter.category]) {
          acc[meter.category] = [];
        }
        acc[meter.category].push({
          key: meter.key,
          displayName: meter.displayName,
          provider: meter.provider,
          model: meter.model,
          unit: meter.unit,
          direction: meter.direction,
          costPerUnit: meter.costPerUnit,
        });
        return acc;
      },
      {} as Record<string, MeterSummary[]>,
    );

    return {
      totalCount: meters.length,
      byCategory,
    };
  }),
});
