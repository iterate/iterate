import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { env } from "../../../env.ts";
import { getDb } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import type { SubscriptionStatus } from "../../db/schema.ts";
import { captureServerEvent } from "../../lib/posthog.ts";
import { logger } from "../../tag-logger.ts";

type BillingEvent = {
  event: string;
  organizationId: string;
  properties: Record<string, unknown>;
};

async function trackBillingEvent({
  event,
  organizationId,
  properties,
}: BillingEvent): Promise<void> {
  await captureServerEvent(env, {
    distinctId: `org:${organizationId}`,
    event,
    properties,
    groups: { organization: organizationId },
  });
}

async function updateBillingAccount(subscription: Stripe.Subscription): Promise<void> {
  const db = getDb();
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

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
}

async function getBillingAccountByCustomerId(customerId: string) {
  const db = getDb();
  return db.query.billingAccount.findFirst({
    where: eq(schema.billingAccount.stripeCustomerId, customerId),
  });
}

export async function handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
  await updateBillingAccount(subscription);

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const billingAccount = await getBillingAccountByCustomerId(customerId);

  if (billingAccount) {
    await trackBillingEvent({
      organizationId: billingAccount.organizationId,
      event: "subscription_started",
      properties: {
        subscription_id: subscription.id,
        status: subscription.status,
        customer_id: customerId,
      },
    });
  }

  logger.info("Subscription created", {
    customerId,
    status: subscription.status,
    subscriptionId: subscription.id,
  });
}

export async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  await updateBillingAccount(subscription);

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  logger.info("Updated billing account", {
    customerId,
    status: subscription.status,
    subscriptionId: subscription.id,
  });
}

export async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const db = getDb();
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  await db
    .update(schema.billingAccount)
    .set({
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      stripeSubscriptionItemId: null,
    })
    .where(eq(schema.billingAccount.stripeCustomerId, customerId));

  logger.info("Subscription deleted", { customerId, subscriptionId: subscription.id });
}

export async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const db = getDb();
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

  if (!customerId) return;

  const subscriptionDetails = invoice.parent?.subscription_details;
  if (subscriptionDetails) {
    await db
      .update(schema.billingAccount)
      .set({
        subscriptionStatus: "active",
      })
      .where(eq(schema.billingAccount.stripeCustomerId, customerId));
  }

  const billingAccount = await getBillingAccountByCustomerId(customerId);

  if (billingAccount) {
    await trackBillingEvent({
      organizationId: billingAccount.organizationId,
      event: "invoice_paid",
      properties: {
        invoice_id: invoice.id,
        amount: invoice.amount_paid,
        currency: invoice.currency,
      },
    });
  }

  logger.info("Invoice paid", {
    customerId,
    invoiceId: invoice.id,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
  });
}

export async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const db = getDb();
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

  if (!customerId) return;

  await db
    .update(schema.billingAccount)
    .set({
      subscriptionStatus: "past_due",
    })
    .where(eq(schema.billingAccount.stripeCustomerId, customerId));

  const billingAccount = await getBillingAccountByCustomerId(customerId);

  if (billingAccount) {
    await trackBillingEvent({
      organizationId: billingAccount.organizationId,
      event: "payment_failed",
      properties: {
        invoice_id: invoice.id,
        amount: invoice.amount_due,
        currency: invoice.currency,
      },
    });
  }

  logger.info("Payment failed", {
    customerId,
    invoiceId: invoice.id,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
  });
}

export async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  logger.info("Checkout session completed", { sessionId: session.id });
}
