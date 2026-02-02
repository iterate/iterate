import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import type { SubscriptionStatus } from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { env } from "../../env.ts";
import { outboxClient as cc } from "./client.ts";

export function registerStripeConsumers() {
  cc.registerConsumer({
    name: "handleStripeSubscriptionCreated",
    on: "stripe:subscription.created",
    handler: async ({ payload }) => {
      const { subscription, customerId } = payload;
      const db = getDb();

      // Update billing account
      const subscriptionItem = subscription.items.data[0];
      const subscriptionItemId = subscriptionItem?.id;
      const currentPeriodStart = subscriptionItem?.current_period_start;
      const currentPeriodEnd = subscriptionItem?.current_period_end;

      await db
        .update(schema.billingAccount)
        .set({
          stripeSubscriptionId: subscription.id,
          stripeSubscriptionItemId: subscriptionItemId,
          subscriptionStatus: subscription.status as SubscriptionStatus,
          currentPeriodStart: currentPeriodStart ? new Date(currentPeriodStart * 1000) : null,
          currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        })
        .where(eq(schema.billingAccount.stripeCustomerId, customerId));

      // Track subscription_started event in PostHog
      const billingAccount = await db.query.billingAccount.findFirst({
        where: eq(schema.billingAccount.stripeCustomerId, customerId),
      });

      if (billingAccount) {
        await captureServerEvent(env, {
          distinctId: `org:${billingAccount.organizationId}`,
          event: "subscription_started",
          properties: {
            subscription_id: subscription.id,
            status: subscription.status,
            customer_id: customerId,
          },
          groups: { organization: billingAccount.organizationId },
        });
      }

      logger.info("Subscription created", {
        customerId,
        status: subscription.status,
        subscriptionId: subscription.id,
      });

      return "subscription_created";
    },
  });

  cc.registerConsumer({
    name: "handleStripeSubscriptionUpdated",
    on: "stripe:subscription.updated",
    handler: async ({ payload }) => {
      const { subscription, customerId } = payload;
      const db = getDb();

      const subscriptionItem = subscription.items.data[0];
      const subscriptionItemId = subscriptionItem?.id;
      const currentPeriodStart = subscriptionItem?.current_period_start;
      const currentPeriodEnd = subscriptionItem?.current_period_end;

      await db
        .update(schema.billingAccount)
        .set({
          stripeSubscriptionId: subscription.id,
          stripeSubscriptionItemId: subscriptionItemId,
          subscriptionStatus: subscription.status as SubscriptionStatus,
          currentPeriodStart: currentPeriodStart ? new Date(currentPeriodStart * 1000) : null,
          currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        })
        .where(eq(schema.billingAccount.stripeCustomerId, customerId));

      logger.info("Updated billing account", {
        customerId,
        status: subscription.status,
        subscriptionId: subscription.id,
      });

      return "subscription_updated";
    },
  });

  cc.registerConsumer({
    name: "handleStripeSubscriptionDeleted",
    on: "stripe:subscription.deleted",
    handler: async ({ payload }) => {
      const { subscription, customerId } = payload;
      const db = getDb();

      await db
        .update(schema.billingAccount)
        .set({
          subscriptionStatus: "canceled",
          stripeSubscriptionId: null,
          stripeSubscriptionItemId: null,
        })
        .where(eq(schema.billingAccount.stripeCustomerId, customerId));

      logger.info("Subscription deleted", { customerId, subscriptionId: subscription.id });

      return "subscription_deleted";
    },
  });

  cc.registerConsumer({
    name: "handleStripeSubscriptionPaused",
    on: "stripe:subscription.paused",
    handler: async ({ payload }) => {
      const { subscription, customerId } = payload;
      const db = getDb();

      const subscriptionItem = subscription.items.data[0];
      const subscriptionItemId = subscriptionItem?.id;
      const currentPeriodStart = subscriptionItem?.current_period_start;
      const currentPeriodEnd = subscriptionItem?.current_period_end;

      await db
        .update(schema.billingAccount)
        .set({
          stripeSubscriptionId: subscription.id,
          stripeSubscriptionItemId: subscriptionItemId,
          subscriptionStatus: subscription.status as SubscriptionStatus,
          currentPeriodStart: currentPeriodStart ? new Date(currentPeriodStart * 1000) : null,
          currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        })
        .where(eq(schema.billingAccount.stripeCustomerId, customerId));

      logger.info("Subscription paused", { subscriptionId: subscription.id });

      return "subscription_paused";
    },
  });

  cc.registerConsumer({
    name: "handleStripeSubscriptionResumed",
    on: "stripe:subscription.resumed",
    handler: async ({ payload }) => {
      const { subscription, customerId } = payload;
      const db = getDb();

      const subscriptionItem = subscription.items.data[0];
      const subscriptionItemId = subscriptionItem?.id;
      const currentPeriodStart = subscriptionItem?.current_period_start;
      const currentPeriodEnd = subscriptionItem?.current_period_end;

      await db
        .update(schema.billingAccount)
        .set({
          stripeSubscriptionId: subscription.id,
          stripeSubscriptionItemId: subscriptionItemId,
          subscriptionStatus: subscription.status as SubscriptionStatus,
          currentPeriodStart: currentPeriodStart ? new Date(currentPeriodStart * 1000) : null,
          currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        })
        .where(eq(schema.billingAccount.stripeCustomerId, customerId));

      logger.info("Subscription resumed", { subscriptionId: subscription.id });

      return "subscription_resumed";
    },
  });

  cc.registerConsumer({
    name: "handleStripeInvoicePaid",
    on: "stripe:invoice.paid",
    handler: async ({ payload }) => {
      const { invoice, customerId } = payload;
      const db = getDb();

      const subscriptionDetails = invoice.subscription_details;
      if (subscriptionDetails) {
        await db
          .update(schema.billingAccount)
          .set({
            subscriptionStatus: "active",
          })
          .where(eq(schema.billingAccount.stripeCustomerId, customerId));
      }

      // Track invoice_paid event in PostHog
      const billingAccount = await db.query.billingAccount.findFirst({
        where: eq(schema.billingAccount.stripeCustomerId, customerId),
      });

      if (billingAccount) {
        await captureServerEvent(env, {
          distinctId: `org:${billingAccount.organizationId}`,
          event: "invoice_paid",
          properties: {
            invoice_id: invoice.id,
            amount: invoice.amount_paid,
            currency: invoice.currency,
          },
          groups: { organization: billingAccount.organizationId },
        });
      }

      logger.info("Invoice paid", {
        customerId,
        invoiceId: invoice.id,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
      });

      return "invoice_paid";
    },
  });

  cc.registerConsumer({
    name: "handleStripeInvoicePaymentFailed",
    on: "stripe:invoice.payment_failed",
    handler: async ({ payload }) => {
      const { invoice, customerId } = payload;
      const db = getDb();

      await db
        .update(schema.billingAccount)
        .set({
          subscriptionStatus: "past_due",
        })
        .where(eq(schema.billingAccount.stripeCustomerId, customerId));

      // Track payment_failed event in PostHog
      const billingAccount = await db.query.billingAccount.findFirst({
        where: eq(schema.billingAccount.stripeCustomerId, customerId),
      });

      if (billingAccount) {
        await captureServerEvent(env, {
          distinctId: `org:${billingAccount.organizationId}`,
          event: "payment_failed",
          properties: {
            invoice_id: invoice.id,
            amount: invoice.amount_due,
            currency: invoice.currency,
          },
          groups: { organization: billingAccount.organizationId },
        });
      }

      logger.info("Payment failed", {
        customerId,
        invoiceId: invoice.id,
        amountDue: invoice.amount_due,
        currency: invoice.currency,
      });

      return "payment_failed";
    },
  });

  cc.registerConsumer({
    name: "handleStripeCheckoutSessionCompleted",
    on: "stripe:checkout.session.completed",
    handler: async ({ payload }) => {
      const { session } = payload;

      logger.info("Checkout session completed", { sessionId: session.id });

      return "checkout_session_completed";
    },
  });
}
