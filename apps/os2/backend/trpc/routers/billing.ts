import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProtectedProcedure, orgAdminMutation } from "../trpc.ts";
import { billingAccount } from "../../db/schema.ts";
import { getStripe } from "../../integrations/stripe/stripe.ts";
import { BILLING_METERS } from "../../billing/meters.generated.ts";
import { env } from "../../../env.ts";

export const billingRouter = router({
  getBillingAccount: orgProtectedProcedure.query(async ({ ctx }) => {
    const account = await ctx.db.query.billingAccount.findFirst({
      where: eq(billingAccount.organizationId, ctx.organization.id),
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

      let account = await ctx.db.query.billingAccount.findFirst({
        where: eq(billingAccount.organizationId, ctx.organization.id),
      });

      if (!account) {
        const [newAccount] = await ctx.db
          .insert(billingAccount)
          .values({
            organizationId: ctx.organization.id,
          })
          .returning();
        account = newAccount;
      }

      if (!account) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create billing account",
        });
      }

      let customerId = account.stripeCustomerId;

      if (!customerId) {
        const customer = await stripe.customers.create({
          name: ctx.organization.name,
          metadata: {
            organizationId: ctx.organization.id,
            organizationSlug: ctx.organization.slug,
          },
        });
        customerId = customer.id;

        await ctx.db
          .update(billingAccount)
          .set({ stripeCustomerId: customerId })
          .where(eq(billingAccount.id, account.id));
      }

      const baseUrl = env.VITE_PUBLIC_URL;
      const defaultSuccessUrl = `${baseUrl}/${ctx.organization.slug}/settings/billing?success=true`;
      const defaultCancelUrl = `${baseUrl}/${ctx.organization.slug}/settings/billing?canceled=true`;

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
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
      where: eq(billingAccount.organizationId, ctx.organization.id),
    });

    if (!account?.stripeCustomerId) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No billing account found. Please subscribe first.",
      });
    }

    const baseUrl = env.VITE_PUBLIC_URL;
    const returnUrl = `${baseUrl}/${ctx.organization.slug}/settings/billing`;

    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: returnUrl,
    });

    return { url: session.url };
  }),

  getUsageSummary: orgProtectedProcedure.query(async ({ ctx }) => {
    const stripe = getStripe();

    const account = await ctx.db.query.billingAccount.findFirst({
      where: eq(billingAccount.organizationId, ctx.organization.id),
    });

    if (!account?.stripeSubscriptionItemId) {
      return null;
    }

    try {
      const usageRecordSummaries = await (stripe.subscriptionItems as any).listUsageRecordSummaries(
        account.stripeSubscriptionItemId,
        { limit: 1 },
      );

      const currentUsage = usageRecordSummaries.data[0];

      return {
        totalUsage: currentUsage?.total_usage ?? 0,
        periodStart: account.currentPeriodStart,
        periodEnd: account.currentPeriodEnd,
        subscriptionStatus: account.subscriptionStatus,
      };
    } catch {
      return {
        totalUsage: 0,
        periodStart: account.currentPeriodStart,
        periodEnd: account.currentPeriodEnd,
        subscriptionStatus: account.subscriptionStatus,
      };
    }
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
