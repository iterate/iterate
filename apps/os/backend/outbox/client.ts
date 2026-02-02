import type { appRouter } from "../trpc/root.ts";
import { waitUntil } from "../../env.ts";
import type { MachineType } from "../db/schema.ts";
import { type TrpcEventTypes, createConsumerClient } from "./pgmq-lib.ts";
import { queuer } from "./outbox-queuer.ts";

export type EstateBuilderWorkflowInput = {
  estateId: string;
  commitHash: string;
  commitMessage: string;
  repoUrl: string;
  installationToken: string;
  connectedRepoPath?: string;
  branch?: string;
  webhookId?: string;
  workflowRunId?: string;
  isManual?: boolean;
};

export type StripeEventTypes = {
  "stripe:subscription.created": { subscription: any; customerId: string };
  "stripe:subscription.updated": { subscription: any; customerId: string };
  "stripe:subscription.deleted": { subscription: any; customerId: string };
  "stripe:subscription.paused": { subscription: any; customerId: string };
  "stripe:subscription.resumed": { subscription: any; customerId: string };
  "stripe:invoice.paid": { invoice: any; customerId: string };
  "stripe:invoice.payment_failed": { invoice: any; customerId: string };
  "stripe:checkout.session.completed": { session: any };
};

export type SlackEventTypes = {
  "slack:event": { payload: Record<string, unknown>; teamId: string; slackEventId?: string };
  "slack:interactive": { payload: Record<string, unknown>; teamId: string };
};

export type ResendEventTypes = {
  "resend:email.received": { payload: Record<string, unknown>; resendEmailId: string };
};

export type MachineEventTypes = {
  "machine:created": {
    machineId: string;
    projectId: string;
    name: string;
    type: MachineType;
    metadata: Record<string, unknown>;
    externalId: string;
  };
  "machine:promoted": {
    promotedMachineId: string;
    projectId: string;
    archivedMachines: Array<{
      id: string;
      type: MachineType;
      externalId: string;
      metadata: Record<string, unknown>;
    }>;
  };
};

export type OAuthEventTypes = {
  "connection:github:created": { projectId: string };
  "connection:slack:created": { projectId: string };
  "connection:google:created": { projectId: string };
};

export type BillingEventTypes = {
  "billing:checkout:initiated": {
    organizationId: string;
    organizationSlug: string;
    userId: string;
    stripeCustomerId: string | null;
    checkoutSessionId: string;
  };
};

export type InternalEventTypes = {
  "testing:poke": { dbtime: string; message: string };
  "estate:build:created": EstateBuilderWorkflowInput & { buildId: string };
  "estate:created": { estateId: string };
};

type AppTrpcEventTypes = TrpcEventTypes<typeof appRouter>;

export const outboxClient = createConsumerClient<
  InternalEventTypes &
    AppTrpcEventTypes &
    StripeEventTypes &
    SlackEventTypes &
    ResendEventTypes &
    MachineEventTypes &
    OAuthEventTypes &
    BillingEventTypes,
  typeof queuer.$types.db
>(queuer, { waitUntil });
