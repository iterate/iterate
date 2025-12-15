import type { appRouter } from "../trpc/root.ts";
import { waitUntil } from "../../env.ts";
import { type TrpcEventTypes, createConsumerClient } from "./pgmq-lib.ts";
import { queuer } from "./outbox-queuer.ts";

export type InstallationBuilderWorkflowInput = {
  installationId: string;
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

export type InternalEventTypes = {
  "testing:poke": { dbtime: string; message: string };
  "installation:build:created": InstallationBuilderWorkflowInput & { buildId: string };
  "installation:created": { installationId: string };
};

type AppTrpcEventTypes = TrpcEventTypes<typeof appRouter>;

export const outboxClient = createConsumerClient<
  InternalEventTypes & AppTrpcEventTypes,
  typeof queuer.$types.db
>(queuer, { waitUntil });
