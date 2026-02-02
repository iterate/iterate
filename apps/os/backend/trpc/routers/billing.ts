import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgAdminMutation, orgAdminProcedure, orgProtectedProcedure } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { getStripe } from "../../integrations/stripe/stripe.ts";
import { BILLING_METERS } from "../../billing/meters.generated.ts";
import { env } from "../../../env.ts";
import { internalOutboxClient } from "../../outbox/internal-client.ts";

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
      const baseUrl = env.VITE_PUBLIC_URL;
      const defaultSuccessUrl = `${baseUrl}/orgs/${ctx.organization.slug}/billing?success=true`;
      const defaultCancelUrl = `${baseUrl}/orgs/${ctx.organization.slug}/billing?canceled=true`;

      const { eventId } = await ctx.db.transaction(async (tx) => {
        let account = await tx.query.billingAccount.findFirst({
          where: eq(schema.billingAccount.organizationId, ctx.organization.id),
        });

        if (!account) {
          const [newAccount] = await tx
            .insert(schema.billingAccount)
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

        return internalOutboxClient.send(
          { transaction: tx, parent: ctx.db },
          "billing:checkout:initiated",
          {
            organizationId: ctx.organization.id,
            organizationSlug: ctx.organization.slug,
            organizationName: ctx.organization.name,
            createdByUserId: ctx.user.id,
            createdByUserEmail: ctx.user.email ?? undefined,
            successUrl: input.successUrl ?? defaultSuccessUrl,
            cancelUrl: input.cancelUrl ?? defaultCancelUrl,
            status: "pending",
          },
        );
      });

      return { eventId };
    }),

  getCheckoutSessionStatus: orgAdminProcedure
    .input(
      z.object({
        eventId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const eventId = Number(input.eventId);

      if (!Number.isFinite(eventId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid checkout event id",
        });
      }

      const event = await ctx.db.query.outboxEvent.findFirst({
        where: and(
          eq(schema.outboxEvent.id, eventId),
          eq(schema.outboxEvent.name, "billing:checkout:initiated"),
        ),
        columns: { payload: true },
      });

      if (!event) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkout session not found",
        });
      }

      const payload = event.payload as {
        organizationId?: string;
        status?: "pending" | "ready";
        checkoutUrl?: string;
      };

      if (!payload.organizationId || payload.organizationId !== ctx.organization.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkout session not found",
        });
      }

      return {
        status: payload.status ?? "pending",
        url: payload.checkoutUrl ?? null,
      };
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
    const returnUrl = `${baseUrl}/orgs/${ctx.organization.slug}/billing`;

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
