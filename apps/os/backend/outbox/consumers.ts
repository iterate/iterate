import { logger } from "../tag-logger.ts";
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handlePaymentFailed,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  handleSubscriptionUpdated,
} from "../integrations/stripe/stripe-outbox.ts";
import {
  handleSlackInteractiveEvent,
  handleSlackWebhookEvent,
} from "../integrations/slack/slack-outbox.ts";
import {
  handleGitHubConnectionCreated,
  handleGoogleConnectionCreated,
  handleSlackConnectionCreated,
} from "../integrations/oauth-outbox.ts";
import { handleResendEmailReceived } from "../integrations/resend/resend-outbox.ts";
import { handleMachineCreated, handleMachinePromoted } from "../machines/machine-outbox.ts";
import { handleBillingCheckoutInitiated } from "../billing/billing-outbox.ts";
import { handleUserCreated } from "../auth/auth-outbox.ts";
import { handleOrganizationCreated } from "../organizations/organization-outbox.ts";
import {
  handlePosthogEventCaptured,
  handlePosthogExceptionCaptured,
} from "../lib/posthog-outbox.ts";
import {
  handleOAuthTokenFailed,
  handleOAuthTokenRefreshed,
} from "../services/oauth-refresh-outbox.ts";
import { outboxClient as cc } from "./client.ts";

export const registerConsumers = () => {
  registerTestConsumers();
  registerStripeConsumers();
  registerSlackConsumers();
  registerResendConsumers();
  registerMachineConsumers();
  registerOAuthConsumers();
  registerBillingConsumers();
  registerUserConsumers();
  registerOrganizationConsumers();
  registerPosthogConsumers();
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

function registerSlackConsumers() {
  cc.registerConsumer({
    name: "forwardSlackWebhook",
    on: "slack:webhook.received",
    handler: async ({ payload }) => {
      await handleSlackWebhookEvent(payload.event);
    },
  });

  cc.registerConsumer({
    name: "forwardSlackInteractiveCallback",
    on: "slack:interactive.received",
    handler: async ({ payload }) => {
      await handleSlackInteractiveEvent(payload.event);
    },
  });
}

function registerResendConsumers() {
  cc.registerConsumer({
    name: "forwardResendInboundEmail",
    on: "resend:email.received",
    handler: async ({ payload }) => {
      await handleResendEmailReceived(payload.event);
    },
  });
}

function registerMachineConsumers() {
  cc.registerConsumer({
    name: "provisionMachine",
    on: "machine:created",
    handler: async ({ payload }) => {
      await handleMachineCreated(payload);
    },
  });

  cc.registerConsumer({
    name: "archiveOldMachines",
    on: "machine:promoted",
    handler: async ({ payload }) => {
      await handleMachinePromoted(payload);
    },
  });
}

function registerOAuthConsumers() {
  cc.registerConsumer({
    name: "provisionSlackConnectionSecrets",
    on: "connection:slack:created",
    handler: async ({ payload }) => {
      await handleSlackConnectionCreated(payload);
    },
  });

  cc.registerConsumer({
    name: "provisionGitHubConnectionSecrets",
    on: "connection:github:created",
    handler: async ({ payload }) => {
      await handleGitHubConnectionCreated(payload);
    },
  });

  cc.registerConsumer({
    name: "provisionGoogleConnectionSecrets",
    on: "connection:google:created",
    handler: async ({ payload }) => {
      await handleGoogleConnectionCreated(payload);
    },
  });

  cc.registerConsumer({
    name: "logOAuthTokenRefresh",
    on: "oauth:token:refreshed",
    handler: async ({ payload }) => {
      await handleOAuthTokenRefreshed(payload);
    },
  });

  cc.registerConsumer({
    name: "logOAuthTokenRefreshFailure",
    on: "oauth:token:failed",
    handler: async ({ payload }) => {
      await handleOAuthTokenFailed(payload);
    },
  });
}

function registerBillingConsumers() {
  cc.registerConsumer({
    name: "createBillingCheckoutSession",
    on: "billing:checkout:initiated",
    handler: async ({ payload, eventId }) => {
      await handleBillingCheckoutInitiated(payload, eventId);
    },
  });
}

function registerUserConsumers() {
  cc.registerConsumer({
    name: "trackUserSignup",
    on: "user:created",
    handler: async ({ payload }) => {
      await handleUserCreated(payload);
    },
  });
}

function registerOrganizationConsumers() {
  cc.registerConsumer({
    name: "provisionOrganizationDefaults",
    on: "organization:created",
    handler: async ({ payload }) => {
      await handleOrganizationCreated(payload);
    },
  });
}

function registerPosthogConsumers() {
  cc.registerConsumer({
    name: "capturePosthogEvent",
    on: "posthog:event.captured",
    handler: async ({ payload }) => {
      await handlePosthogEventCaptured(payload);
    },
  });

  cc.registerConsumer({
    name: "capturePosthogException",
    on: "posthog:exception.captured",
    handler: async ({ payload }) => {
      await handlePosthogExceptionCaptured(payload);
    },
  });
}
