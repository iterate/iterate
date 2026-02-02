import { logger } from "../tag-logger.ts";
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handlePaymentFailed,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  handleSubscriptionUpdated,
} from "../integrations/stripe/stripe-outbox.ts";
import { outboxClient as cc } from "./client.ts";

export const registerConsumers = () => {
  registerTestConsumers();
  registerStripeConsumers();
};

function registerTestConsumers() {
  cc.registerConsumer({
    name: "logPoke",
    on: "testing:poke",
    handler: (params) => {
      logger.info("Outbox test event", {
        eventName: params.eventName,
        message: params.payload.message,
      });
      return `received message: ${params.payload.message}`;
    },
  });
}

function registerStripeConsumers() {
  cc.registerConsumer({
    name: "syncBillingAccountFromStripeSubscription",
    on: "stripe:customer.subscription.created",
    handler: async ({ payload }) => {
      await handleSubscriptionCreated(payload.subscription);
    },
  });

  cc.registerConsumer({
    name: "syncBillingAccountFromStripeSubscription",
    on: "stripe:customer.subscription.updated",
    handler: async ({ payload }) => {
      await handleSubscriptionUpdated(payload.subscription);
    },
  });

  cc.registerConsumer({
    name: "syncBillingAccountFromStripeSubscription",
    on: "stripe:customer.subscription.paused",
    handler: async ({ payload }) => {
      await handleSubscriptionUpdated(payload.subscription);
    },
  });

  cc.registerConsumer({
    name: "syncBillingAccountFromStripeSubscription",
    on: "stripe:customer.subscription.resumed",
    handler: async ({ payload }) => {
      await handleSubscriptionUpdated(payload.subscription);
    },
  });

  cc.registerConsumer({
    name: "clearBillingAccountStripeSubscription",
    on: "stripe:customer.subscription.deleted",
    handler: async ({ payload }) => {
      await handleSubscriptionDeleted(payload.subscription);
    },
  });

  cc.registerConsumer({
    name: "recordStripeInvoicePaid",
    on: "stripe:invoice.paid",
    handler: async ({ payload }) => {
      await handleInvoicePaid(payload.invoice);
    },
  });

  cc.registerConsumer({
    name: "recordStripeInvoicePaymentFailure",
    on: "stripe:invoice.payment_failed",
    handler: async ({ payload }) => {
      await handlePaymentFailed(payload.invoice);
    },
  });

  cc.registerConsumer({
    name: "logStripeCheckoutSessionCompletion",
    on: "stripe:checkout.session.completed",
    handler: async ({ payload }) => {
      await handleCheckoutSessionCompleted(payload.session);
    },
  });
}
