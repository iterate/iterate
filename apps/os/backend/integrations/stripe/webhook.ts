import { Hono } from "hono";
import type Stripe from "stripe";
import { getDb } from "../../db/client.ts";
import { logger } from "../../tag-logger.ts";
import type { CloudflareEnv } from "../../../env.ts";
import { outboxClient } from "../../outbox/client.ts";
import { getStripe } from "./stripe.ts";

export const stripeWebhookApp = new Hono<{ Bindings: CloudflareEnv }>();

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

  const db = getDb();

  try {
    switch (event.type) {
      case "customer.subscription.created": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;
        await outboxClient.sendTx(db, "stripe:subscription.created", async (_tx) => ({
          payload: { subscription, customerId },
        }));
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;
        await outboxClient.sendTx(db, "stripe:subscription.updated", async (_tx) => ({
          payload: { subscription, customerId },
        }));
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;
        await outboxClient.sendTx(db, "stripe:subscription.deleted", async (_tx) => ({
          payload: { subscription, customerId },
        }));
        break;
      }

      case "customer.subscription.paused": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;
        logger.info("Subscription paused", { subscriptionId: subscription.id });
        await outboxClient.sendTx(db, "stripe:subscription.paused", async (_tx) => ({
          payload: { subscription, customerId },
        }));
        break;
      }

      case "customer.subscription.resumed": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;
        logger.info("Subscription resumed", { subscriptionId: subscription.id });
        await outboxClient.sendTx(db, "stripe:subscription.resumed", async (_tx) => ({
          payload: { subscription, customerId },
        }));
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
        await outboxClient.sendTx(db, "stripe:checkout.session.completed", async (_tx) => ({
          payload: { session },
        }));
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          await outboxClient.sendTx(db, "stripe:invoice.paid", async (_tx) => ({
            payload: { invoice, customerId },
          }));
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          await outboxClient.sendTx(db, "stripe:invoice.payment_failed", async (_tx) => ({
            payload: { invoice, customerId },
          }));
        }
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
