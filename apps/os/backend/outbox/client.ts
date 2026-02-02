import type { appRouter } from "../trpc/root.ts";
import { waitUntil } from "../../env.ts";
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

export type InternalEventTypes = {
  "testing:poke": { dbtime: string; message: string };
  "estate:build:created": EstateBuilderWorkflowInput & { buildId: string };
  "estate:created": { estateId: string };
};

type AppTrpcEventTypes = TrpcEventTypes<typeof appRouter>;

export const outboxClient = createConsumerClient<
  InternalEventTypes & AppTrpcEventTypes & StripeEventTypes & SlackEventTypes & ResendEventTypes,
  typeof queuer.$types.db
>(queuer, { waitUntil });
