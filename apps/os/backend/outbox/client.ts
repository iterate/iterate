import type Stripe from "stripe";
import type { appRouter } from "../trpc/root.ts";
import { waitUntil } from "../../env.ts";
import { type TrpcEventTypes, createConsumerClient } from "./pgmq-lib.ts";
import { queuer } from "./outbox-queuer.ts";

export type StripeWebhookEventTypes = {
  "stripe:customer.subscription.created": { subscription: Stripe.Subscription };
  "stripe:customer.subscription.updated": { subscription: Stripe.Subscription };
  "stripe:customer.subscription.deleted": { subscription: Stripe.Subscription };
  "stripe:customer.subscription.paused": { subscription: Stripe.Subscription };
  "stripe:customer.subscription.resumed": { subscription: Stripe.Subscription };
  "stripe:invoice.paid": { invoice: Stripe.Invoice };
  "stripe:invoice.payment_failed": { invoice: Stripe.Invoice };
  "stripe:checkout.session.completed": { session: Stripe.Checkout.Session };
};

export type SlackWebhookEventTypes = {
  "slack:webhook.received": { event: Record<string, unknown> };
  "slack:interactive.received": { event: Record<string, unknown> };
};

export type InternalEventTypes = {
  "testing:poke": { dbtime: string; message: string };
} & StripeWebhookEventTypes &
  SlackWebhookEventTypes;

type AppTrpcEventTypes = TrpcEventTypes<typeof appRouter>;

export const outboxClient = createConsumerClient<
  InternalEventTypes & AppTrpcEventTypes,
  typeof queuer.$types.db
>(queuer, { waitUntil });
