import type Stripe from "stripe";
import type { ResendEmailReceivedPayload } from "../integrations/resend/resend.ts";
import * as schema from "../db/schema.ts";

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

export type ResendWebhookEventTypes = {
  "resend:email.received": { event: ResendEmailReceivedPayload };
};

type MachineTypeValue = (typeof schema.MachineType)[number];

export type MachineLifecycleEventTypes = {
  "machine:created": {
    machineId: string;
    projectId: string;
    name: string;
    type: MachineTypeValue;
    providerMetadata: Record<string, unknown>;
    createdByUserId: string;
  };
  "machine:promoted": {
    projectId: string;
    promotedMachineId: string;
    archivedMachines: Array<{
      machineId: string;
      type: MachineTypeValue;
      externalId: string;
      metadata: Record<string, unknown>;
    }>;
  };
};

export type OAuthConnectionEventTypes = {
  "connection:github:created": {
    projectId: string;
    installationId: number;
    encryptedAccessToken: string;
  };
  "connection:slack:created": {
    projectId: string;
    teamId: string;
    teamName: string;
    teamDomain: string;
    encryptedAccessToken: string;
  };
  "connection:google:created": {
    projectId: string;
    userId: string;
    encryptedAccessToken: string;
    encryptedRefreshToken?: string;
    expiresAt?: string;
    scopes: string[];
  };
};

export type InternalEventTypes = {
  "testing:poke": { dbtime: string; message: string };
} & StripeWebhookEventTypes &
  SlackWebhookEventTypes &
  ResendWebhookEventTypes &
  MachineLifecycleEventTypes &
  OAuthConnectionEventTypes;
