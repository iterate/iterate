import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import {
  ORPCError,
  orgProtectedProcedure,
  orgAdminMutation,
  withOrgAdminMutationInput,
} from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { getStripe } from "../../integrations/stripe/stripe.ts";
import { BILLING_METERS } from "../../billing/meters.generated.ts";
import { env } from "../../../env.ts";

export const billingRouter = {
  getBillingAccount: orgProtectedProcedure.handler(async ({ context }) => {
    const account = await context.db.query.billingAccount.findFirst({
      where: eq(schema.billingAccount.organizationId, context.organization.id),
    });

    return account ?? null;
  }),

  createCheckoutSession: withOrgAdminMutationInput({
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
  }).handler(async ({ context, input }) => {
    const stripe = getStripe();

    const account = await context.db.transaction(async (tx) => {
      let existing = await tx.query.billingAccount.findFirst({
        where: eq(schema.billingAccount.organizationId, context.organization.id),
      });

      if (!existing) {
        const [newAccount] = await tx
          .insert(schema.billingAccount)
          .values({
            organizationId: context.organization.id,
          })
          .returning();
        existing = newAccount;
      }

      if (!existing) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Failed to create billing account",
        });
      }

      if (!existing.stripeCustomerId) {
        const customer = await stripe.customers.create({
          name: context.organization.name,
          email: context.user.email ?? undefined, // For Stripe→PostHog data warehouse linking
          metadata: {
            organizationId: context.organization.id,
            organizationSlug: context.organization.slug,
            createdByUserId: context.user.id, // For PostHog tracking in webhooks
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
    const defaultSuccessUrl = `${baseUrl}/orgs/${context.organization.slug}/billing?success=true`;
    const defaultCancelUrl = `${baseUrl}/orgs/${context.organization.slug}/billing?canceled=true`;

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
      client_reference_id: context.organization.id,
      subscription_data: {
        metadata: {
          organizationId: context.organization.id,
          organizationSlug: context.organization.slug,
        },
      },
    });

    if (!session.url) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to create checkout session",
      });
    }

    return { url: session.url };
  }),

  createPortalSession: orgAdminMutation.handler(async ({ context }) => {
    const stripe = getStripe();

    const account = await context.db.query.billingAccount.findFirst({
      where: eq(schema.billingAccount.organizationId, context.organization.id),
    });

    if (!account?.stripeCustomerId) {
      throw new ORPCError("NOT_FOUND", {
        message: "No billing account found. Please subscribe first.",
      });
    }

    const baseUrl = env.VITE_PUBLIC_URL;
    const returnUrl = `${baseUrl}/orgs/${context.organization.slug}/billing`;

    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: returnUrl,
    });

    return { url: session.url };
  }),

  getUsageSummary: orgProtectedProcedure.handler(async ({ context }) => {
    const account = await context.db.query.billingAccount.findFirst({
      where: eq(schema.billingAccount.organizationId, context.organization.id),
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

  getAvailableMeters: orgProtectedProcedure.handler(() => {
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
};
