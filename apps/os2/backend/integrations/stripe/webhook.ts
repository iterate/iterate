import { Hono } from "hono";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import type { SubscriptionStatus } from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import type { CloudflareEnv } from "../../../env.ts";
import { getStripe } from "./stripe.ts";

export const stripeWebhookApp = new Hono<{ Bindings: CloudflareEnv }>();

stripeWebhookApp.post("/", async (c) => {
  const stripe = getStripe();
  const db = getDb();

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

  const existingEvent = await db.query.stripeEvent.findFirst({
    where: eq(schema.stripeEvent.eventId, event.id),
  });

  if (existingEvent) {
    return c.json({ received: true, status: "already_processed" });
  }

  await db.insert(schema.stripeEvent).values({
    eventId: event.id,
    type: event.type,
  });

  try {
    switch (event.type) {
      case "customer.subscription.created":
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

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaid(invoice);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentFailed(invoice);
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

async function handleSubscriptionUpdate(subscription: Stripe.Subscription): Promise<void> {
  const db = getDb();
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  const subscriptionItemId = subscription.items.data[0]?.id;

  const existing = await db.query.billingAccount.findFirst({
    where: eq(schema.billingAccount.stripeCustomerId, customerId),
  });

  const sub = subscription as Stripe.Subscription & {
    current_period_start?: number;
    current_period_end?: number;
  };

  if (existing) {
    await db
      .update(schema.billingAccount)
      .set({
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionItemId: subscriptionItemId,
        subscriptionStatus: subscription.status as SubscriptionStatus,
        currentPeriodStart: sub.current_period_start
          ? new Date(sub.current_period_start * 1000)
          : null,
        currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      })
      .where(eq(schema.billingAccount.stripeCustomerId, customerId));

    logger.info(`Updated billing account for customer ${customerId}: ${subscription.status}`);
  } else {
    logger.info(`No billing account found for customer ${customerId}`);
  }
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

  logger.info(`Subscription deleted for customer ${customerId}`);
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

  if (!customerId) return;

  logger.info(
    `Invoice paid for customer ${customerId}: ${invoice.amount_paid / 100} ${invoice.currency}`,
  );
}

async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

  if (!customerId) return;

  logger.info(`Payment failed for customer ${customerId}`);
}
