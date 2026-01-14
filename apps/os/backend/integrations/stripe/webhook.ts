import { Hono } from "hono";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import type { SubscriptionStatus } from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import type { CloudflareEnv } from "../../../env.ts";
import { captureServerEvent } from "../../lib/posthog.ts";
import { getStripe } from "./stripe.ts";

export const stripeWebhookApp = new Hono<{ Bindings: CloudflareEnv }>();

/**
 * Track a billing event in PostHog for an organization.
 * Uses org:{organizationId} as distinctId since billing events are org-level,
 * not user-level, and shouldn't be attributed to any specific user.
 */
async function trackBillingEvent(
  env: CloudflareEnv,
  organizationId: string,
  event: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await captureServerEvent(env, {
    // Use org prefix for org-level events to avoid attributing to a specific user
    distinctId: `org:${organizationId}`,
    event,
    properties,
    groups: { organization: organizationId },
  });
}

stripeWebhookApp.post("/", async (c) => {
  const stripe = getStripe();

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  let event: Stripe.Event;
  try {
    const body = await c.req.text();
    event = await stripe.webhooks.constructEventAsync(body, signature, c.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error("Webhook signature verification failed", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "customer.subscription.created": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionCreated(c.env, subscription);
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdate(subscription);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case "customer.subscription.paused": {
        const subscription = event.data.object as Stripe.Subscription;
        logger.info("Subscription paused", { subscriptionId: subscription.id });
        await handleSubscriptionUpdate(subscription);
        break;
      }

      case "customer.subscription.resumed": {
        const subscription = event.data.object as Stripe.Subscription;
        logger.info("Subscription resumed", { subscriptionId: subscription.id });
        await handleSubscriptionUpdate(subscription);
        break;
      }

      case "customer.subscription.trial_will_end": {
        const subscription = event.data.object as Stripe.Subscription;
        logger.info("Subscription trial will end", {
          subscriptionId: subscription.id,
          trialEnd: subscription.trial_end,
        });
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        logger.info("Checkout session completed", { sessionId: session.id });
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaid(c.env, invoice);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentFailed(c.env, invoice);
        break;
      }

      default:
        logger.info(`Unhandled webhook event type: ${event.type}`);
    }
  } catch (err) {
    logger.error(`Error processing webhook ${event.type}`, err);
    return c.json({ error: "Webhook processing failed" }, 500);
  }

  return c.json({ received: true });
});

async function handleSubscriptionCreated(
  env: CloudflareEnv,
  subscription: Stripe.Subscription,
): Promise<void> {
  const db = getDb();
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  // Update billing account
  await updateBillingAccount(subscription);

  // Track subscription_started event in PostHog
  const billingAccount = await db.query.billingAccount.findFirst({
    where: eq(schema.billingAccount.stripeCustomerId, customerId),
  });

  if (billingAccount) {
    await trackBillingEvent(env, billingAccount.organizationId, "subscription_started", {
      subscription_id: subscription.id,
      status: subscription.status,
      customer_id: customerId,
    });
  }

  logger.info("Subscription created", {
    customerId,
    status: subscription.status,
    subscriptionId: subscription.id,
  });
}

async function handleSubscriptionUpdate(subscription: Stripe.Subscription): Promise<void> {
  await updateBillingAccount(subscription);

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  logger.info("Updated billing account", {
    customerId,
    status: subscription.status,
    subscriptionId: subscription.id,
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

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
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

async function handleInvoicePaid(env: CloudflareEnv, invoice: Stripe.Invoice): Promise<void> {
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

  // Track invoice_paid event in PostHog
  const billingAccount = await db.query.billingAccount.findFirst({
    where: eq(schema.billingAccount.stripeCustomerId, customerId),
  });

  if (billingAccount) {
    await trackBillingEvent(env, billingAccount.organizationId, "invoice_paid", {
      invoice_id: invoice.id,
      amount: invoice.amount_paid,
      currency: invoice.currency,
    });
  }

  logger.info("Invoice paid", {
    customerId,
    invoiceId: invoice.id,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
  });
}

async function handlePaymentFailed(env: CloudflareEnv, invoice: Stripe.Invoice): Promise<void> {
  const db = getDb();
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

  if (!customerId) return;

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
    await trackBillingEvent(env, billingAccount.organizationId, "payment_failed", {
      invoice_id: invoice.id,
      amount: invoice.amount_due,
      currency: invoice.currency,
    });
  }

  logger.info("Payment failed", {
    customerId,
    invoiceId: invoice.id,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
  });
}
